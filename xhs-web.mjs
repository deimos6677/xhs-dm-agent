export const TEMP_MSG_ID_RE = /^\d{13}-[a-z0-9]+$/i;

const OFFICIAL_CONV_NAME_RE = /^(赞和收藏|新增关注|评论和@|系统消息|系统通知|官方消息|陌生人消息)$/;
const TIMESTAMP_TEXT_RE = /^(?:\d{1,2}:\d{2}|(?:昨天|前天|星期[一二三四五六日天])\s*\d{1,2}:\d{2}|(?:\d{4}[年/-])?\d{1,2}[月/-]\d{1,2}日?(?:\s+\d{1,2}:\d{2})?)$/;
const LIMIT_SYSTEM_RE = /24小时内最多只能发|消息发送失败|消息已发出.*拒收|被对方拒收|对方已开启.*验证|发送过于频繁|操作太频繁|账号存在风险/;
const UNSUPPORTED_MSG_RE = /暂不支持该消息类型|请到手机端查看/;
const NOISE_SYSTEM_RE = /撤回了?一条消息|recalled a message|添加.*为好友|互相关注|以下为新消息|对方正在输入|^[-=]{3,}$/i;
const BLOCKED_BODY_RE = /登录后查看消息|安全验证|拖动滑块|验证后继续|请完成验证|请求太频繁/;

export function normalizeConvId(raw) {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (!s) return "";
  for (const p of ["Total-", "Active-", "User-", "Contact-", "User_", "Contact_"]) {
    if (s.startsWith(p)) {
      s = s.slice(p.length);
      break;
    }
  }
  return s.replace(/[^a-zA-Z0-9._-]/g, "");
}

