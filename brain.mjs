import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sanitizeOutboundText } from "./xhs-web.mjs";

export const EMPTY_SLOTS = {
  city: null,
  schedule: null,
  background: null,
  requirementFit: null,
  budget: null
};

const FORBIDDEN_REPLY_RE = /(?:加?\s*(?:微信|vx|v信|威信|徽信|薇信|绿泡泡|地球号)|加\s*[vV](?:$|[^a-zA-Z])|\b(?:whatsapp|telegram)\b|电报联系)/i;
const ROBOTIC_TONE_RE = /^(?:您好|你好呀我是|感谢您的|感谢咨询|非常理解|亲亲)|请问您/;
const MANUAL_ESCALATION_RE = /(?:真人吗|机器人|人机|自动回复|ai吗)/i;

export function detectManualEscalation(incomingText) {
  const text = String(incomingText || "").trim();
  if (!text) return "";
  if (MANUAL_ESCALATION_RE.test(text)) return "对方质疑人机身份";
  return "";
}

export function formatBeijingDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric"
  }).formatToParts(now);
  const pick = (t) => parts.find(p => p.type === t)?.value || "";
  return `${pick("year")}年${pick("month")}月${pick("day")}日`;
}

export function buildSystemPrompt(now = new Date(), extraContext = "", customPrompt = "") {
  const ctxBlock = extraContext ? `\n${extraContext}\n` : "";
  const todayStr = formatBeijingDate(now);
  const personaBlock = String(customPrompt || "").trim()
    ? String(customPrompt).trim().replace(/\{\{TODAY\}\}/g, todayStr)
    : `你正在小红书私信中回复来咨询的同好/合作候选人，目标是以自然、真诚的普通人聊天方式了解对方基本情况，筛选出【好沟通、时间与条件匹配、预算合适】的靠谱人选。

当前日期：今天是${todayStr}。

基础筛选原则（可在 promptFile 中替换为你的具体业务规则）：
- 循序渐进收集核心信息：所在城市、可用时间、相关背景/经验、是否符合需求、报价或预算预期。
- 绝不一次性抛出连环问题，先正面回应对方刚才的问题，再自然顺带最多 1 个待确认信息。
- 遇到超出常规规则的特殊方案或需要拍板的细节，先礼貌说明需要考虑一下，并将 status 设为 "manual" 转交人工处理。
- 仅在对方明显不礼貌或明确表示不合作时才礼貌收尾并设 status="rejected"；核心信息齐备且匹配度高时，不要当场承诺成交，留一句礼貌缓冲话（如“情况我都了解，我这边综合看下，合适的话尽快联系你”）并设 status="shortlisted" 交由人工拍板。`;

  return `${personaBlock}

沟通策略与风格（极其重要）：
1. 语气自然、随和、真诚，像普通用户私信闲聊，绝不审讯、不查户口、不生硬。句尾语气词（哈/呢/呀/啦等）克制使用。每次可拆成 1~2 条很短的消息放进 replies 数组慢慢说（例如 ["行", "你大概什么时间方便？"]），单条 2~32 字（绝不超 48 字）、绝不换行，整轮合起来最多只带 1 个问号。
2. 先答后问、张弛有度：对方有直接提问时先正面回应，再顺带最多 1 个待确认信息；已回答过的问题绝不重问，对方不愿透露的隐私细节立刻礼貌跳过。
3. 主页背调只作暗中参考：结合下方“主页背调”的 IP、简介与近期笔记综合判断匹配度与风险，异常情况悄悄记入 redFlags 和 note，严禁直接当面点破对方主页内容。
4. 报价归属严格区分：extracted.budget 只填对方主动报出或明确认可的价格/预算，严禁把我方单方试探价填进去。
5. 严禁客服腔（禁止“您好”“请问您”“感谢咨询”“非常理解”、编号列表）；严禁站外引流词（微信/VX/加V/绿泡泡/WhatsApp/Telegram 等）。
6. 若对方发来“[对方发来手机端专属消息或语音]”，自然回一句刚在电脑上看不太到，让对方打字说下情况；若发来“[笔记卡片: ...]”，结合卡片标题顺着聊。
${ctxBlock}
最终输出要求（必须严格遵守）：只输出以下结构的单个合法 JSON 对象，严禁直接输出裸对话句子，严禁附带任何额外解释：
{
  "replies": ["1~2条极短自然口语消息，简短回应和下一个问题尽量拆成两条"],
  "extracted": {
    "city": "字符串或null",
    "schedule": "可用时间/档期或null",
    "background": "身份/经验/背景信息或null",
    "requirementFit": "true/false或null",
    "budget": "仅对方报出或认可的报价/预算，否则null"
  },
  "mood": "对方当前沟通情绪，如：友善配合/谨慎观望/敷衍冷淡/急躁催单",
  "personality": "结合主页与聊天的沟通风格与靠谱度一句话评价",
  "longTermFit": "高 | 中 | 低",
  "redFlags": ["命中的风险点，没有则空数组"],
  "status": "chatting | shortlisted | manual | rejected",
  "note": "给运营者看的一句话中文总结"
}`;
}

