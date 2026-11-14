/**
 * 纯函数工具：把 Host 的会话事件流渲染成适合企业微信阅读的文本。
 *
 * 不依赖 DSH 运行时，不产生副作用——单测与插件主体共用同一份实现。
 */

/** 从 content 中取出全部文本块（content 可能是字符串，也可能是块数组） */
export function textOf(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/** readSession 的返回兼容数组和 { events } 两种形态 */
export function eventsOf(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.events)) return result.events;
  return [];
}

/** 事件里最大的 seq（用于判断「这一轮」从哪开始），没有则 -1 */
export function maxSeq(result) {
  let max = -1;
  for (const event of eventsOf(result)) {
    const seq = Number(event?.seq ?? event?.event?.seq ?? -1);
    if (seq > max) max = seq;
  }
  return max;
}

/** 取 seq 大于 afterSeq 的最后一条 assistant 文本 */
export function extractAssistant(result, afterSeq = -1) {
  const events = eventsOf(result);
  let text = '';
  for (const event of events) {
    const seq = Number(event?.seq ?? event?.event?.seq ?? -1);
    if (seq <= afterSeq) continue;
    const type = event?.type ?? event?.event?.type;
    if (type !== 'assistant/message') continue;
    const data = event?.data ?? event?.event?.data ?? {};
    const candidate = textOf(data.message?.content ?? data.content);
    if (candidate) text = candidate;
  }
  return text;
}

/** 从事件流里抽出可读对话（只保留真人输入与助手回复，丢掉注入上下文与工具噪声） */
export function extractTranscript(result) {
  const messages = [];
  let tools = 0;
  for (const event of eventsOf(result)) {
    const type = event?.type ?? event?.event?.type;
    const data = event?.data ?? event?.event?.data ?? {};
    if (type === 'user/message') {
      const kind = data.source?.kind;
      if (kind && kind !== 'user') continue; // 运行时注入的上下文不算对话
      const text = textOf(data.content).trim();
      if (text) messages.push({ role: 'user', text });
    } else if (type === 'assistant/message') {
      const text = textOf(data.message?.content ?? data.content).trim();
      if (text) messages.push({ role: 'assistant', text });
    } else if (type === 'tool/call') {
      tools += 1;
    }
  }
  return { messages, tools };
}

/** 渲染成企业微信里好读的样子（只显示最后 limit 条） */
export function formatTranscript(result, { limit = 8, maxChars = 700 } = {}) {
  const { messages, tools } = extractTranscript(result);
  if (!messages.length) return '这条会话里没有可读对话（可能只有工具调用或系统事件）。';
  const shown = messages.slice(-limit);
  const head = shown.length < messages.length ? `（共 ${messages.length} 条，这里显示最后 ${shown.length} 条）\n\n` : '';
  const body = shown
    .map((message) => {
      const text = message.text.length > maxChars ? `${message.text.slice(0, maxChars)}…` : message.text;
      return `${message.role === 'user' ? '【你】' : '【DSH】'}${text}`;
    })
    .join('\n\n');
  const tail = tools ? `\n\n（另有 ${tools} 次工具调用未展开）` : '';
  return `${head}${body}${tail}`;
}

/* ---------------- listSessions 行结构的兼容读取 ---------------- */

/** 实测行结构：{ header: { id, cwd, createdAt, ... }, live, persisted, formatStatus } */
export const rowId = (row) => row?.header?.id ?? row?.id ?? row?.sessionId;
export const rowCwd = (row) => row?.header?.cwd ?? row?.cwd ?? row?.workingDirectory ?? '';
export const rowLive = (row) => Boolean(row?.live);
export const rowTime = (row) => row?.header?.createdAt ?? row?.updatedAt ?? 0;

/** 渲染会话列表（最多 15 条），titles 与 rows 按下标对齐 */
export function formatSessionList(rows, titles = []) {
  if (!Array.isArray(rows) || !rows.length) return '这个 Host 里没有会话。';
  const shortId = (id) => {
    const text = String(id ?? '');
    return /^session-[0-9a-f]{8}/.test(text) ? `${text.slice(0, 16)}…` : text;
  };
  return rows
    .slice(0, 15)
    .map((row, index) => {
      const when = rowTime(row) ? new Date(rowTime(row)).toLocaleString('zh-CN', { hour12: false }) : '';
      const flags = [rowLive(row) ? '运行中' : '未激活', row?.persisted ? '已落盘' : ''].filter(Boolean).join(' · ');
      const status = row?.formatStatus && row.formatStatus !== 'current' ? ` · ${row.formatStatus}` : '';
      const title = String(titles[index] ?? '').trim() || '（未命名）';
      const meta = [when, flags, status.replace(/^ · /, '')].filter(Boolean).join(' · ');
      return `${index + 1}. ${title} — ${shortId(rowId(row))}\n   ${meta} · ${rowCwd(row)}`;
    })
    .join('\n');
}
