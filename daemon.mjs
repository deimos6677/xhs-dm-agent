import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MessageDebouncer,
  callCodexExec,
  callOpenAICompatible,
  computeSendDelayMs,
  handleIncoming,
  loadStore,
  saveStore
} from "./brain.mjs";
import {
  TEMP_MSG_ID_RE,
  openConversationVerified,
  readChatSnapshot,
  sendMessageVerified
} from "./xhs-web.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(__dirname, "config.json");
const DEFAULT_STORE_PATH = path.join(__dirname, "candidates.json");
const DEFAULT_SUMMARY_PATH = path.join(__dirname, "candidates-summary.md");
const DEFAULT_LOCK_PATH = path.join(__dirname, "daemon.lock");
const DEFAULT_LOG_PATH = path.join(__dirname, "daemon.log");
export const DRY_RUN_RESET_RE = /^\/new(?:\s+([\s\S]*))?$/i;

export function applyDryRunReset(freshOther, messages, record) {
  let lastResetIdx = -1;
  let trailingText = "";
  for (let i = 0; i < freshOther.length; i++) {
    const match = String(freshOther[i]?.text || "").trim().match(DRY_RUN_RESET_RE);
    if (match) {
      lastResetIdx = i;
      trailingText = (match[1] || "").trim();
    }
  }
  if (lastResetIdx < 0) return { triggered: false, freshOther };

  const triggerMsg = freshOther[lastResetIdx];
  const domIdx = messages.findIndex(m => m.msgId === triggerMsg.msgId);
  const cutoff = domIdx >= 0 ? (trailingText ? domIdx : domIdx + 1) : messages.length;
  const settledIds = messages.slice(0, cutoff).map(m => m.msgId).filter(Boolean);
  const nextSeen = [...new Set([...(record.seenMsgIds || []), ...settledIds])];
  if (!trailingText && triggerMsg.msgId && !nextSeen.includes(triggerMsg.msgId)) {
    nextSeen.push(triggerMsg.msgId);
  }

  record.status = "chatting";
  record.slots = {};
  record.redFlags = [];
  record.note = "";
  record.history = [];
  record.seenMsgIds = nextSeen;
  record.botSentIds = [];
  record.botTempIds = [];
  record.botSentTexts = [];
  record.profileChecked = false;
  record.profileSummary = "";
  record.platformLimited = false;
  delete record.mood;
  delete record.personality;
  delete record.longTermFit;

  const remaining = [];
  if (trailingText) remaining.push({ ...triggerMsg, text: trailingText });
  for (let i = lastResetIdx + 1; i < freshOther.length; i++) {
    remaining.push(freshOther[i]);
  }
  return { triggered: true, freshOther: remaining };
}

// 检测新增的对方消息以及是否被人类接管（自己发了脚本没发过的消息）
export function diffMessages(domItems, record = {}) {
  const seenIds = new Set(record.seenMsgIds || []);
  const botSentIds = new Set([...(record.botSentIds || []), ...(record.botTempIds || [])]);
  const botSentTexts = new Set(
    [
      ...(record.botSentTexts || []),
      ...(record.history || []).filter(m => m.role === "assistant").flatMap(m => String(m.content || "").split("\n"))
    ].map(s => s.trim()).filter(Boolean)
  );
  const newOther = [];
  let humanTookOver = false;

  for (const item of domItems) {
    if (!item.msgId) continue;
    const isSelf = item.isSelf !== undefined ? Boolean(item.isSelf) : !item.isOther;
    if (item.isOther) {
      if (!seenIds.has(item.msgId)) {
        newOther.push(item);
      }
    } else if (isSelf && seenIds.size > 0 && !seenIds.has(item.msgId) && !botSentIds.has(item.msgId)) {
      const text = String(item.text || "").trim();
      if (TEMP_MSG_ID_RE.test(item.msgId) || (text && botSentTexts.has(text))) {
        continue;
      }
      humanTookOver = true;
    }
  }
  return { newOther, humanTookOver };
}

