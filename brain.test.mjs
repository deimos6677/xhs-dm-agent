import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  MessageDebouncer,
  buildSystemPrompt,
  callCodexExec,
  callOpenAICompatible,
  computeSendDelayMs,
  detectManualEscalation,
  formatMessagesForCodex,
  handleIncoming,
  mergeSlots,
  parseModelJson,
  typingDelayMs,
  validateOutboundReply
} from "./brain.mjs";

// 1. JSON 解析 + 换行自动归一为单行逗号
const parsed = parseModelJson(
  '```json\n{"replies":["哈喽\\n你在哪个城市呀"],"extracted":{"city":"上海","background":"摄影师"},"mood":"友善配合","personality":"沟通直接","longTermFit":"高","redFlags":[],"status":"chatting","note":"初筛"}\n```'
);
assert.deepEqual(parsed.replies, ["哈喽，你在哪个城市呀"]);
assert.equal(parsed.extracted.city, "上海");
assert.equal(parsed.extracted.background, "摄影师");
assert.equal(parsed.mood, "友善配合");
assert.equal(parsed.longTermFit, "高");

// 2. 动态北京时间日期注入 + 自定义 prompt 模板替换
const promptStr = buildSystemPrompt(new Date("2026-11-24T11:00:00Z"));
assert.match(promptStr, /今天是2026年11月24日/);
assert.match(promptStr, /requirementFit/);
assert.match(promptStr, /主页背调只作暗中参考/);

const customPromptStr = buildSystemPrompt(
  new Date("2026-11-24T11:00:00Z"),
  "",
  "自定义角色设定：今天日期为 {{TODAY}}，寻找周末同城约拍搭子。"
);
assert.match(customPromptStr, /今天日期为 2026年11月24日/);
assert.match(customPromptStr, /周末同城约拍搭子/);

// 3. 出站机械安全守卫（拦截站外引流变体、客服腔、多问号、超长）
assert.equal(validateOutboundReply("加个微信细聊吧").ok, false);
assert.equal(validateOutboundReply("加V聊聊吧").ok, false);
assert.equal(validateOutboundReply("加我徽信发你").ok, false);
assert.equal(validateOutboundReply("可以加whatsapp吗").ok, false);
assert.equal(validateOutboundReply("您好，请问您周末有空吗").ok, false);
assert.equal(validateOutboundReply("你在哪个城市？周末有空吗？").ok, false);
assert.equal(validateOutboundReply("哈".repeat(50)).ok, false);
assert.equal(validateOutboundReply("时间挺巧的，你这周末在哪个区方便").ok, true);

// 4. 多轮槽位合并不能被 null 覆盖
const merged = mergeSlots(
  { city: "上海", schedule: null, requirementFit: true },
  { city: null, schedule: "本周末", requirementFit: null }
);
assert.equal(merged.city, "上海");
assert.equal(merged.schedule, "本周末");
assert.equal(merged.requirementFit, true);

// 5. 防抖合并文本并保留批次 msgIds
const flushed = [];
const debouncer = new MessageDebouncer({
  minMs: 25,
  maxMs: 25,
  onFlush: (uid, text, meta) => flushed.push({ uid, text, meta })
});
debouncer.push("u1", "在吗", "m1");
assert.equal(debouncer.hasPending("u1"), true);
assert.equal(debouncer.hasPending("u_none"), false);
debouncer.push("u1", "我这周末有空", "m2");
await new Promise(r => setTimeout(r, 70));
assert.equal(flushed.length, 1);
assert.equal(flushed[0].text, "在吗\n我这周末有空");
assert.deepEqual(flushed[0].meta.msgIds, ["m1", "m2"]);

// 5b. 防抖 prepend 合并顺序正确（旧批次在前、新批次在后）
const prepended = [];
const debouncer2 = new MessageDebouncer({
  minMs: 30,
  maxMs: 30,
  onFlush: (uid, text, meta) => prepended.push({ uid, text, meta })
});
debouncer2.push("u2", "后发的新消息", "m2");
debouncer2.prepend("u2", ["先发的消息1", "先发的消息2"], ["m0", "m1"]);
await new Promise(r => setTimeout(r, 80));
assert.equal(prepended.length, 1);
assert.equal(prepended[0].text, "先发的消息1\n先发的消息2\n后发的新消息");
assert.deepEqual(prepended[0].meta.msgIds, ["m0", "m1", "m2"]);

