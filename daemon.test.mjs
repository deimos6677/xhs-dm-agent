import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleIncoming, loadStore } from "./brain.mjs";
import {
  applyDryRunReset,
  attachChatPage,
  claimInstanceLock,
  collectTargetConvs,
  diffMessages,
  isInstanceOwner,
  renderSummaryMarkdown,
  resolveRuntimeConfig,
  rollbackAbortedTurn,
  seedHistoryFromDom
} from "./daemon.mjs";
import {
  classifySystemText,
  normalizeChatSnapshot,
  openConversationVerified,
  planTypingBursts,
  sanitizeOutboundText,
  sendMessageVerified
} from "./xhs-web.mjs";

// 1. 新消息识别 + 人工接管检测 + 临时ID/己方文本排除
const d1 = diffMessages(
  [
    { msgId: "m1", isOther: true, isSelf: false, text: "在吗" },
    { msgId: "1795445483574-a8305n6p", isOther: false, isSelf: true, text: "刚发出的临时消息" },
    { msgId: "srv.id.999", isOther: false, isSelf: true, text: "你在哪个城市呀" },
    { msgId: "m3", isOther: true, isSelf: false, text: "下周周末都有空" }
  ],
  { seenMsgIds: ["m1"], botSentIds: [], botSentTexts: ["你在哪个城市呀"] }
);
assert.equal(d1.newOther.length, 1);
assert.equal(d1.newOther[0].msgId, "m3");
assert.equal(d1.humanTookOver, false);

const d2 = diffMessages(
  [
    { msgId: "m1", isOther: true, isSelf: false, text: "在吗" },
    { msgId: "m9", isOther: false, isSelf: true, text: "我自己来聊吧" }
  ],
  { seenMsgIds: ["m1"], botSentIds: [] }
);
assert.equal(d2.humanTookOver, true);

// 1b. 老会话首次接管：保留历史双向对话上下文，只把己方末条之后的未回消息送去触发 AI
const existingRec = { seenMsgIds: [], history: [] };
const existingDom = [
  { msgId: "old1", isOther: true, isSelf: false, text: "我在上海，这周末有空" },
  { msgId: "old2", isOther: false, isSelf: true, text: "可以一起合作看看呀" },
  { msgId: "new1", isOther: true, isSelf: false, text: "你好宝子，你接受的价格是多少呀？" }
];
assert.equal(seedHistoryFromDom(existingDom, existingRec), false);
assert.deepEqual(existingRec.seenMsgIds, ["old1", "old2"]);
assert.equal(existingRec.history.length, 2);
const dSeeded = diffMessages(existingDom, existingRec);
assert.deepEqual(dSeeded.newOther.map(m => m.msgId), ["new1"]);
assert.equal(dSeeded.humanTookOver, false);

// 2. 系统消息漏斗 + 24h限流识别 + 卡片/图片/语音转译 + URL 会话兜底
assert.equal(classifySystemText("昨天 18:20")?.kind, "noise");
assert.equal(classifySystemText("对方撤回了一条消息")?.kind, "noise");
assert.equal(classifySystemText("对方关注或回复你之前，24小时内最多只能发1条文字消息")?.kind, "limit");
assert.equal(classifySystemText("暂不支持该消息类型，请到手机端查看")?.kind, "unsupported");

const snap = normalizeChatSnapshot({
  blocked: false,
  pathname: "/chat/660000000000000000000001",
  activeUserId: "",
  headerName: "上海同好",
  convs: [
    { userId: "sys1", nickname: "赞和收藏", summary: "收到赞", unread: 3, hasUnreadDot: true },
    { userId: "User-660000000000000000000001", nickname: "上海同好", summary: "[笔记]", unread: 1, hasUnreadDot: true }
  ],
  rawItems: [
    { msgId: "", fallbackText: "19:20" },
    { msgId: "c1", isOther: true, hasCard: true, cardTitle: "周末上海约拍互免作品集" },
    { msgId: "c2", isOther: true, hasImage: true },
    { msgId: "c3", isOther: true, fallbackText: "暂不支持该消息类型，请到手机端查看" },
    { msgId: "", fallbackText: "对方关注或回复你之前，24小时内最多只能发1条文字消息" }
  ]
});
assert.equal(snap.convs.length, 1);
assert.equal(snap.activeUserId, "660000000000000000000001");
assert.match(snap.platformLimitReason, /24小时内最多只能发/);
assert.equal(snap.messages.length, 3);
assert.equal(snap.messages[0].text, "[笔记卡片: 周末上海约拍互免作品集]");
assert.equal(snap.messages[1].text, "[图片消息]");
assert.equal(snap.messages[2].text, "[对方发来手机端专属消息或语音]");