export const SYSTEM_PROMPT = buildSystemPrompt();

// 出站机械安全守卫：拦截站外引流词、客服腔、超长句与连环发问
export function validateOutboundReply(rawReply, { minChars = 2, maxChars = 48 } = {}) {
  const clean = sanitizeOutboundText(rawReply);
  const len = Array.from(clean).length;
  if (len < minChars) return { ok: false, clean, reason: "回复为空或过短" };
  if (len > maxChars) return { ok: false, clean, reason: `字数超限(${len}字>${maxChars}字)` };
  if (FORBIDDEN_REPLY_RE.test(clean)) return { ok: false, clean, reason: "命中站外引流或平台风控词" };
  if (ROBOTIC_TONE_RE.test(clean)) return { ok: false, clean, reason: "命中生硬客服腔" };
  if ((clean.match(/[?？]/g) || []).length > 1) return { ok: false, clean, reason: "单条包含多个问号连问" };
  return { ok: true, clean, reason: "" };
}

function validateTurnReplies(replies, { isFirstOutbound = false } = {}) {
  if (!Array.isArray(replies) || replies.length === 0) {
    return { ok: false, cleanReplies: [], reason: "replies为空，必须至少回复1条自然短消息" };
  }
  const target = isFirstOutbound ? replies.slice(0, 1) : replies;
  const cleanReplies = [];
  let totalQuestions = 0;
  for (const raw of target) {
    const check = validateOutboundReply(raw);
    if (!check.ok) return { ok: false, cleanReplies: [], reason: check.reason };
    totalQuestions += (check.clean.match(/[?？]/g) || []).length;
    cleanReplies.push(check.clean);
  }
  if (totalQuestions > 1) return { ok: false, cleanReplies: [], reason: "本轮多条合计数超过1个问号连问" };
  return { ok: true, cleanReplies, reason: "" };
}

export function parseModelJson(rawText, { maxReplies = 1 } = {}) {
  const cleaned = String(rawText || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error(`模型输出不含合法 JSON: ${cleaned.slice(0, 200)}`);
    }
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  }
  const replies = Array.isArray(parsed.replies)
    ? parsed.replies.map(s => sanitizeOutboundText(s)).filter(Boolean).slice(0, Math.max(1, maxReplies))
    : [];
  const status = ["chatting", "shortlisted", "manual", "rejected"].includes(parsed.status)
    ? parsed.status
    : "chatting";
  const longTermFit = ["高", "中", "低"].includes(parsed.longTermFit)
    ? parsed.longTermFit
    : "中";
  return {
    replies,
    extracted: { ...EMPTY_SLOTS, ...(parsed.extracted || {}) },
    mood: String(parsed.mood || ""),
    personality: String(parsed.personality || ""),
    longTermFit,
    redFlags: Array.isArray(parsed.redFlags) ? parsed.redFlags.map(String) : [],
    status,
    note: String(parsed.note || "")
  };
}