// 首次接管已有历史消息的会话时，以最后一条己方消息为界：此前的双向对话导入 history 并标已读，仅保留此后未回的对方消息触发回复
export function seedHistoryFromDom(messages, record) {
  if ((record.seenMsgIds || []).length > 0 || messages.length === 0) return false;
  let lastSelfIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const isSelf = m.isSelf !== undefined ? Boolean(m.isSelf) : !m.isOther;
    if (isSelf) {
      lastSelfIdx = i;
      break;
    }
  }
  if (lastSelfIdx < 0) return false;
  const settled = messages.slice(0, lastSelfIdx + 1);
  record.seenMsgIds = settled.map(m => m.msgId).filter(Boolean);
  if (!record.history || record.history.length === 0) {
    const nowIso = new Date().toISOString();
    record.history = settled
      .filter(m => String(m.text || "").trim())
      .slice(-16)
      .map(m => ({ role: m.isOther ? "user" : "assistant", content: String(m.text).trim(), at: nowIso }));
  }
  return lastSelfIdx === messages.length - 1;
}

export function renderSummaryMarkdown(store) {
  const groups = { shortlisted: [], chatting: [], manual: [], rejected: [] };
  for (const rec of Object.values(store)) {
    const key = groups[rec.status] ? rec.status : "chatting";
    groups[key].push(rec);
  }
  const fmt = (rec) => {
    const s = rec.slots || {};
    const info = [
      s.city && `城市:${s.city}`,
      s.schedule && `时间:${s.schedule}`,
      s.background && `背景:${s.background}`,
      s.requirementFit !== null && s.requirementFit !== undefined && `匹配:${s.requirementFit}`,
      s.budget && `报价:${s.budget}`,
      rec.mood && `情绪:${rec.mood}`,
      rec.longTermFit && `长期:${rec.longTermFit}`,
      rec.platformLimited && "状态:待对方回关/回复后解锁"
    ].filter(Boolean).join(" | ");
    const persona = rec.personality ? ` | 性格:${rec.personality}` : "";
    const flags = rec.redFlags?.length ? ` | 风险:${rec.redFlags.join(",")}` : "";
    return `- **${rec.nickname}** (\`${rec.userId}\`): ${info || "信息待补"}${persona}${flags}${rec.note ? ` — ${rec.note}` : ""}`;
  };
  const section = (title, list) =>
    `## ${title} (${list.length})\n${list.length ? list.map(fmt).join("\n") : "- 暂无"}\n`;
  return [
    "# 小红书私信筛选进度",
    `_更新时间: ${new Date().toLocaleString("zh-CN")}_`,
    "",
    section("待拍板（达标）", groups.shortlisted),
    section("自动沟通中", groups.chatting),
    section("已人工接管", groups.manual),
    section("已淘汰", groups.rejected)
  ].join("\n");
}

// 单次轻背调：每个候选人只拉取 1 次同源主页，防止无简介账号每轮重刷触发 300012 滑块风控
async function fetchProfileSummaryOnce(page, userId) {
  try {
    return await page.evaluate(async (uid) => {
      const res = await fetch("/user/profile/" + encodeURIComponent(uid), { credentials: "include" });
      if (!res.ok) return "";
      const html = await res.text();
      const match = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})<\/script>/);
      if (!match) return "";
      const st = JSON.parse(match[1].replace(/\bundefined\b/g, "null"));
      const basic = st?.user?.userPageData?.basicInfo || {};
      const tags = (st?.user?.userPageData?.tags || []).map(t => t?.name).filter(Boolean).slice(0, 4);
      const notes = (st?.user?.notes?.[0] || []).slice(0, 6).map(n => n?.noteCard?.displayTitle?.trim()).filter(Boolean);
      const parts = [];
      if (basic.ipLocation) parts.push(`IP:${basic.ipLocation}`);
      if (basic.desc && basic.desc !== "还没有简介") parts.push(`简介:${basic.desc.replace(/\s+/g, " ").slice(0, 60)}`);
      if (tags.length) parts.push(`标签:${tags.join("/")}`);
      if (notes.length) parts.push(`近期笔记:${notes.join(" / ").slice(0, 120)}`);
      return parts.join(" | ");
    }, userId);
  } catch {
    return "";
  }
}