// 2b. Bug C2：历史残留 24h 限流提示遇到后续正常消息必须清零；正常气泡含时间/失败词不能被误删
const snapHistoryLimit = normalizeChatSnapshot({
  convs: [{ userId: "u1", nickname: "上海同好", summary: "刚才是不是消息发送失败" }],
  hasEditor: true,
  bodyText: "刚才是不是消息发送失败 安全验证 请求太频繁",
  rawItems: [
    { msgId: "", fallbackText: "对方关注或回复你之前，24小时内最多只能发1条文字消息" },
    { msgId: "m1", isOther: true, bubbleText: "昨天 18:20" },
    { msgId: "m2", isOther: true, bubbleText: "刚才是不是消息发送失败" }
  ]
});
assert.equal(snapHistoryLimit.platformLimitReason, "");
assert.equal(snapHistoryLimit.messages.length, 2);
assert.equal(snapHistoryLimit.messages[0].text, "昨天 18:20");
assert.equal(snapHistoryLimit.messages[1].text, "刚才是不是消息发送失败");
// Bug C3：会话页内气泡/摘要含“请求太频繁/安全验证”不触发全局 blocked；无会话无输入框或有弹窗才 blocked
assert.equal(snapHistoryLimit.blocked, false);
assert.equal(normalizeChatSnapshot({ convs: [], hasEditor: false, bodyText: "请完成安全验证 拖动滑块" }).blocked, true);
assert.equal(normalizeChatSnapshot({ convs: [{ userId: "u1", nickname: "A" }], hasEditor: true, hasRiskModal: true, bodyText: "" }).blocked, true);
assert.equal(normalizeChatSnapshot({ convs: [{ userId: "u1", nickname: "A" }], hasEditor: true, hasLoginInput: true, bodyText: "" }).blocked, true);

// 3. 拟人分段键入与换行净化
assert.equal(sanitizeOutboundText("你好\n周末方便吗\u200B"), "你好，周末方便吗");
const bursts = planTypingBursts("时间挺巧的呀，你在哪个城市", () => 0.4);
assert.ok(bursts.length >= 4);
assert.equal(bursts.map(b => b.text).join(""), "时间挺巧的呀，你在哪个城市");

// 4. sendMessageVerified 四道闸门模拟验证（confirmed / aborted_drift / aborted_new_msg / rejected / uncertain）
function createMockPage({
  driftBeforeEnter = false,
  newMsgDuringType = false,
  limitAfterEnter = false,
  historyLimitBeforeNewMsg = false,
  switchDuringVerify = false,
  noEcho = false
} = {}) {
  let draft = "残留的半截旧草稿";
  let activeId = "u_target";
  let enterPressed = false;
  let evalStep = 0;
  const typedChunks = [];

  return {
    get state() { return { draft, enterPressed, typedChunks }; },
    waitForTimeout: async () => {},
    keyboard: {
      insertText: async (chunk) => {
        typedChunks.push(chunk);
        draft += chunk;
      },
      press: async (key) => {
        if (key === "Enter") {
          enterPressed = true;
          if (!noEcho) draft = "";
        }
      }
    },
    evaluate: async (fn, arg) => {
      evalStep++;
      // 闸门 1：prep 清空残留草稿
      if (evalStep === 1) {
        draft = "";
        return { ok: true };
      }
      // 闸门 3：提交前最后一刻复核
      if (evalStep === 2) {
        if (driftBeforeEnter) {
          activeId = "u_other_person";
          draft = "";
          return { action: "abort", status: "aborted_drift", reason: `active=${activeId}` };
        }
        if (newMsgDuringType) {
          draft = "";
          return { action: "abort", status: "aborted_new_msg", reason: "incoming_arrived_during_typing" };
        }
        if (draft !== arg.expectedDraft) {
          return { action: "abort", status: "failed_before_submit", reason: "draft_mismatch" };
        }
        return { action: "press_enter" };
      }
      // 闸门 4：readChatSnapshot 或尾部清草稿
      const fnSrc = String(fn);
      if (fnSrc.includes("rawItems")) {
        if (switchDuringVerify) {
          return {
            blocked: false,
            pathname: "/chat/u_other_person",
            activeUserId: "u_other_person",
            headerName: "其他会话",
            convs: [],
            rawItems: [{ msgId: "u_other.conv.oldself", isSelf: true, bubbleText: "其他人的旧回复" }]
          };
        }
        return {
          blocked: false,
          pathname: `/chat/${activeId}`,
          activeUserId: activeId,
          headerName: "测试用户",
          convs: [],
          rawItems: limitAfterEnter
            ? [{ msgId: "", fallbackText: "对方关注或回复你之前，24小时内最多只能发1条文字消息" }]
            : historyLimitBeforeNewMsg
              ? [
                  { msgId: "", fallbackText: "对方关注或回复你之前，24小时内最多只能发1条文字消息" },
                  { msgId: "m1", isOther: true, bubbleText: "我回你了" },
                  { msgId: "u_target.conv.formal02", isSelf: true, bubbleText: "你在哪个城市呀" }
                ]
              : noEcho
                ? [{ msgId: "m1", isOther: true, bubbleText: "在吗" }]
                : evalStep === 3
                  ? [{ msgId: "1795445483574-temp01", isSelf: true, bubbleText: "你在哪个城市呀" }]
                  : [{ msgId: "u_target.conv.formal01", isSelf: true, bubbleText: "你在哪个城市呀" }]
        };
      }
      const leftover = draft;
      draft = "";
      return leftover;
    }
  };
}