export function mergeSlots(prevSlots, nextSlots) {
  const merged = { ...EMPTY_SLOTS, ...(prevSlots || {}) };
  for (const key of Object.keys(EMPTY_SLOTS)) {
    const val = nextSlots?.[key];
    if (val !== null && val !== undefined && val !== "") {
      merged[key] = val;
    }
  }
  return merged;
}

export function typingDelayMs(text, rand = Math.random) {
  const chars = Array.from(String(text || "")).length;
  const base = 1800 + Math.min(chars, 30) * 110;
  return Math.round(base + rand() * 1600);
}

export function computeSendDelayMs({ elapsedMs = 0, minTotalMs = 4500, maxTotalMs = 6500, rand = Math.random } = {}) {
  const targetMs = Math.round(minTotalMs + rand() * Math.max(0, maxTotalMs - minTotalMs));
  const remain = targetMs - elapsedMs;
  if (remain <= 0) return 0;
  return Math.min(remain, 4000);
}

export class MessageDebouncer {
  constructor({ minMs = 2500, maxMs = 3500, onFlush, rand = Math.random }) {
    this.minMs = minMs;
    this.maxMs = maxMs;
    this.onFlush = onFlush;
    this.rand = rand;
    this.buckets = new Map();
  }

  hasPending(userId) {
    return this.buckets.has(userId);
  }

  prepend(userId, texts, msgIds = []) {
    const addTexts = (Array.isArray(texts) ? texts : String(texts || "").split("\n"))
      .map(s => String(s).trim())
      .filter(Boolean);
    const addIds = (Array.isArray(msgIds) ? msgIds : []).map(String).filter(Boolean);
    const existing = this.buckets.get(userId);
    if (existing) {
      existing.texts = [...addTexts, ...existing.texts];
      existing.msgIds = [...addIds, ...existing.msgIds];
      return;
    }
    if (addTexts.length === 0) return;
    const now = Date.now();
    const entry = { texts: addTexts, msgIds: addIds, timer: null, lastAt: now };
    const waitMs = Math.round(this.minMs + this.rand() * Math.max(0, this.maxMs - this.minMs));
    entry.timer = setTimeout(async () => {
      this.buckets.delete(userId);
      const combined = entry.texts.filter(Boolean).join("\n");
      if (combined) await this.onFlush(userId, combined, { lastAt: entry.lastAt, msgIds: entry.msgIds });
    }, waitMs);
    this.buckets.set(userId, entry);
  }

  push(userId, text, msgId = "") {
    const now = Date.now();
    const entry = this.buckets.get(userId) || { texts: [], msgIds: [], timer: null, lastAt: now };
    entry.texts.push(String(text).trim());
    if (msgId) entry.msgIds.push(String(msgId));
    entry.lastAt = now;
    if (entry.timer) clearTimeout(entry.timer);
    const waitMs = Math.round(this.minMs + this.rand() * Math.max(0, this.maxMs - this.minMs));
    entry.timer = setTimeout(async () => {
      this.buckets.delete(userId);
      const combined = entry.texts.filter(Boolean).join("\n");
      if (combined) await this.onFlush(userId, combined, { lastAt: entry.lastAt, msgIds: entry.msgIds });
    }, waitMs);
    this.buckets.set(userId, entry);
  }

