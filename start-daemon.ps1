param(
  [switch]$DryRun,
  [switch]$ResetNodeService
)

$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

$dir = $PSScriptRoot
$logFile = Join-Path $dir "daemon.log"
$errFile = Join-Path $dir "daemon.err.log"
$lockFile = Join-Path $dir "daemon.lock"
$entryFile = Join-Path $dir ".daemon-entry.mjs"
$daemonFile = Join-Path $dir "daemon.mjs"

$egoExe = (Get-ChildItem "$env:LOCALAPPDATA\Citro Labs\ego lite\Application\*\ego-browser.exe" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
if (-not $egoExe) { throw "未找到 ego-browser.exe，请确认已安装 ego lite" }

$codexCmd = Get-Command codex -ErrorAction SilentlyContinue
$codexExe = if ($codexCmd) { $codexCmd.Source } else {
  (Get-ChildItem "$env:LOCALAPPDATA\OpenAI\Codex\bin\*\codex.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}
$codexJs = if ($codexExe) { $codexExe.Replace('\', '\\') } else { "codex" }
$logJs = $logFile.Replace('\', '\\')

# 停止旧的 xhs-dm-agent 客户端进程；默认靠 daemon.lock 令牌让旧循环 1.5s 内平滑自退，仅在指定 -ResetNodeService 时才强杀共享 NodeService
Get-CimInstance Win32_Process -Filter "Name='ego-browser.exe'" |
  Where-Object { $_.CommandLine -match ([regex]::Escape($dir.Replace('\', '/')) + '/(\.daemon-entry|daemon)\.mjs') } |
  ForEach-Object {
    Write-Host "[LAUNCHER] 停止旧客户端进程 PID=$($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

$otherEgoProcs = @(Get-CimInstance Win32_Process -Filter "Name='ego-browser.exe'" |
  Where-Object { $_.CommandLine -notmatch ([regex]::Escape($dir.Replace('\', '/')) + '/(\.daemon-entry|daemon)\.mjs') })
$shouldResetNodeService = $ResetNodeService -or ($otherEgoProcs.Count -eq 0)

if ($shouldResetNodeService) {
  Get-CimInstance Win32_Process -Filter "Name='ego.exe'" |
    Where-Object { $_.CommandLine -match 'ego\.mojom\.NodeService' } |
    ForEach-Object {
      Write-Host "[LAUNCHER] 重置 NodeService PID=$($_.ProcessId)"
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  Start-Sleep -Milliseconds 600
} else {
  Write-Host "[LAUNCHER] 检测到其他 ego-browser.exe 正在运行，跳过重置 NodeService（如需强刷子模块缓存请传 -ResetNodeService）" -ForegroundColor Yellow
}

[System.IO.File]::WriteAllText($logFile, "", $utf8NoBom)
[System.IO.File]::WriteAllText($errFile, "", $utf8NoBom)

$ver = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$dryFlag = if ($DryRun) { "true" } else { "false" }
$daemonUrl = [System.Uri]::new($daemonFile).AbsoluteUri + "?v=$ver"
$entryUrl = [System.Uri]::new($entryFile).AbsoluteUri + "?v=$ver"
$entryJs = @"
import fs from "node:fs/promises";
const logFile = "$logJs";
try {
  const { runDaemon } = await import("$daemonUrl");
  await runDaemon({ dryRun: $dryFlag, codexBin: "$codexJs" });
} catch (err) {
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const msg = "[" + ts + "] [FATAL] 守护进程启动失败: " + (err?.stack || err?.message || err) + "\n";
  console.error(msg);
  await fs.appendFile(logFile, msg, "utf8").catch(() => {});
  process.exit(1);
}
"@
[System.IO.File]::WriteAllText($entryFile, $entryJs, $utf8NoBom)

$proc = Start-Process -FilePath $egoExe -ArgumentList "nodejs -e `"await import('$entryUrl')`"" -WindowStyle Hidden -RedirectStandardError $errFile -PassThru
Write-Host "[LAUNCHER] xhs-dm-agent 已启动 (PID=$($proc.Id), dryRun=$dryFlag)，正在追踪 daemon.log (按 Ctrl+C 停止)..."

Start-Sleep -Milliseconds 500
if ($proc.HasExited -and $proc.ExitCode -ne 0) {
  Write-Host "[LAUNCHER] 守护进程启动失败并已退出 (ExitCode=$($proc.ExitCode))：" -ForegroundColor Red
  if (Test-Path -LiteralPath $errFile) {
    Get-Content -LiteralPath $errFile -Encoding UTF8
  }
  exit $proc.ExitCode
}

try {
  Get-Content -Path $logFile -Wait -Encoding UTF8
} finally {
  Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
  if ($proc -and -not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  }
}