// 清洗出站文案：去控制字符/零宽字符/孤立代理项，换行合并为逗号防止提前触发 Enter 连发
export function sanitizeOutboundText(text) {
  return String(text ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/\s*[\r\n]+\s*/g, "，")
    .replace(/，{2,}/g, "，")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// 分段拟人键入计划：2~4 字一段 + 标点微顿，消除 0ms 整句瞬时注入特征
export function planTypingBursts(text, rand = Math.random) {
  const chars = Array.from(sanitizeOutboundText(text));
  const bursts = [];
  for (let i = 0; i < chars.length;) {
    const size = Math.min(chars.length - i, 2 + Math.floor(rand() * 3));
    const chunk = chars.slice(i, i + size).join("");
    i += size;
    const isLast = i >= chars.length;
    const punctBonus = /[，。！？,~～]/.test(chunk[chunk.length - 1]) ? 110 : 0;
    const delayMs = isLast
      ? Math.round(110 + rand() * 90)
      : Math.round(65 + rand() * 105 + punctBonus);
    bursts.push({ text: chunk, delayMs });
  }
  return bursts;
}

// 识别小红书混在 .chat-item 里的系统提示、时间戳与限流警告
export function classifySystemText(rawText) {
  const s = String(rawText ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (TIMESTAMP_TEXT_RE.test(s)) return { kind: "noise", reason: "timestamp" };
  if (LIMIT_SYSTEM_RE.test(s)) return { kind: "limit", reason: s };
  if (UNSUPPORTED_MSG_RE.test(s)) return { kind: "unsupported", text: "[对方发来手机端专属消息或语音]" };
  if (NOISE_SYSTEM_RE.test(s)) return { kind: "noise", reason: "system_tip" };
  return null;
}

// 纯函数：把页面提取的原始快照归一为安全结构（支持离线单测）
export function normalizeChatSnapshot(raw = {}) {
  const convs = [];
  const seenConvIds = new Set();
  for (const c of raw.convs || []) {
    const userId = normalizeConvId(c.userId);
    const nickname = String(c.nickname || "").trim();
    if (!userId || seenConvIds.has(userId) || OFFICIAL_CONV_NAME_RE.test(nickname)) continue;
    seenConvIds.add(userId);
    convs.push({
      userId,
      nickname,
      summary: String(c.summary || "").trim(),
      unread: Number(c.unread) > 0 ? Number(c.unread) : 0,
      hasUnreadDot: Boolean(c.hasUnreadDot)
    });
  }

  let activeUserId = normalizeConvId(raw.activeUserId);
  if (!activeUserId && raw.pathname) {
    const m = String(raw.pathname).match(/\/chat\/([^/?#]+)/);
    if (m?.[1]) activeUserId = normalizeConvId(m[1]);
  }

  const messages = [];
  let platformLimitReason = "";
  let limitCount = 0;
  for (const item of raw.rawItems || []) {
    const isOther = Boolean(item.isOther);
    const isSelf = Boolean(item.isSelf);
    const candidateText = String(item.bubbleText || item.fallbackText || "").replace(/\s+/g, " ").trim();
    const sys = classifySystemText(candidateText);
    if (!isOther && !isSelf) {
      if (sys?.kind === "limit") {
        platformLimitReason = sys.reason;
        limitCount++;
        continue;
      }
      if (sys?.kind === "noise") continue;
    }
    if (!item.msgId) continue;

    let text = String(item.bubbleText || "").trim();
    if (sys?.kind === "unsupported") {
      text = sys.text;
    } else if (!text && item.hasCard) {
      text = item.cardTitle ? `[笔记卡片: ${String(item.cardTitle).trim()}]` : "[笔记卡片]";
    } else if (!text && item.hasImage) {
      text = "[图片消息]";
    } else if (!text) {
      text = candidateText;
    }

    if (isOther || isSelf) {
      platformLimitReason = "";
    }
    messages.push({
      msgId: String(item.msgId),
      type: String(item.contentType || "text"),
      isOther,
      isSelf,
      hasError: Boolean(item.hasError),
      text
    });
  }

  const hasConvOrEditor = (raw.convs?.length || 0) > 0 || Boolean(raw.hasEditor);
  const blocked = Boolean(
    raw.blocked ||
    raw.hasLoginInput ||
    raw.hasRiskModal ||
    (!hasConvOrEditor && BLOCKED_BODY_RE.test(String(raw.bodyText || "")))
  );

  return {
    blocked,
    activeUserId: activeUserId || null,
    headerName: String(raw.headerName || "").trim(),
    convs,
    messages,
    platformLimitReason,
    limitCount
  };
}

export async function readChatSnapshot(page) {
  const raw = await page.evaluate(() => {
    const hasLoginInput = Boolean(document.querySelector('input[name="xhs-pc-web-phone"]'));
    const hasRiskModal = [...document.querySelectorAll('[class*="captcha" i], [class*="red-captcha" i], [class*="verify-modal" i], [class*="login-container" i]')]
      .some(el => {
        const st = getComputedStyle(el);
        const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 1, height: 1 };
        return st.display !== "none" && st.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
    const hasEditor = Boolean(document.querySelector('div.xhs-im-input-bar-editor[contenteditable="true"], [class*="xhs-im-input-bar-editor"][contenteditable="true"], #jarvis-reply-textarea'));
    const bodyText = document.body?.innerText || "";

    let convNodes = [...document.querySelectorAll('.xhs-im-conv-item[data-conv-kind="c2c"]')];
    if (convNodes.length === 0) {
      convNodes = [...document.querySelectorAll(".xhs-im-conv-item, .sx-contact-item")];
    }
    const convs = convNodes.map(el => {
      const isActive =
        el.classList.contains("xhs-im-conv-item--active") ||
        el.classList.contains("active") ||
        el.getAttribute("aria-selected") === "true";
      const badgeTexts = [...el.querySelectorAll('.xhs-im-conv-item__badge, [class*="unread" i], [class*="badge" i]')]
        .map(b => (b.textContent || "").trim());
      const unreadNum = badgeTexts.map(t => (/^\d+$/.test(t) ? Number(t) : 0)).find(n => n > 0) || 0;
      const hasDot = !isActive && (
        unreadNum > 0 ||
        Boolean(el.querySelector('.xhs-im-conv-item__badge, [class*="unread-dot" i], [class*="red-dot" i], [data-unread="1"]')) ||
        el.getAttribute("data-unread") === "1"
      );
      return {
        userId: el.getAttribute("data-conv-id") || el.getAttribute("data-id") || el.getAttribute("data-uid") || "",
        nickname: el.querySelector('.xhs-im-conv-item__name, [class*="nickname" i], [class*="name" i]')?.textContent?.trim() || "",
        summary: el.querySelector('.xhs-im-conv-item__summary-text, [class*="summary" i]')?.textContent?.trim() || "",
        unread: unreadNum,
        hasUnreadDot: hasDot,
        isActive
      };
    });

    const activeConv = convNodes.find(el =>
      el.classList.contains("xhs-im-conv-item--active") ||
      el.classList.contains("active") ||
      el.getAttribute("aria-selected") === "true"
    );
    const headerName =
      document.querySelector('.xhs-im-chat-window__header-name, .xhs-im-chat-title, [class*="chat-window" i] [class*="header" i] [class*="name" i]')
        ?.textContent?.trim() || "";

    const rawItems = [...document.querySelectorAll(".chat-item, .im-msg-item")].map(el => {
      const card = el.querySelector('.card_container, [class*="card-container" i]');
      const nonAvatarImgs = [...el.querySelectorAll("img")].filter(img => !img.closest('[class*="avatar" i]'));
      return {
        msgId: el.getAttribute("data-message-id") || el.getAttribute("data-id") || "",
        contentType: (el.getAttribute("data-content-type") || el.getAttribute("data-msg-type") || "").toLowerCase(),
        isOther: Boolean(el.querySelector('.chat-item__bubble--other, .chat-item__content--left, [class*="bubble--other" i], [class*="content--left" i]')),
        isSelf: Boolean(el.querySelector('.chat-item__bubble--me, .chat-item__content--right, [class*="bubble--me" i], [class*="content--right" i]')),
        hasError: Boolean(el.querySelector('[class*="fail" i], [class*="error" i], [class*="resend" i], [title*="失败"], [aria-label*="失败"]')),
        bubbleText: el.querySelector(".xhs-im-bubble__text, .text-message")?.innerText?.trim() || "",
        hasCard: Boolean(card),
        cardTitle: card?.querySelector('.card_bottom_title, [class*="card-title" i], [class*="card-info" i]')?.innerText?.trim() || "",
        hasImage: nonAvatarImgs.length > 0,
        fallbackText: el.innerText?.trim() || ""
      };
    });

    return {
      hasLoginInput,
      hasRiskModal,
      hasEditor,
      bodyText,
      pathname: location.pathname || "",
      activeUserId: activeConv?.getAttribute("data-conv-id") || activeConv?.getAttribute("data-id") || "",
      headerName,
      convs,
      rawItems
    };
  });
  return normalizeChatSnapshot(raw);
}

// 条件等待切换会话：确认激活会话真正切到目标 userId 后再返回，杜绝死等 800ms 读串上一会话气泡
export async function openConversationVerified(page, userId, { timeoutMs = 2600 } = {}) {
  const targetId = normalizeConvId(userId);
  if (!targetId) return false;
  const clicked = await page.evaluate((uid) => {
    const norm = (raw) => {
      let s = String(raw || "").trim();
      for (const p of ["Total-", "Active-", "User-", "Contact-", "User_", "Contact_"]) {
        if (s.startsWith(p)) { s = s.slice(p.length); break; }
      }
      return s.replace(/[^a-zA-Z0-9._-]/g, "");
    };
    const el = [...document.querySelectorAll(".xhs-im-conv-item, .sx-contact-item")].find(node =>
      norm(node.getAttribute("data-conv-id") || node.getAttribute("data-id") || node.getAttribute("data-uid")) === uid
    );
    if (!el) return false;
    el.scrollIntoView?.({ block: "nearest" });
    el.click();
    return true;
  }, targetId);
  if (!clicked) return false;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(120);
    const snap = await readChatSnapshot(page);
    if (snap.blocked) return false;
    if (snap.activeUserId === targetId) {
      await page.waitForTimeout(120);
      return true;
    }
  }
  return false;
}

async function insertChunk(page, text) {
  if (page.keyboard?.insertText) {
    await page.keyboard.insertText(text);
  } else {
    await page.cdp("Input.insertText", { text });
  }
}

async function pressEnter(page) {
  if (page.keyboard?.press) {
    await page.keyboard.press("Enter");
  } else {
    await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }
}

// 四道闸门 + 三态机械验收发信（confirmed / rejected / uncertain / aborted_*）
export async function sendMessageVerified(
  page,
  { expectedUserId, text, baselineMsgIds = [], knownOtherIds = [], rand = Math.random, verifyAttempts = 10, verifyIntervalMs = 380 }
) {
  const cleanText = sanitizeOutboundText(text);
  if (!cleanText) return { status: "failed_before_submit", reason: "empty_text", sentIds: [], tempIds: [] };
  const targetUserId = normalizeConvId(expectedUserId);

  // 闸门 1：校验会话归属、清空残留草稿并折叠光标选区
  const prep = await page.evaluate((uid) => {
    const norm = (raw) => {
      let s = String(raw || "").trim();
      for (const p of ["Total-", "Active-", "User-", "Contact-", "User_", "Contact_"]) {
        if (s.startsWith(p)) { s = s.slice(p.length); break; }
      }
      return s.replace(/[^a-zA-Z0-9._-]/g, "");
    };
    const activeEl = document.querySelector('.xhs-im-conv-item--active, .xhs-im-conv-item.active, .xhs-im-conv-item[aria-selected="true"]');
    const pathMatch = (location.pathname || "").match(/\/chat\/([^/?#]+)/);
    const activeId = norm(activeEl?.getAttribute("data-conv-id") || activeEl?.getAttribute("data-id") || pathMatch?.[1] || "");
    if (uid && activeId !== uid) return { ok: false, status: "aborted_drift", activeId };

    const selectors = [
      'div.xhs-im-input-bar-editor[contenteditable="true"]',
      '[class*="xhs-im-input-bar-editor"][contenteditable="true"]',
      "#jarvis-reply-textarea"
    ];
    const ed = selectors.map(s => document.querySelector(s)).find(Boolean);
    if (!ed) return { ok: false, status: "failed_before_submit", reason: "editor_not_found" };

    ed.focus();
    if (ed.tagName === "TEXTAREA" || ed.tagName === "INPUT") {
      ed.value = "";
      ed.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      while (ed.firstChild) ed.removeChild(ed.firstChild);
      ed.dispatchEvent(new InputEvent("input", { bubbles: true }));
      try {
        const sel = window.getSelection?.();
        const range = document.createRange?.();
        if (sel && range) {
          range.selectNodeContents(ed);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch {}
    }
    return { ok: true };
  }, targetUserId);

  if (!prep.ok) {
    return { status: prep.status, reason: prep.reason || "conv_drift", sentIds: [], tempIds: [] };
  }

  // 闸门 2：分段拟人键入
  for (const burst of planTypingBursts(cleanText, rand)) {
    await insertChunk(page, burst.text);
    if (burst.delayMs > 0) await page.waitForTimeout(burst.delayMs);
  }

  // 闸门 3：提交前最后一毫秒原子复核（防会话漂移串台 + 防打字期间新消息抢答 + 草稿回显一致性）
  const gate = await page.evaluate(({ uid, expectedDraft, knownOther, limitSource }) => {
    const norm = (raw) => {
      let s = String(raw || "").trim();
      for (const p of ["Total-", "Active-", "User-", "Contact-", "User_", "Contact_"]) {
        if (s.startsWith(p)) { s = s.slice(p.length); break; }
      }
      return s.replace(/[^a-zA-Z0-9._-]/g, "");
    };
    const selectors = [
      'div.xhs-im-input-bar-editor[contenteditable="true"]',
      '[class*="xhs-im-input-bar-editor"][contenteditable="true"]',
      "#jarvis-reply-textarea"
    ];
    const ed = selectors.map(s => document.querySelector(s)).find(Boolean);
    const clearEd = () => {
      if (!ed) return;
      if (ed.tagName === "TEXTAREA" || ed.tagName === "INPUT") {
        ed.value = "";
        ed.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        while (ed.firstChild) ed.removeChild(ed.firstChild);
        ed.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
    };
    if (!ed) return { action: "abort", status: "failed_before_submit", reason: "editor_lost" };

    const activeEl = document.querySelector('.xhs-im-conv-item--active, .xhs-im-conv-item.active, .xhs-im-conv-item[aria-selected="true"]');
    const pathMatch = (location.pathname || "").match(/\/chat\/([^/?#]+)/);
    const activeId = norm(activeEl?.getAttribute("data-conv-id") || activeEl?.getAttribute("data-id") || pathMatch?.[1] || "");
    if (uid && activeId !== uid) {
      clearEd();
      return { action: "abort", status: "aborted_drift", reason: `active=${activeId}` };
    }

    const knownSet = new Set(knownOther || []);
    const limitRe = new RegExp(limitSource);
    const chatItems = [...document.querySelectorAll(".chat-item, .im-msg-item")];
    const lateOther = chatItems.some(el => {
      const id = el.getAttribute("data-message-id") || el.getAttribute("data-id") || "";
      const isOther = Boolean(el.querySelector('.chat-item__bubble--other, .chat-item__content--left, [class*="bubble--other" i], [class*="content--left" i]'));
      return id && isOther && !knownSet.has(id);
    });
    if (lateOther) {
      clearEd();
      return { action: "abort", status: "aborted_new_msg", reason: "incoming_arrived_during_typing" };
    }
    const priorLimitCount = chatItems.filter(el => {
      const isOther = Boolean(el.querySelector('.chat-item__bubble--other, .chat-item__content--left, [class*="bubble--other" i], [class*="content--left" i]'));
      const isSelf = Boolean(el.querySelector('.chat-item__bubble--me, .chat-item__content--right, [class*="bubble--me" i], [class*="content--right" i]'));
      return !isOther && !isSelf && limitRe.test(String(el.innerText || "").replace(/\s+/g, " ").trim());
    }).length;

    const draft = String(ed.value ?? ed.innerText ?? "").replace(/\s+/g, " ").trim();
    const target = String(expectedDraft).replace(/\s+/g, " ").trim();
    if (draft !== target) {
      clearEd();
      return { action: "abort", status: "failed_before_submit", reason: `draft_mismatch:${draft.slice(0, 20)}` };
    }

    ed.focus();
    const sendBtn = document.querySelector('button.send_btn:not([disabled]), .xhs-im-input-bar button[aria-label*="发送"]:not([disabled])');
    if (sendBtn) {
      sendBtn.click();
      return { action: "clicked_button", priorLimitCount };
    }
    return { action: "press_enter", priorLimitCount };
  }, { uid: targetUserId, expectedDraft: cleanText, knownOther: knownOtherIds, limitSource: LIMIT_SYSTEM_RE.source });

  if (gate.action === "abort") {
    return { status: gate.status, reason: gate.reason, cleanText, sentIds: [], tempIds: [] };
  }
  if (gate.action === "press_enter") {
    await pressEnter(page);
  }

  // 闸门 4：提交后三态机械验收（confirmed / rejected / uncertain，uncertain 严禁调用方自动重发）
  const beforeSet = new Set(baselineMsgIds);
  const priorLimitCount = Number(gate.priorLimitCount) || 0;
  let lastTempIds = [];
  for (let attempt = 0; attempt < verifyAttempts; attempt++) {
    await page.waitForTimeout(verifyIntervalMs);
    const snap = await readChatSnapshot(page);
    if (targetUserId && snap.activeUserId && snap.activeUserId !== targetUserId) {
      return { status: "uncertain", reason: "conv_switched_during_verify", cleanText, sentIds: [], tempIds: lastTempIds };
    }
    const newSelf = snap.messages.filter(m => m.isSelf && m.msgId && !beforeSet.has(m.msgId));
    if (newSelf.some(m => m.hasError)) {
      return { status: "rejected", reason: "bubble_send_error", cleanText, sentIds: [], tempIds: [] };
    }
    if (snap.platformLimitReason && ((snap.limitCount || 0) > priorLimitCount || newSelf.length > 0)) {
      return { status: "rejected", reason: snap.platformLimitReason, cleanText, sentIds: [], tempIds: [] };
    }
    const formalIds = newSelf.filter(m => !TEMP_MSG_ID_RE.test(m.msgId)).map(m => m.msgId);
    lastTempIds = newSelf.filter(m => TEMP_MSG_ID_RE.test(m.msgId)).map(m => m.msgId);
    if (formalIds.length > 0) {
      return { status: "confirmed", cleanText, sentIds: formalIds, tempIds: lastTempIds };
    }
  }

  const editorRemains = await page.evaluate((uid) => {
    const norm = (raw) => {
      let s = String(raw || "").trim();
      for (const p of ["Total-", "Active-", "User-", "Contact-", "User_", "Contact_"]) {
        if (s.startsWith(p)) { s = s.slice(p.length); break; }
      }
      return s.replace(/[^a-zA-Z0-9._-]/g, "");
    };
    const activeEl = document.querySelector('.xhs-im-conv-item--active, .xhs-im-conv-item.active, .xhs-im-conv-item[aria-selected="true"]');
    const pathMatch = (location.pathname || "").match(/\/chat\/([^/?#]+)/);
    const activeId = norm(activeEl?.getAttribute("data-conv-id") || activeEl?.getAttribute("data-id") || pathMatch?.[1] || "");
    if (uid && activeId && activeId !== uid) return "";
    const ed = document.querySelector('div.xhs-im-input-bar-editor[contenteditable="true"], [class*="xhs-im-input-bar-editor"][contenteditable="true"], #jarvis-reply-textarea');
    const txt = String(ed?.value ?? ed?.innerText ?? "").trim();
    if (ed && txt) {
      if (ed.tagName === "TEXTAREA" || ed.tagName === "INPUT") ed.value = "";
      else while (ed.firstChild) ed.removeChild(ed.firstChild);
      ed.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return txt;
  }, targetUserId);

  if (lastTempIds.length > 0 && !editorRemains) {
    return { status: "confirmed", cleanText, sentIds: [], tempIds: lastTempIds };
  }
  return { status: "uncertain", reason: "no_echo_after_submit", cleanText, sentIds: [], tempIds: lastTempIds };
}