// 4a. 正常发送：旧草稿被清、逐段键入、等临时 ID 变正式 ID 后 confirmed
const okPage = createMockPage();
const rOk = await sendMessageVerified(okPage, {
  expectedUserId: "u_target",
  text: "你在哪个城市呀",
  baselineMsgIds: ["m1"],
  knownOtherIds: ["m1"],
  verifyAttempts: 3,
  verifyIntervalMs: 1
});
assert.equal(rOk.status, "confirmed");
assert.deepEqual(rOk.sentIds, ["u_target.conv.formal01"]);
assert.equal(okPage.state.enterPressed, true);
assert.equal(okPage.state.typedChunks.join(""), "你在哪个城市呀");

// 4b. 会话漂移防串台：绝不按 Enter，且立即清空草稿
const driftPage = createMockPage({ driftBeforeEnter: true });
const rDrift = await sendMessageVerified(driftPage, {
  expectedUserId: "u_target",
  text: "你在哪个城市呀",
  verifyAttempts: 1,
  verifyIntervalMs: 1
});
assert.equal(rDrift.status, "aborted_drift");
assert.equal(driftPage.state.enterPressed, false);
assert.equal(driftPage.state.draft, "");

// 4c. 打字期间新消息到达：绝不抢答按 Enter，清空草稿等合并
const latePage = createMockPage({ newMsgDuringType: true });
const rLate = await sendMessageVerified(latePage, {
  expectedUserId: "u_target",
  text: "你在哪个城市呀",
  verifyAttempts: 1,
  verifyIntervalMs: 1
});
assert.equal(rLate.status, "aborted_new_msg");
assert.equal(latePage.state.enterPressed, false);

// 4d. 平台 24h 限发拦截 -> rejected
const limitPage = createMockPage({ limitAfterEnter: true });
const rLimit = await sendMessageVerified(limitPage, {
  expectedUserId: "u_target",
  text: "你在哪个城市呀",
  verifyAttempts: 2,
  verifyIntervalMs: 1
});
assert.equal(rLimit.status, "rejected");
assert.match(rLimit.reason, /24小时/);

// 4e. 提交后无回显 -> uncertain（清空残留草稿且不自动重发）
const uncertainPage = createMockPage({ noEcho: true });
const rUncertain = await sendMessageVerified(uncertainPage, {
  expectedUserId: "u_target",
  text: "你在哪个城市呀",
  verifyAttempts: 2,
  verifyIntervalMs: 1
});
assert.equal(rUncertain.status, "uncertain");
assert.equal(uncertainPage.state.draft, "");

// 4f. Bug C2：历史残留限流提示 + 后续新消息回显 -> 必须判 confirmed 而非 rejected
const histLimitPage = createMockPage({ historyLimitBeforeNewMsg: true });
const rHistLimit = await sendMessageVerified(histLimitPage, {
  expectedUserId: "u_target",
  text: "你在哪个城市呀",
  baselineMsgIds: ["m1"],
  knownOtherIds: ["m1"],
  verifyAttempts: 2,
  verifyIntervalMs: 1
});
assert.equal(rHistLimit.status, "confirmed");
assert.deepEqual(rHistLimit.sentIds, ["u_target.conv.formal02"]);