export function collectTargetConvs({ convs = [], activeUserId = null, headerName = "", lastSummaryByUser = new Map(), initialized = false, retryUsers = null }) {
  const targets = new Map();
  for (const conv of convs) {
    const prevSummary = lastSummaryByUser.get(conv.userId);
    const summaryChanged = initialized && prevSummary !== undefined && conv.summary && conv.summary !== prevSummary;
    if (conv.unread > 0 || conv.hasUnreadDot || summaryChanged) {
      targets.set(conv.userId, conv.nickname || conv.userId);
    }
    if (conv.summary !== undefined) {
      lastSummaryByUser.set(conv.userId, conv.summary);
    }
  }
  if (activeUserId) {
    const activeMeta = convs.find(c => c.userId === activeUserId);
    targets.set(activeUserId, activeMeta?.nickname || headerName || activeUserId);
  }
  if (retryUsers) {
    for (const uid of retryUsers) {
      if (!targets.has(uid)) {
        const retryMeta = convs.find(c => c.userId === uid);
        targets.set(uid, retryMeta?.nickname || uid);
      }
    }
  }
  return targets;
}

export async function claimInstanceLock(lockPath, instanceId = crypto.randomUUID()) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, instanceId, "utf8");
  return instanceId;
}

export async function isInstanceOwner(lockPath, instanceId) {
  try {
    return (await fs.readFile(lockPath, "utf8")).trim() === instanceId;
  } catch {
    return false;
  }
}

// 发送前中断回滚：恢复候选人原状态并退回未发出的 seenMsgIds，让新旧消息在下一轮自然合并重算
export async function rollbackAbortedTurn(storePath, userId, prevRecord, batchMsgIds = []) {
  const store = await loadStore(storePath);
  const current = store[userId];
  if (!current) return;
  const dropIds = new Set(batchMsgIds);
  if (prevRecord) {
    prevRecord.seenMsgIds = (current.seenMsgIds || []).filter(id => !dropIds.has(id));
    store[userId] = prevRecord;
  } else {
    current.history = [];
    current.status = "chatting";
    current.seenMsgIds = (current.seenMsgIds || []).filter(id => !dropIds.has(id));
    store[userId] = current;
  }
  await saveStore(storePath, store);
}

// 硬性隔离日常 Profile 1，仅连接或创建独立自动化 Profile 的专属空间并直达私信页
export async function attachChatPage(
  { spaceId = null, profileId = "Profile 2", spaceName = "xhs-dm-agent", excludeSpaceNames = [] } = {},
  runtime = globalThis
) {
  if (profileId === "Profile 1") {
    throw new Error("安全红线拦截：禁止在日常 Profile 1 运行自动化，请使用独立的自动化 Profile（如 Profile 2）");
  }
  const excluded = new Set(Array.isArray(excludeSpaceNames) ? excludeSpaceNames : []);
  let space;
  if (typeof runtime.listTaskSpaces === "function") {
    const allSpaces = await runtime.listTaskSpaces();
    const exactById = spaceId != null ? allSpaces.find(s => s.id === spaceId) : null;
    if (exactById && exactById.profileId === "Profile 1") {
      throw new Error(`spaceId=${spaceId} 属于日常 Profile 1，已拒绝连接`);
    }
    const eligibleSpaces = allSpaces.filter(s => s.profileId === profileId && !excluded.has(s.name));
    const entry =
      (exactById?.profileId === profileId && !excluded.has(exactById?.name) ? exactById : null) ||
      eligibleSpaces.find(s => s.name === spaceName) ||
      eligibleSpaces.find(s => (s.recentTabTitles || []).some(t => /小红书|私信|chat/i.test(t)));

    if (!entry) {
      space = await runtime.taskSpace(spaceName, { profileId });
    } else if (entry.ownership === "user" && typeof runtime.claimTaskSpace === "function") {
      space = await runtime.claimTaskSpace(entry.id);
    } else if (entry.ownership === "agentDelegatedToUser" && typeof runtime.takeOverTaskSpace === "function") {
      space = await runtime.takeOverTaskSpace(entry.id);
    } else {
      space = await runtime.taskSpace(entry.id);
    }
  } else {
    space = await runtime.taskSpace(spaceName, { profileId });
  }

  let page = null;
  if (typeof space.tabs === "function") {
    const tabs = await space.tabs();
    const target =
      tabs.find(t => /xiaohongshu\.com\/chat/i.test(t.url || "")) ||
      tabs.find(t => /xiaohongshu\.com/i.test(t.url || "")) ||
      tabs.find(t => t.active) ||
      tabs[0];
    if (target) {
      page = target.label ? space.page(target.label) : await space.adopt(target.page);
    }
  }
  if (!page) page = space.page("p1");

  if (typeof page.url === "function" && typeof page.goto === "function") {
    const curUrl = await page.url().catch(() => "");
    if (!/xiaohongshu\.com\/chat/i.test(curUrl)) {
      await page.goto("https://www.xiaohongshu.com/chat");
    }
  }
  return page;
}