  clearAll() {
    for (const entry of this.buckets.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.buckets.clear();
  }

  clearUser(userId) {
    const entry = this.buckets.get(userId);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.buckets.delete(userId);
    return entry.msgIds || [];
  }
}

export async function loadStore(storePath) {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

// 原子写盘：先写同目录 .tmp 文件再 rename，避免中断导致 candidates.json 损坏
export async function saveStore(storePath, data) {
  const dir = path.dirname(storePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(storePath)}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmpPath, storePath);
}

let cachedSysProxy = { value: "", expiresAt: 0 };
export async function detectWindowsSystemProxy() {
  if (process.platform !== "win32") return "";
  if (Date.now() < cachedSysProxy.expiresAt) return cachedSysProxy.value;
  const value = await new Promise((resolve) => {
    execFile(
      "reg.exe",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
      { windowsHide: true, timeout: 2500 },
      (err, stdout = "") => {
        if (err) return resolve("");
        const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(stdout);
        if (!enabled) return resolve("");
        const m = stdout.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
        let srv = (m?.[1] || "").trim();
        if (!srv) return resolve("");
        if (srv.includes("=")) {
          const httpsPart = srv.split(";").find(s => s.startsWith("https=")) || srv.split(";")[0];
          srv = httpsPart.split("=")[1] || "";
        }
        if (!srv) return resolve("");
        resolve(/^https?:\/\//i.test(srv) ? srv : `http://${srv}`);
      }
    );
  });
  cachedSysProxy = { value, expiresAt: Date.now() + 60_000 };
  return value;
}

function isLoopbackUrl(url) {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(url);
}

// 默认通过 curl.exe 发送：天然支持 Windows 系统代理穿透、20s 硬超时，且通过 @hdrFile 隐藏 Bearer Key 不暴露于进程命令行
export async function callOpenAICompatible({
  apiBaseUrl,
  apiKey,
  model,
  messages,
  proxyUrl = "auto",
  timeoutMs = 20000,
  fetchImpl = null
}) {
  const url = `${apiBaseUrl.replace(/\/+$/, "")}/chat/completions`;
  const payload = JSON.stringify({ model, temperature: 0.6, messages });

  if (fetchImpl || process.platform !== "win32") {
    const fn = fetchImpl || fetch;
    const res = await fn(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: payload,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
    const body = await res.json();
    return body.choices?.[0]?.message?.content || "";
  }

  let effectiveProxy = "";
  if (!isLoopbackUrl(url) && proxyUrl !== "direct" && proxyUrl !== "none" && proxyUrl !== false) {
    effectiveProxy = proxyUrl && proxyUrl !== "auto" ? proxyUrl : await detectWindowsSystemProxy();
  }

  const id = crypto.randomUUID();
  const hdrFile = path.join(os.tmpdir(), `xhs-hdr-${id}.txt`);
  const reqFile = path.join(os.tmpdir(), `xhs-req-${id}.json`);
  const resFile = path.join(os.tmpdir(), `xhs-res-${id}.json`);
  const maxTimeSec = Math.max(5, Math.ceil(timeoutMs / 1000));

  await fs.writeFile(hdrFile, `content-type: application/json\nauthorization: Bearer ${apiKey}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.writeFile(reqFile, payload, "utf8");

  const args = ["-sS", "--max-time", String(maxTimeSec)];
  if (effectiveProxy) args.push("-x", effectiveProxy);
  args.push("-X", "POST", "-H", `@${hdrFile}`, "--data-binary", `@${reqFile}`, "-o", resFile, "-w", "%{http_code}", url);

  try {
    const statusCode = await new Promise((resolve, reject) => {
      execFile("curl.exe", args, { windowsHide: true, timeout: timeoutMs + 3000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`curl 调用失败: ${(stderr || err.message).trim()}`));
        resolve(String(stdout || "").trim());
      });
    });
    const rawRes = await fs.readFile(resFile, "utf8").catch(() => "");
    const codeNum = Number(statusCode);
    if (!(codeNum >= 200 && codeNum < 300)) {
      throw new Error(`LLM HTTP ${statusCode}: ${rawRes.slice(0, 300)}`);
    }
    const body = JSON.parse(rawRes);
    return body.choices?.[0]?.message?.content || "";
  } finally {
    await Promise.all([
      fs.rm(hdrFile, { force: true }).catch(() => {}),
      fs.rm(reqFile, { force: true }).catch(() => {}),
      fs.rm(resFile, { force: true }).catch(() => {})
    ]);
  }
}

export function formatMessagesForCodex(messages) {
  const roleLabel = { system: "系统设定", user: "对方", assistant: "我" };
  const sections = messages.map(m => `【${roleLabel[m.role] || m.role}】\n${m.content}`);
  sections.push("【执行约束】\n不要调用任何工具、不要读写文件或执行命令。严格按上述 JSON 结构直接输出最终结果，不要附带任何解释。");
  return sections.join("\n\n");
}

export async function callCodexExec({
  messages,
  codexBin = "codex",
  model = "",
  reasoningEffort = "low",
  timeoutMs = 90000,
  spawnImpl = spawn
}) {
  const outFile = path.join(os.tmpdir(), `xhs-codex-${crypto.randomUUID()}.txt`);
  const args = ["exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-o", outFile];
  if (reasoningEffort) args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
  if (model) args.push("-m", model);
  args.push("-");
  const prompt = formatMessagesForCodex(messages);

  try {
    const { code, stderr, stdout } = await new Promise((resolve, reject) => {
      const child = spawnImpl(codexBin, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      let settled = false;
      const finish = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(val);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish(reject, new Error(`codex exec 超时 (${timeoutMs}ms)`));
      }, timeoutMs);

      child.stdout?.on("data", chunk => { out += chunk.toString("utf8"); });
      child.stderr?.on("data", chunk => { err += chunk.toString("utf8"); });
      child.on("error", e => finish(reject, e));
      child.on("close", exitCode => finish(resolve, { code: exitCode, stdout: out, stderr: err }));
      child.stdin.end(prompt, "utf8");
    });

    if (code !== 0) {
      throw new Error(`codex exec 退出码 ${code}: ${(stderr || stdout).trim().slice(-400)}`);
    }
    const content = await fs.readFile(outFile, "utf8").then(s => s.trim()).catch(() => "");
    return content || stdout.trim();
  } finally {
    await fs.rm(outFile, { force: true }).catch(() => {});
  }
}

// 合并为单条 system 消息（兼容 Gemini OpenAI 接口与各类网关），并挂出站安全守卫（违规自动修正 1 次）
export async function handleIncoming({
  userId,
  nickname,
  profileSummary = "",
  incomingText,
  storePath,
  llmFn,
  maxReplies = 1,
  customPrompt = "",
  now = new Date()
}) {
  const store = await loadStore(storePath);
  const prevRecord = store[userId] ? structuredClone(store[userId]) : null;
  const record = store[userId] || {
    userId,
    nickname: nickname || userId,
    profileSummary,
    status: "chatting",
    slots: { ...EMPTY_SLOTS },
    mood: "",
    personality: "",
    longTermFit: "中",
    redFlags: [],
    note: "",
    history: []
  };
  if (!Array.isArray(record.history)) record.history = [];
  if (!Array.isArray(record.redFlags)) record.redFlags = [];
  if (!record.slots || typeof record.slots !== "object") record.slots = { ...EMPTY_SLOTS };
  if (profileSummary) record.profileSummary = profileSummary;
  record.history.push({ role: "user", content: incomingText, at: now.toISOString() });

  if (record.status !== "chatting") {
    store[userId] = record;
    await saveStore(storePath, store);
    return { skipped: true, reason: `status=${record.status}`, retriedReason: "", record, prevRecord, replies: [] };
  }

  const escalateReason = detectManualEscalation(incomingText);
  if (escalateReason) {
    record.status = "manual";
    record.note = (record.note ? `${record.note}；` : "") + `${escalateReason}，已转人工接管`;
    store[userId] = record;
    await saveStore(storePath, store);
    return { skipped: true, reason: `manual_escalate:${escalateReason}`, retriedReason: "", record, prevRecord, replies: [] };
  }

  const isFirstOutbound = !record.history.some(m => m.role === "assistant");
  const confirmedSlots = {};
  const missingSlots = [];
  for (const key of Object.keys(EMPTY_SLOTS)) {
    const val = record.slots?.[key];
    if (val !== null && val !== undefined && val !== "") confirmedSlots[key] = val;
    else missingSlots.push(key);
  }
  const firstTurnHint = isFirstOutbound
    ? "【首轮开场要求】这是你给对方的第 1 轮回复，请用 1 条完整自然的话开场（replies 数组只放 1 条），不超过 48 字、最多 1 个问号。结合主页背调与对方来意自然打招呼，并顺口确认 1 个最核心的前提问题，严禁当面点破对方主页内容。"
    : "";

  const contextPrompt =
    `【当前候选人档案】昵称=${record.nickname}；主页背调=${record.profileSummary || "暂无"}；` +
    `已确认槽位(严禁重复提问)=${JSON.stringify(confirmedSlots)}；待确认槽位=${JSON.stringify(missingSlots)}；` +
    `上次情绪=${record.mood || "未知"}；` +
    `性格印象=${record.personality || "待观察"}；已有风险点=${JSON.stringify(record.redFlags)}。` +
    firstTurnHint +
    `请结合历史聊天循序渐进推进，并将拟发的 ${isFirstOutbound ? "1 条完整开场消息" : `1~${maxReplies} 条极短自然口语消息`}填入下方 JSON 的 replies 数组中。`;

  const baseMessages = [
    { role: "system", content: buildSystemPrompt(now, contextPrompt, customPrompt) },
    ...record.history.slice(-16).map(m => ({ role: m.role, content: m.content }))
  ];

  const firstRaw = await llmFn(baseMessages);
  let result = null;
  let retryReason = "";
  let retriedReason = "";
  try {
    result = parseModelJson(firstRaw, { maxReplies });
    const turnCheck = validateTurnReplies(result.replies, { isFirstOutbound });
    if (!turnCheck.ok) retryReason = turnCheck.reason;
    else result.replies = turnCheck.cleanReplies;
  } catch (err) {
    retryReason = err.message;
  }

  if (retryReason) {
    retriedReason = retryReason;
    const isJsonMissing = retryReason.startsWith("模型输出不含合法 JSON");
    const retryDirective = isJsonMissing
      ? "【系统修正指令：你刚才写的回复内容本身合理，只是缺少 JSON 格式外壳导致程序无法解析。请务必完整保留你刚才那句回复的核心意思（不要丢掉对对方问题的直接回答），把它放进 replies 数组（可按自然停顿拆成1~2条极短消息），严格只输出合法的单个 JSON 对象，单条不超过48字、总问号最多1个】"
      : `【系统修正指令：上一条输出未通过校验（${retryReason}）。请严格只输出合法 JSON 对象，且 replies 为自然简短口语消息、无站外引流词与客服腔、总问号最多1个】`;
    const retryMessages = [
      ...baseMessages,
      { role: "assistant", content: String(firstRaw || "").slice(0, 1200) },
      { role: "user", content: retryDirective }
    ];
    let secondErr = "";
    let secondCheck = { ok: false, cleanReplies: [], reason: "重试为空" };
    try {
      result = parseModelJson(await llmFn(retryMessages), { maxReplies });
      secondCheck = result.replies.length > 0
        ? validateTurnReplies(result.replies, { isFirstOutbound })
        : { ok: false, cleanReplies: [], reason: "重试为空" };
    } catch (err) {
      secondErr = err.message;
    }
    if (secondErr || !secondCheck.ok) {
      const blockReason = secondErr || secondCheck.reason;
      record.status = "manual";
      record.note = (record.note ? `${record.note}；` : "") + `出站守卫二次拦截(${blockReason})，已转人工`;
      store[userId] = record;
      await saveStore(storePath, store);
      return { skipped: true, reason: `guard_blocked:${blockReason}`, retriedReason, record, prevRecord, replies: [] };
    }
    result.replies = secondCheck.cleanReplies;
  }

  record.slots = mergeSlots(record.slots, result.extracted);
  if (result.mood) record.mood = result.mood;
  if (result.personality) record.personality = result.personality;
  if (result.longTermFit) record.longTermFit = result.longTermFit;
  record.redFlags = [...new Set([...record.redFlags, ...result.redFlags])];
  record.status = result.status;
  if (result.note) record.note = result.note;
  if (result.replies.length > 0) {
    record.history.push({ role: "assistant", content: result.replies.join("\n"), at: now.toISOString() });
  }

  store[userId] = record;
  await saveStore(storePath, store);
  return { skipped: false, retriedReason, record, prevRecord, replies: result.replies };
}