// 4g. Bug C4：闸门 4 轮询期间会话漂移 -> 立即返回 uncertain，不把他人气泡记入 sentIds
const switchPage = createMockPage({ switchDuringVerify: true });
const rSwitch = await sendMessageVerified(switchPage, {
  expectedUserId: "u_target",
  text: "你在哪个城市呀",
  baselineMsgIds: ["m1"],
  knownOtherIds: ["m1"],
  verifyAttempts: 2,
  verifyIntervalMs: 1
});
assert.equal(rSwitch.status, "uncertain");
assert.equal(rSwitch.reason, "conv_switched_during_verify");
assert.deepEqual(rSwitch.sentIds, []);

// 4h. Bug C4：DOM 属性带 data-conv-id="User-xxx" 前缀时，openConversationVerified 与闸门 1/3 均须正常通过
{
  const prevGlobals = {
    document: globalThis.document,
    location: globalThis.location,
    CSS: globalThis.CSS,
    Event: globalThis.Event,
    InputEvent: globalThis.InputEvent,
    getComputedStyle: globalThis.getComputedStyle
  };
  let clickedPrefixed = false;
  let activeRawId = "";
  let sentNow = false;
  const editorEl = {
    tagName: "TEXTAREA",
    value: "旧草稿",
    focus() {},
    dispatchEvent() {}
  };
  const convEl = {
    classList: { contains: (c) => activeRawId === "User-u_prefixed" && c === "xhs-im-conv-item--active" },
    getAttribute: (k) => (k === "data-conv-id" ? "User-u_prefixed" : null),
    querySelector: (s) => (s.includes("name") ? { textContent: "前缀测试" } : s.includes("summary") ? { textContent: "在吗" } : null),
    querySelectorAll: () => [],
    scrollIntoView() {},
    click() { clickedPrefixed = true; activeRawId = "User-u_prefixed"; }
  };
  const msgEls = () => {
    const list = [
      {
        getAttribute: (k) => (k === "data-message-id" ? "m1" : ""),
        querySelector: (s) => (s.includes("other") ? {} : s.includes("bubble__text") ? { innerText: "在吗" } : null),
        querySelectorAll: () => [],
        innerText: "在吗"
      }
    ];
    if (sentNow) {
      list.push({
        getAttribute: (k) => (k === "data-message-id" ? "u_prefixed.conv.f1" : ""),
        querySelector: (s) => (s.includes("me") ? {} : s.includes("bubble__text") ? { innerText: "你好呀" } : null),
        querySelectorAll: () => [],
        innerText: "你好呀"
      });
    }
    return list;
  };
  try {
    globalThis.CSS = { escape: (s) => s };
    globalThis.Event = class { constructor(t) { this.type = t; } };
    globalThis.InputEvent = globalThis.Event;
    globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });
    globalThis.location = { pathname: "/chat" };
    globalThis.document = {
      body: { innerText: "" },
      querySelector: (sel) => {
        if (sel.includes("xhs-im-conv-item--active")) return activeRawId ? convEl : null;
        if (sel.includes("jarvis-reply-textarea") || sel.includes("xhs-im-input-bar-editor")) return editorEl;
        if (sel.includes('data-conv-id="u_prefixed"')) return null;
        return null;
      },
      querySelectorAll: (sel) => {
        if (sel.includes("xhs-im-conv-item")) return [convEl];
        if (sel.includes("chat-item")) return msgEls();
        return [];
      }
    };
    const domPage = {
      waitForTimeout: async () => {},
      keyboard: {
        insertText: async (chunk) => { editorEl.value += chunk; },
        press: async (key) => { if (key === "Enter") { sentNow = true; editorEl.value = ""; } }
      },
      evaluate: async (fn, arg) => fn(arg)
    };
    const opened = await openConversationVerified(domPage, "u_prefixed", { timeoutMs: 200 });
    assert.equal(opened, true);
    assert.equal(clickedPrefixed, true);
    const rPrefixed = await sendMessageVerified(domPage, {
      expectedUserId: "u_prefixed",
      text: "你好呀",
      baselineMsgIds: ["m1"],
      knownOtherIds: ["m1"],
      verifyAttempts: 2,
      verifyIntervalMs: 1
    });
    assert.equal(rPrefixed.status, "confirmed");
    assert.deepEqual(rPrefixed.sentIds, ["u_prefixed.conv.f1"]);
  } finally {
    Object.assign(globalThis, prevGlobals);
  }
}