function createLogger(logPath) {
  return (msg, isError = false) => {
    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const line = `[${ts}] ${msg}`;
    if (isError) console.error(line);
    fs.appendFile(logPath, `${line}\n`, "utf8").catch(() => {});
  };
}

async function syncSummary(storePath, summaryPath) {
  const store = await loadStore(storePath);
  await fs.writeFile(summaryPath, renderSummaryMarkdown(store), "utf8");
}

export function resolveRuntimeConfig(rawCfg = {}, env = process.env) {
  const hasRealKey = Boolean(rawCfg.apiKey && rawCfg.apiKey !== "REPLACE_WITH_YOUR_API_KEY");
  const provider = rawCfg.provider || (hasRealKey ? "openai" : "codex");
  return {
    provider,
    codexBin: rawCfg.codexBin || env.XHS_CODEX_BIN || "codex",
    model: rawCfg.model || "",
    reasoningEffort: rawCfg.reasoningEffort ?? "low",
    apiBaseUrl: rawCfg.apiBaseUrl || "",
    apiKey: rawCfg.apiKey || "",
    proxyUrl: rawCfg.proxyUrl ?? "auto",
    pollIntervalMs: rawCfg.pollIntervalMs ?? 1500,
    debounceMinMs: rawCfg.debounceMinMs ?? 2500,
    debounceMaxMs: rawCfg.debounceMaxMs ?? 3500,
    maxRepliesPerTurn: rawCfg.maxRepliesPerTurn ?? 2,
    spaceId: rawCfg.spaceId ?? null,
    spaceName: rawCfg.spaceName || "xhs-dm-agent",
    excludeSpaceNames: Array.isArray(rawCfg.excludeSpaceNames) ? rawCfg.excludeSpaceNames : [],
    profileId: rawCfg.profileId || "Profile 2",
    promptFile: rawCfg.promptFile || ""
  };
}