// 6. 单条 system 消息拼装 + 违规自动重试修正 + 多轮流转
const tmpStore = path.join(os.tmpdir(), `xhs-brain-test-${Date.now()}.json`);
let callCount = 0;
let capturedMessages = null;
const turn1 = await handleIncoming({
  userId: "u_test_1",
  nickname: "小陈",
  profileSummary: "IP:上海 | 近期笔记:胶片摄影日常",
  incomingText: "在吗，我周末在上海静安有空",
  storePath: tmpStore,
  llmFn: async (messages) => {
    callCount++;
    capturedMessages = messages;
    if (callCount === 1) {
      return JSON.stringify({
        replies: ["加我微信聊细节吧"],
        extracted: { city: "上海", schedule: "周末" },
        status: "chatting"
      });
    }
    return JSON.stringify({
      replies: ["你好，周末时间挺巧的，你平时主要拍什么风格？"],
      extracted: { city: "上海", schedule: "周末", background: "摄影爱好" },
      mood: "友善配合",
      personality: "表达清晰",
      longTermFit: "高",
      redFlags: [],
      status: "chatting",
      note: "已确认上海与周末时间"
    });
  }
});
assert.equal(callCount, 2);
assert.equal(capturedMessages.filter(m => m.role === "system").length, 1);
assert.match(capturedMessages[0].content, /首轮开场要求/);
assert.equal(turn1.skipped, false);
assert.match(turn1.retriedReason, /引流|风控/);
assert.deepEqual(turn1.replies, ["你好，周末时间挺巧的，你平时主要拍什么风格？"]);
assert.equal(turn1.record.slots.city, "上海");

// 6a. 老会话第二轮不再注入首轮要求，且标明已确认槽位禁重问
let secondSysPrompt = "";
const turn2 = await handleIncoming({
  userId: "u_test_1",
  nickname: "小陈",
  incomingText: "平时拍胶片人像，互免就可以",
  storePath: tmpStore,
  llmFn: async (messages) => {
    secondSysPrompt = messages[0].content;
    return JSON.stringify({
      replies: ["太好了，周六下午方便吗？"],
      extracted: { requirementFit: true },
      status: "chatting",
      note: "确认互免匹配"
    });
  }
});
assert.equal(turn2.skipped, false);
assert.doesNotMatch(secondSysPrompt, /首轮开场要求/);
assert.match(secondSysPrompt, /已确认槽位.*上海/);
assert.equal(turn2.record.slots.requirementFit, true);

// 6b. 人机质疑前置转人工：零 LLM 调用直接切 manual
assert.ok(detectManualEscalation("你是真人吗"));
assert.ok(detectManualEscalation("这是AI吗"));
assert.equal(detectManualEscalation("周末几点方便"), "");
let escalateLlmCalled = false;
const escalatedTurn = await handleIncoming({
  userId: "u_escalate",
  nickname: "谨慎用户",
  incomingText: "你这是自动回复机器人吗",
  storePath: tmpStore,
  llmFn: async () => {
    escalateLlmCalled = true;
    return '{"replies":["不是呀"],"status":"chatting"}';
  }
});
assert.equal(escalateLlmCalled, false);
assert.equal(escalatedTurn.skipped, true);
assert.match(escalatedTurn.reason, /^manual_escalate:/);
assert.equal(escalatedTurn.record.status, "manual");

// 6c. 二次校验仍不通过时阻断外发并自动切 manual
const blockedTurn = await handleIncoming({
  userId: "u_blocked",
  nickname: "测试二",
  incomingText: "你好",
  storePath: tmpStore,
  llmFn: async () => JSON.stringify({ replies: ["加V细聊吧"], status: "chatting" })
});
assert.equal(blockedTurn.skipped, true);
assert.match(blockedTurn.reason, /^guard_blocked:/);
assert.equal(blockedTurn.record.status, "manual");

// 6d. 模型首次吐裸文本（缺 JSON 外壳）时自动重试补齐合法 JSON
let rawRetryCount = 0;
const recoveredTurn = await handleIncoming({
  userId: "u_raw_recover",
  nickname: "测试三",
  incomingText: "我下周三在杭州有空",
  storePath: tmpStore,
  llmFn: async () => {
    rawRetryCount++;
    if (rawRetryCount === 1) return "你好，杭州时间挺合适，大概下午方便吗？";
    return '{"replies":["你好，杭州时间挺合适，大概下午方便吗？"],"extracted":{"city":"杭州","schedule":"下周三"},"status":"chatting"}';
  }
});
assert.equal(rawRetryCount, 2);
assert.equal(recoveredTurn.skipped, false);
assert.equal(recoveredTurn.record.slots.city, "杭州");