// 5. 中断回滚测试：即使模型已判 shortlisted，未发出的轮次必须完整退回 chatting 且归还 seenMsgIds
const tmpStore = path.join(os.tmpdir(), `xhs-daemon-rollback-${Date.now()}.json`);
await fs.writeFile(tmpStore, JSON.stringify({
  u1: { userId: "u1", nickname: "小李", status: "chatting", slots: { city: "伦敦" }, history: [], seenMsgIds: ["m0", "m1"] }
}), "utf8");
const pendingRes = await handleIncoming({
  userId: "u1",
  nickname: "小李",
  incomingText: "周末时间都可以，预算200行",
  storePath: tmpStore,
  llmFn: async () => JSON.stringify({
    replies: ["太好了，情况我都了解，我这边综合看下晚点回复你"],
    extracted: { budget: "200", requirementFit: true },
    status: "shortlisted"
  })
});
assert.equal(pendingRes.record.status, "shortlisted");
await rollbackAbortedTurn(tmpStore, "u1", pendingRes.prevRecord, ["m1"]);
const restored = (await loadStore(tmpStore)).u1;
assert.equal(restored.status, "chatting");
assert.equal(restored.history.length, 0);
assert.deepEqual(restored.seenMsgIds, ["m0"]);
await fs.unlink(tmpStore);

// 6. 汇总表、目标会话收集与单活锁
const md = renderSummaryMarkdown({
  u1: { userId: "u1", nickname: "上海小李", status: "chatting", platformLimited: true, slots: { city: "上海", schedule: "本周末" }, redFlags: [] }
});
assert.match(md, /状态:待对方回关\/回复后解锁/);
assert.match(md, /时间:本周末/);
assert.equal(resolveRuntimeConfig({ apiKey: "sk-real" }).provider, "openai");
assert.equal(resolveRuntimeConfig({}).proxyUrl, "auto");
assert.equal(resolveRuntimeConfig({}).debounceMinMs, 2500);
assert.equal(resolveRuntimeConfig({}).debounceMaxMs, 3500);

const summaryMap = new Map();
collectTargetConvs({ convs: [{ userId: "u1", nickname: "小李", summary: "旧", unread: 0, hasUnreadDot: false }], initialized: false, lastSummaryByUser: summaryMap });
const changed = collectTargetConvs({ convs: [{ userId: "u1", nickname: "小李", summary: "新", unread: 0, hasUnreadDot: false }], initialized: true, lastSummaryByUser: summaryMap });
assert.equal(changed.has("u1"), true);

// 6b. Bug C1：回滚后的非当前无未读会话通过 retryUsers 仍能被下一轮重新扫回
const retryOnly = collectTargetConvs({
  convs: [
    { userId: "u1", nickname: "小李", summary: "新", unread: 0, hasUnreadDot: false },
    { userId: "u2", nickname: "当前人", summary: "hi", unread: 0, hasUnreadDot: false }
  ],
  activeUserId: "u2",
  initialized: true,
  lastSummaryByUser: summaryMap,
  retryUsers: new Set(["u1"])
});
assert.equal(retryOnly.has("u1"), true);
assert.equal(retryOnly.get("u1"), "小李");

const tmpLock = path.join(os.tmpdir(), `xhs-lock-${Date.now()}.lock`);
const id1 = await claimInstanceLock(tmpLock);
const id2 = await claimInstanceLock(tmpLock);
assert.equal(await isInstanceOwner(tmpLock, id1), false);
assert.equal(await isInstanceOwner(tmpLock, id2), true);
await fs.unlink(tmpLock);

// 7. Profile 1 红线拦截 + Profile 2 空间关闭时自动重建直达 /chat
await assert.rejects(
  () => attachChatPage({ spaceId: 0, profileId: "Profile 2" }, {
    listTaskSpaces: async () => [{ id: 0, profileId: "Profile 1", ownership: "user" }]
  }),
  /Profile 1/
);