export async function runDaemon({
  configPath = DEFAULT_CONFIG_PATH,
  storePath = DEFAULT_STORE_PATH,
  summaryPath = DEFAULT_SUMMARY_PATH,
  lockPath = DEFAULT_LOCK_PATH,
  logPath = DEFAULT_LOG_PATH,
  dryRun = false,
  codexBin = ""
} = {}) {
  if (dryRun && storePath === DEFAULT_STORE_PATH) {
    storePath = path.join(__dirname, "candidates.dryrun.json");
  }
  if (dryRun && summaryPath === DEFAULT_SUMMARY_PATH) {
    summaryPath = path.join(__dirname, "candidates-summary.dryrun.md");
  }
  const instanceId = await claimInstanceLock(lockPath);
  const log = createLogger(logPath);
  let rawCfg = {};
  try {
    rawCfg = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`配置文件 ${configPath} 无法解析: ${err.message}`);
    }
  }
  const cfg = resolveRuntimeConfig(codexBin ? { ...rawCfg, codexBin } : rawCfg);
  if (!dryRun && cfg.provider === "openai" && (!cfg.apiKey || cfg.apiKey === "REPLACE_WITH_YOUR_API_KEY")) {
    throw new Error(`openai 模式下请先在 ${configPath} 填入真实的 apiKey`);
  }

  let customPrompt = "";
  if (cfg.promptFile) {
    const resolvedPromptPath = path.isAbsolute(cfg.promptFile)
      ? cfg.promptFile
      : path.join(path.dirname(configPath), cfg.promptFile);
    customPrompt = await fs.readFile(resolvedPromptPath, "utf8");
  }

  log(`[BOOT] 正在连接浏览器 (${cfg.profileId}) 并检查小红书私信页...`);
  let page = await attachChatPage({
    spaceId: cfg.spaceId,
    profileId: cfg.profileId,
    spaceName: cfg.spaceName,
    excludeSpaceNames: cfg.excludeSpaceNames
  });
  const pendingUsers = new Map();
  const queuedMsgIds = new Set();
  const retryUsers = new Set();
  const lastSummaryByUser = new Map();
  let summaryInitialized = false;
  let busy = false;
  let blockedAlerted = false;

  const debouncer = new MessageDebouncer({
    minMs: cfg.debounceMinMs ?? 2500,
    maxMs: cfg.debounceMaxMs ?? 3500,
    onFlush: async (userId, combinedText, meta = {}) => {
      const batchMsgIds = meta.msgIds || [];
      while (busy) await new Promise(r => setTimeout(r, 300));
      if (!(await isInstanceOwner(lockPath, instanceId))) {
        for (const id of batchMsgIds) queuedMsgIds.delete(id);
        return;
      }
      if (debouncer.hasPending(userId)) {
        debouncer.prepend(userId, combinedText, batchMsgIds);
        return;
      }
      busy = true;
      let res = null;
      const settleSeen = async () => {
        const st = await loadStore(storePath);
        if (st[userId]) {
          st[userId].profileChecked = true;
          st[userId].seenMsgIds = [...new Set([...(st[userId].seenMsgIds || []), ...batchMsgIds])];
          if (st[userId].platformLimited) st[userId].platformLimited = false;
          await saveStore(storePath, st);
        }
      };
      try {
        const nickname = pendingUsers.get(userId) || userId;
        const receivedAt = meta.lastAt || Date.now();

        const storeBefore = await loadStore(storePath);
        let profileSummary = storeBefore[userId]?.profileSummary || "";
        if (!storeBefore[userId]?.profileChecked) {
          profileSummary = await fetchProfileSummaryOnce(page, userId);
          if (storeBefore[userId]) {
            storeBefore[userId].profileChecked = true;
            if (profileSummary) storeBefore[userId].profileSummary = profileSummary;
            await saveStore(storePath, storeBefore);
          }
          if (profileSummary) log(`[PROFILE] ${nickname}: ${profileSummary}`);
        }

        const hasOpenAIKey = Boolean(cfg.apiKey && cfg.apiKey !== "REPLACE_WITH_YOUR_API_KEY");
        const llmFn = cfg.provider === "openai"
          ? (hasOpenAIKey
              ? (messages) => callOpenAICompatible({
                  apiBaseUrl: cfg.apiBaseUrl,
                  apiKey: cfg.apiKey,
                  model: cfg.model,
                  proxyUrl: cfg.proxyUrl,
                  messages
                })
              : async () => JSON.stringify({
                  replies: ["哈喽，方便说下你这边的城市和大概时间吗"],
                  extracted: {},
                  mood: "友善配合",
                  personality: "试跑",
                  longTermFit: "中",
                  redFlags: [],
                  status: "chatting",
                  note: "dry-run-mock"
                }))
          : (messages) => callCodexExec({
              messages,
              codexBin: cfg.codexBin,
              model: cfg.model,
              reasoningEffort: cfg.reasoningEffort
            });

        res = await handleIncoming({
          userId,
          nickname,
          profileSummary,
          incomingText: combinedText,
          storePath,
          llmFn,
          maxReplies: cfg.maxRepliesPerTurn,
          customPrompt
        });
        if (res.retriedReason) {
          log(`[GUARD_RETRY] ${nickname}: 首次校验未通过(${res.retriedReason})，已自动重写`);
        }
        if (res.skipped || res.replies.length === 0) {
          if (String(res.reason || "").startsWith("guard_blocked:")) {
            log(`[GUARD_BLOCKED] ${nickname}: ${res.reason}，已转人工接管`, true);
          } else if (String(res.reason || "").startsWith("manual_escalate:")) {
            log(`[MANUAL] ${nickname}: ${res.reason}，已转人工接管`, true);
          } else {
            log(`[SKIP] ${nickname}: ${res.reason || "无回复"}`);
          }
          await settleSeen();
          await syncSummary(storePath, summaryPath);
          return;
        }
        if (dryRun) {
          for (let i = 0; i < res.replies.length; i++) {
            if (i > 0) await new Promise(r => setTimeout(r, 2000 + Math.round(Math.random() * 2000)));
            log(`[DRY-RUN] 拟回复 ${nickname}: ${res.replies[i]}`);
          }
          if (res.record?.status === "manual") {
            log(`[DRY-RUN] [MANUAL] ${nickname} 已转人工接管（${res.record.note || "需人工处理"}）`);
          }
          await settleSeen();
          await syncSummary(storePath, summaryPath);
          return;
        }

        // 先完成拟人思考停顿，再切会话并做原子复核，把防串台暴露窗口缩到最小
        const delayMs = computeSendDelayMs({ elapsedMs: Date.now() - receivedAt });
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        if (!(await isInstanceOwner(lockPath, instanceId))) {
          await rollbackAbortedTurn(storePath, userId, res.prevRecord, batchMsgIds);
          return;
        }
        if (debouncer.hasPending(userId)) {
          await rollbackAbortedTurn(storePath, userId, res.prevRecord, batchMsgIds);
          debouncer.prepend(userId, combinedText, batchMsgIds);
          return;
        }

        if (!(await openConversationVerified(page, userId))) {
          log(`[WARN] 未能切到会话 ${nickname} (${userId})，回滚留待下轮重试`, true);
          await rollbackAbortedTurn(storePath, userId, res.prevRecord, batchMsgIds);
          retryUsers.add(userId);
          return;
        }

        const latestSnap = await readChatSnapshot(page);
        const currentStore = await loadStore(storePath);
        const preSeenSet = new Set(res.prevRecord?.seenMsgIds || currentStore[userId]?.seenMsgIds || []);
        const batchSet = new Set(batchMsgIds);
        const arrivedDuringThink = latestSnap.messages.filter(
          m => m.isOther && m.msgId && !preSeenSet.has(m.msgId) && !batchSet.has(m.msgId)
        );
        if (arrivedDuringThink.length > 0) {
          log(`[STALE] ${nickname} 在思考期间新增 ${arrivedDuringThink.length} 条消息，回滚合并重算`);
          await rollbackAbortedTurn(storePath, userId, res.prevRecord, batchMsgIds);
          retryUsers.add(userId);
          return;
        }

        const reply = res.replies[0];
        let baselineMsgIds = latestSnap.messages.map(m => m.msgId);
        const knownOtherIds = [...new Set([...preSeenSet, ...batchMsgIds])];
        const sentTextsThisTurn = [];
        const sentIdsAll = [];
        const tempIdsAll = [];
        let finalOutcome = null;

        for (let i = 0; i < res.replies.length; i++) {
          if (i > 0) {
            await new Promise(r => setTimeout(r, 2000 + Math.round(Math.random() * 2000)));
            if (!(await isInstanceOwner(lockPath, instanceId))) break;
          }
          const outcome = await sendMessageVerified(page, {
            expectedUserId: userId,
            text: res.replies[i],
            baselineMsgIds,
            knownOtherIds
          });
          finalOutcome = outcome;

          if (outcome.status === "aborted_drift" || outcome.status === "aborted_new_msg" || outcome.status === "failed_before_submit") {
            if (i === 0) {
              log(`[ABORT:${outcome.status}] ${nickname} (${outcome.reason})，已清空草稿并回滚本轮`, true);
              await rollbackAbortedTurn(storePath, userId, res.prevRecord, batchMsgIds);
              retryUsers.add(userId);
              return;
            }
            log(`[PARTIAL_ABORT:${outcome.status}] ${nickname} 第${i + 1}条取消发送 (${outcome.reason})，保留已发${i}条`, true);
            if (outcome.status === "aborted_new_msg") retryUsers.add(userId);
            break;
          }

          if (outcome.status === "rejected") {
            log(`[REJECTED] ${nickname} ${i === 0 ? "平台拒绝发送" : `第${i + 1}条被平台拒绝`} (${outcome.reason})，暂停追发等待对方先回`, true);
            break;
          }

          sentTextsThisTurn.push(outcome.cleanText);
          sentIdsAll.push(...outcome.sentIds);
          tempIdsAll.push(...outcome.tempIds);
          baselineMsgIds = [...new Set([...baselineMsgIds, ...outcome.sentIds, ...outcome.tempIds])];

          if (outcome.status === "uncertain") {
            log(`[UNCERTAIN] -> ${nickname}: 已触发发送但未抓到气泡回显，按防刷屏纪律停止后续连发`, true);
            break;
          }
          log(`[SENT] -> ${nickname} (${Math.round((Date.now() - receivedAt) / 1000)}s): ${outcome.cleanText}`);
        }

        const store = await loadStore(storePath);
        const rec = store[userId];
        if (!rec) return;
        rec.profileChecked = true;
        rec.seenMsgIds = [...new Set([...(rec.seenMsgIds || []), ...batchMsgIds])];

        if (sentTextsThisTurn.length === 0 && finalOutcome?.status === "rejected") {
          if (rec.history.at(-1)?.role === "assistant") rec.history.pop();
          rec.status = res.prevRecord?.status || "chatting";
          rec.platformLimited = true;
          rec.note = `发送受限(${finalOutcome.reason})`;
          await saveStore(storePath, store);
          await syncSummary(storePath, summaryPath);
          return;
        }

        if (sentTextsThisTurn.length > 0 && rec.history.at(-1)?.role === "assistant") {
          rec.history.at(-1).content = sentTextsThisTurn.join("\n");
        }
        rec.platformLimited = finalOutcome?.status === "rejected";
        rec.botSentIds = [...new Set([...(rec.botSentIds || []), ...sentIdsAll])];
        rec.botTempIds = [...new Set([...(rec.botTempIds || []), ...tempIdsAll])];
        rec.botSentTexts = [...new Set([...(rec.botSentTexts || []), ...sentTextsThisTurn])];
        rec.seenMsgIds = [...new Set([...(rec.seenMsgIds || []), ...sentIdsAll, ...tempIdsAll])];
        if (sentTextsThisTurn.length > 0) lastSummaryByUser.set(userId, sentTextsThisTurn.at(-1));
        if (finalOutcome?.status === "uncertain") {
          rec.note = (rec.note ? `${rec.note}；` : "") + "末条回显未确认，未自动重发";
        }
        if (res.record?.status === "manual") {
          log(`[MANUAL] ${nickname} 已回复并转人工接管（${res.record.note || "需人工处理"}）`);
        }
        await saveStore(storePath, store);
        await syncSummary(storePath, summaryPath);
      } catch (err) {
        log(`[ERROR] 回复 ${userId} 失败: ${err.message}`, true);
        if (res) {
          await rollbackAbortedTurn(storePath, userId, res.prevRecord, batchMsgIds).catch(() => {});
        }
        retryUsers.add(userId);
      } finally {
        if (!debouncer.hasPending(userId)) {
          for (const id of batchMsgIds) queuedMsgIds.delete(id);
        }
        busy = false;
      }
    }
  });

  log(`[START] xhs-dm-agent 守护已启动（id=${instanceId.slice(0, 8)}, provider=${cfg.provider}, model=${cfg.model || "default"}, dryRun=${dryRun}）`);
  // shortcut: 1.5s 本地读 DOM 零 token 轮询，单账号几十会话足够轻量；若扩展到多账号百级并发再升级 CDP Network/WS 事件流
  while (true) {
    if (!(await isInstanceOwner(lockPath, instanceId))) {
      debouncer.clearAll();
      log(`[STOP] 检测到新实例或停机信号，旧守护 (${instanceId.slice(0, 8)}) 退出`);
      break;
    }
    if (!busy) {
      busy = true;
      try {
        const snap = await readChatSnapshot(page);
        if (snap.blocked) {
          if (!blockedAlerted) {
            log("[ALERT] 检测到掉线或安全滑块验证，已暂停自动回复！请前往自动化浏览器空间手动处理。", true);
            blockedAlerted = true;
          }
        } else {
          blockedAlerted = false;
          const targets = collectTargetConvs({
            convs: snap.convs,
            activeUserId: snap.activeUserId,
            headerName: snap.headerName,
            lastSummaryByUser,
            initialized: summaryInitialized,
            retryUsers
          });
          summaryInitialized = true;

          for (const [userId, nickname] of targets.entries()) {
            let curSnap = snap;
            if (snap.activeUserId !== userId) {
              if (!(await openConversationVerified(page, userId))) continue;
              curSnap = await readChatSnapshot(page);
              if (curSnap.blocked) break;
            }
            const messages = curSnap.messages;
            retryUsers.delete(userId);

            const store = await loadStore(storePath);
            const rec = store[userId] || {
              userId,
              nickname,
              status: "chatting",
              slots: {},
              redFlags: [],
              note: "",
              history: [],
              seenMsgIds: [],
              botSentIds: [],
              botTempIds: []
            };

            const hadSeenBefore = (rec.seenMsgIds || []).length > 0;
            const allSettledBySeed = seedHistoryFromDom(messages, rec);
            const seededPartial = !allSettledBySeed && !hadSeenBefore && (rec.seenMsgIds || []).length > 0;
            if (allSettledBySeed) {
              store[userId] = rec;
              await saveStore(storePath, store);
              await syncSummary(storePath, summaryPath);
              continue;
            }

            const { newOther, humanTookOver } = diffMessages(messages, rec);
            let freshOther = newOther.filter(m => !queuedMsgIds.has(m.msgId));
            let dryRunReset = false;
            if (dryRun && freshOther.length > 0) {
              const resetRes = applyDryRunReset(freshOther, messages, rec);
              if (resetRes.triggered) {
                dryRunReset = true;
                for (const droppedId of debouncer.clearUser(userId)) queuedMsgIds.delete(droppedId);
                freshOther = resetRes.freshOther;
                store[userId] = rec;
                await saveStore(storePath, store);
                await syncSummary(storePath, summaryPath);
                log(
                  freshOther.length > 0
                    ? `[DRY-RUN] [RESET] ${nickname} 已重置为全新会话，正在处理新首轮消息`
                    : `[DRY-RUN] [RESET] ${nickname} 已重置为全新会话，请发下一条消息测试首轮回复`
                );
                if (freshOther.length === 0) continue;
              }
            }
            const effectiveHumanTookOver = dryRunReset ? false : humanTookOver;
            let limitCleared = false;
            if (freshOther.length > 0 && rec.platformLimited) {
              rec.platformLimited = false;
              limitCleared = true;
            }
            if (effectiveHumanTookOver && rec.status === "chatting") {
              rec.status = "manual";
              rec.note = (rec.note ? `${rec.note}；` : "") + "检测到手动回复，AI已让出控制权";
              log(`[MANUAL] ${nickname} 检测到人工回复，已切为手动接管`);
            }
            if (effectiveHumanTookOver || (freshOther.length > 0 && rec.status !== "chatting")) {
              if (!effectiveHumanTookOver && freshOther.length > 0 && rec.status !== "chatting") {
                log(`[IGNORE] ${nickname} 当前状态为 ${rec.status}，忽略 ${freshOther.length} 条新消息`);
              }
              rec.seenMsgIds = [...new Set([...(rec.seenMsgIds || []), ...messages.map(m => m.msgId)])];
              store[userId] = rec;
              await saveStore(storePath, store);
              await syncSummary(storePath, summaryPath);
            } else if (seededPartial || limitCleared) {
              store[userId] = rec;
              await saveStore(storePath, store);
              await syncSummary(storePath, summaryPath);
            }
            if (freshOther.length > 0 && rec.status === "chatting" && !rec.platformLimited) {
              pendingUsers.set(userId, nickname);
              for (const msg of freshOther) {
                queuedMsgIds.add(msg.msgId);
                log(`[IN] ${nickname}: ${msg.text}`);
                debouncer.push(userId, msg.text, msg.msgId);
              }
            }
          }
        }
      } catch (err) {
        if (/not found|unresponsive|closed|label/i.test(err.message || "")) {
          try {
            page = await attachChatPage({
              spaceId: cfg.spaceId,
              profileId: cfg.profileId,
              spaceName: cfg.spaceName,
              excludeSpaceNames: cfg.excludeSpaceNames
            });
          } catch {}
        }
        log(`[POLL_ERR] ${err.message}`, true);
      } finally {
        busy = false;
      }
    }
    await new Promise(r => setTimeout(r, cfg.pollIntervalMs ?? 1500));
  }
}

if (globalThis.taskSpace && process.env.XHS_DAEMON_AUTOSTART === "1") {
  await runDaemon({ dryRun: process.env.XHS_DRY_RUN === "1" });
}