// 6e. 非首轮支持 1~2 条拆分发送，且跨条超过 1 个问号触发重试拦截
await handleIncoming({
  userId: "u_multi",
  nickname: "多条测试",
  incomingText: "你好",
  storePath: tmpStore,
  maxReplies: 2,
  llmFn: async () => JSON.stringify({
    replies: ["你好，方便看下你在哪个城市吗？", "首轮多余第二条会被截断"],
    status: "chatting"
  })
});
let multiRetry = 0;
const multiTurn = await handleIncoming({
  userId: "u_multi",
  nickname: "多条测试",
  incomingText: "我在成都",
  storePath: tmpStore,
  maxReplies: 2,
  llmFn: async () => {
    multiRetry++;
    if (multiRetry === 1) {
      return JSON.stringify({ replies: ["行呀？", "你这周末有空吗？"], status: "chatting" });
    }
    return JSON.stringify({ replies: ["行呀", "你这周末有空吗？"], status: "chatting" });
  }
});
assert.equal(multiRetry, 2);
assert.match(multiTurn.retriedReason, /超过1个问号/);
assert.deepEqual(multiTurn.replies, ["行呀", "你这周末有空吗？"]);

// 6f. 模型返回空 replies: [] 时自动触发重试
let emptyRetry = 0;
const emptyRecoverTurn = await handleIncoming({
  userId: "u_empty_recover",
  nickname: "空回复测试",
  incomingText: "好的",
  storePath: tmpStore,
  maxReplies: 2,
  llmFn: async () => {
    emptyRetry++;
    if (emptyRetry === 1) return '{"replies":[],"status":"chatting","note":""}';
    return '{"replies":["你在哪个城市呀？"],"status":"chatting","note":"继续沟通"}';
  }
});
assert.equal(emptyRetry, 2);
assert.match(emptyRecoverTurn.retriedReason, /replies为空/);
assert.equal(emptyRecoverTurn.skipped, false);
assert.deepEqual(emptyRecoverTurn.replies, ["你在哪个城市呀？"]);

// 7. 实测 curl.exe 本地 HTTP UTF-8 与 @hdrFile Bearer 认证闭环
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", c => { raw += c.toString("utf8"); });
  req.on("end", () => {
    assert.equal(req.headers.authorization, "Bearer test-secret-key");
    const parsedBody = JSON.parse(raw);
    assert.equal(parsedBody.model, "deepseek-chat");
    assert.match(parsedBody.messages[0].content, /上海/);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      choices: [{ message: { content: '{"replies":["周末时间挺合适"],"status":"chatting"}' } }]
    }));
  });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
try {
  const apiContent = await callOpenAICompatible({
    apiBaseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "test-secret-key",
    model: "deepseek-chat",
    messages: [{ role: "user", content: "我在上海" }]
  });
  assert.match(apiContent, /周末时间挺合适/);
} finally {
  server.close();
}

// 8. 延迟与 Codex CLI 兜底测试
assert.ok(typingDelayMs("哈喽，周末有空聊聊吗", () => 0.5) >= 2000);
assert.equal(computeSendDelayMs({ elapsedMs: 2000, rand: () => 0.5 }), 3500);
assert.equal(computeSendDelayMs({ elapsedMs: 7000, rand: () => 0.5 }), 0);
assert.match(formatMessagesForCodex([{ role: "user", content: "我在上海" }]), /【对方】\n我在上海/);

let capturedOutFile = "";
const codexReply = await callCodexExec({
  messages: [{ role: "user", content: "你好" }],
  spawnImpl: (_bin, args) => {
    capturedOutFile = args[args.indexOf("-o") + 1];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      end: async () => {
        await fs.writeFile(capturedOutFile, '{"replies":["在的"],"status":"chatting"}', "utf8");
        child.emit("close", 0);
      }
    };
    return child;
  }
});
assert.match(codexReply, /在的/);
await assert.rejects(() => fs.access(capturedOutFile));

await fs.unlink(tmpStore);
console.log("ALL_BRAIN_TESTS_PASSED");