let createdArgs = null;
let gotoUrl = "";
await attachChatPage({ spaceId: 5, profileId: "Profile 2" }, {
  listTaskSpaces: async () => [{ id: 0, profileId: "Profile 1", ownership: "user" }],
  taskSpace: async (name, opts) => {
    createdArgs = { name, opts };
    return {
      tabs: async () => [{ label: "p1", url: "about:blank", active: true }],
      page: () => ({ url: async () => "about:blank", goto: async (u) => { gotoUrl = u; } })
    };
  }
});
assert.deepEqual(createdArgs, { name: "xhs-dm-agent", opts: { profileId: "Profile 2" } });
assert.equal(gotoUrl, "https://www.xiaohongshu.com/chat");

// 7b. Profile 2 存在被排除的其他自动化空间时绝不能误劫持，必须新建独立的 xhs-dm-agent 空间
let hijackedOther = false;
let createdForXhs = null;
await attachChatPage({ spaceId: 5, profileId: "Profile 2", excludeSpaceNames: ["other-agent"] }, {
  listTaskSpaces: async () => [
    { id: 0, profileId: "Profile 1", name: "personal", ownership: "user" },
    { id: 8, profileId: "Profile 2", name: "unrelated", ownership: "user", recentTabTitles: ["Chat"] },
    { id: 9, profileId: "Profile 2", name: "other-agent", ownership: "agent", recentTabTitles: ["创作服务平台"] }
  ],
  taskSpace: async (arg, opts) => {
    if (arg === 9) hijackedOther = true;
    createdForXhs = { arg, opts };
    return {
      tabs: async () => [{ label: "p1", url: "about:blank", active: true }],
      page: () => ({ url: async () => "about:blank", goto: async () => {} })
    };
  }
});
assert.equal(hijackedOther, false);
assert.deepEqual(createdForXhs, { arg: "xhs-dm-agent", opts: { profileId: "Profile 2" } });

// 8. DryRun 重置口令 /new：可把已淘汰老会话重置为全新会话，且支持直接附带首句
const rejectedRec = {
  userId: "u-test",
  nickname: "test_user",
  status: "rejected",
  slots: { budget: "1000元" },
  redFlags: ["报价过高"],
  note: "已淘汰",
  history: [{ role: "user", content: "1000一次" }, { role: "assistant", content: "预算超了" }],
  seenMsgIds: ["m1", "m2"],
  botSentIds: ["m2"],
  botTempIds: [],
  profileChecked: true,
  profileSummary: "旧背调",
  mood: "急躁"
};
const domWithPlainReset = [
  { msgId: "m1", isOther: true, text: "1000一次" },
  { msgId: "m2", isOther: false, text: "预算超了" },
  { msgId: "m3", isOther: true, text: "  /new  " }
];
const r1 = applyDryRunReset([domWithPlainReset[2]], domWithPlainReset, rejectedRec);
assert.equal(r1.triggered, true);
assert.equal(r1.freshOther.length, 0);
assert.equal(rejectedRec.status, "chatting");
assert.deepEqual(rejectedRec.history, []);
assert.deepEqual(rejectedRec.slots, {});
assert.deepEqual(rejectedRec.redFlags, []);
assert.equal(rejectedRec.profileChecked, false);
assert.deepEqual(rejectedRec.seenMsgIds, ["m1", "m2", "m3"]);
assert.equal(seedHistoryFromDom(domWithPlainReset, rejectedRec), false);

const domWithInlineReset = [
  { msgId: "m1", isOther: true, text: "旧消息" },
  { msgId: "m2", isOther: false, text: "旧回复" },
  { msgId: "m3", isOther: true, text: "/NEW 你好，想了解下合作细节" }
];
const rec2 = { ...rejectedRec, status: "manual", history: [{ role: "user", content: "旧消息" }], seenMsgIds: ["m1", "m2"] };
const r2 = applyDryRunReset([domWithInlineReset[2]], domWithInlineReset, rec2);
assert.equal(r2.triggered, true);
assert.equal(rec2.status, "chatting");
assert.deepEqual(rec2.history, []);
assert.deepEqual(rec2.seenMsgIds, ["m1", "m2"]);
assert.equal(r2.freshOther.length, 1);
assert.equal(r2.freshOther[0].msgId, "m3");
assert.equal(r2.freshOther[0].text, "你好，想了解下合作细节");

const r3 = applyDryRunReset([{ msgId: "m4", isOther: true, text: "正常消息" }], domWithInlineReset, rec2);
assert.equal(r3.triggered, false);

console.log("ALL_DAEMON_TESTS_PASSED");
