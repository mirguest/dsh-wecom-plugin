/**
 * dsh-wecom-plugin —— 在 DSH Desktop Host 内部提供企业微信通道。
 *
 * 阶段一（本文件）：验证插件能在 Host 内启动，并用 ctx.sessionQuery.listSessions()
 * 做**只读**会话发现——列的就是 Desktop 里那些会话，因为跑在同一个进程、同一个 Agent Runtime。
 *
 * 为什么必须是"进程内插件"：Desktop 的会话被本进程的 Agent 持有写句柄，
 * 另一个进程（原来的 dsh-wecom bridge）无论如何 resume 都会被拒。
 * 只有在 Host 内，才能既看到会话、又不违反"同一个 Session 不被多进程写"。
 *
 * 后续阶段：
 *   阶段二 /use <sessionId> → 绑定
 *   阶段三 通过 agents/controller 续聊，两端共享同一条会话
 */
import { AibotClient, generateReqId } from './aibot.mjs';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const name = 'wecom-bridge';
/** 只依赖会话查询服务；agents/approval 在后续阶段按需注入 */
export const inject = ['sessionQuery'];

const say = (...args) => console.log('[wecom-bridge]', ...args);

/* ---------------- 会话读写的小工具（对外只为单测暴露 extractAssistant） ---------------- */

const textOf = (content) => {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
};

/** readSession 的返回兼容数组和 { events } 两种形态 */
export function eventsOf(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.events)) return result.events;
  return [];
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

/** 会话里当前最大 seq（用于判断"这一轮"从哪开始） */
export function maxSeq(result) {
  let max = -1;
  for (const event of eventsOf(result)) {
    const seq = Number(event?.seq ?? event?.event?.seq ?? -1);
    if (seq > max) max = seq;
  }
  return max;
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

/**
 * 桌面版是打包 GUI，主进程 stdout 通常看不到。
 * 所以把加载过程的每一步都落到 ~/.dsh/wecom-plugin.log，便于事后确认"到底加载了没有"。
 */
const LOG_PATH = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'wecom-plugin.log');
export function bootLog(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    mkdirSync(join(LOG_PATH, '..'), { recursive: true });
    appendFileSync(LOG_PATH, line, 'utf8');
  } catch {
    /* 落盘失败就算了，不影响主流程 */
  }
  say(message);
}

bootLog(`module imported (pid ${process.pid}, node ${process.version})`);


/** 实测行结构：{ header: { id, cwd, createdAt, ... }, live, persisted, formatStatus } */
const rowId = (row) => row?.header?.id ?? row?.id ?? row?.sessionId;
const rowCwd = (row) => row?.header?.cwd ?? row?.cwd ?? row?.workingDirectory ?? '';
const rowLive = (row) => Boolean(row?.live);
const rowTime = (row) => row?.header?.createdAt ?? row?.updatedAt ?? 0;

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

export function apply(ctx, config = {}) {
  // 配置既可以从 profile 的 cordis.patch.yml 来，也可以走环境变量——
  // 后者不依赖 loader 对 Config schema 的校验，作为兜底通道。
  const botId = config.botId || process.env.DSH_WECOM_BOT_ID || '';
  const secret = config.secret || process.env.DSH_WECOM_SECRET || '';
  const wsUrl = config.wsUrl || process.env.DSH_WECOM_WS_URL || '';
  const allowUsers = config.allowUsers?.length ? config.allowUsers : (process.env.DSH_WECOM_ALLOW_USERS || '').split(',').filter(Boolean);

  bootLog(`apply() called; botId=${botId ? 'set' : 'MISSING'} secret=${secret ? 'set' : 'MISSING'} allowUsers=${allowUsers.join('|') || '(空)'}`);
  if (!botId || !secret) {
    bootLog('缺少 botId / secret，插件不启动');
    return;
  }

  const client = new AibotClient({
    botId,
    secret,
    wsUrl: wsUrl || undefined,
    log: { info: (...a) => say(...a), warn: (...a) => say(...a), error: (...a) => say(...a), debug: () => {} },
  });

  /** 每条入站消息的流式回复上下文 */
  const ctxOf = new Map();
  /** 企业微信用户 -> 绑定的 DSH 会话 */
  const bound = new Map();
  /** 企业微信用户 -> 最近一次 /sessions 的结果 */
  const listed = new Map();
  /** agents 服务（Host 内的 Agent 注册表）；取不到就退化成只读 */
  const agents = ctx.get?.('agents');
  client.on('message', (message) => {
    ctxOf.set(message.FromUserName, { reqId: message.reqId, streamId: generateReqId('stream'), chatid: message.chatId || message.FromUserName });
    void handle(message).catch((error) => say('处理失败:', error?.message ?? error));
  });

  const reply = async (userId, text, final = true) => {
    const c = ctxOf.get(userId);
    if (!c) return;
    await client.replyStream(c.reqId, c.streamId, text, final);
  };

  const provider = config.provider || 'deepseek-official';
  const model = config.model || 'deepseek-flash';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 主动消息：审批提示不能复用某条入站消息的流式气泡 */
  const notify = async (userId, text) => {
    const c = ctxOf.get(userId);
    await client.sendMarkdown(c?.chatid ?? userId, text);
  };

  /* ---------------- 审批转发 ---------------- */

  const APPROVE = new Set(['1', 'y', 'yes', '允许', '同意', '批准', 'allow']);
  const DENY = new Set(['2', 'n', 'no', '拒绝', 'deny', 'reject']);
  const approvals = new Map(); // userId -> { resolve }

  /**
   * 应答者是 approval/request waterfall 的监听器：返回结果即代为作答，
   * 否则 next() 交回桌面端原有的应答链。
   * 只接管「已绑定到该会话」的那位用户，其余一律放行给桌面 UI。
   */
  ctx.on('approval/request', async (req, next) => {
    const sessionId = req?.agent?.session?.id ?? req?.agent?.id ?? req?.sessionId;
    const userId = [...bound.entries()].find(([, id]) => id === sessionId)?.[0];
    if (!userId) return next();

    const tool = req?.tool?.name ?? req?.tool ?? req?.toolName ?? '敏感操作';
    const reason = req?.displayReason ?? req?.reason ?? '';
    bootLog(`审批请求 session=${sessionId} tool=${tool}`);
    await notify(userId, `⚠️ 需要你审批\n工具：${tool}${reason ? `\n原因：${reason}` : ''}\n\n回复 1 = 允许一次\n回复 2 = 拒绝（3 分钟不回复按取消）`);

    const outcome = await new Promise((resolve) => {
      const finish = (value) => {
        approvals.delete(userId);
        resolve(value);
      };
      const timer = setTimeout(() => finish('cancelled'), 180_000);
      approvals.set(userId, {
        resolve: (value) => {
          clearTimeout(timer);
          finish(value);
        },
      });
      req?.signal?.addEventListener?.(
        'abort',
        () => {
          clearTimeout(timer);
          finish('cancelled');
        },
        { once: true },
      );
    });

    bootLog(`审批结果 ${tool} -> ${outcome}`);
    return outcome;
  });

  /** 拿 Host 内的 Agent：live 的直接取，冷的走 agents.resume（同一进程、同一条会话） */
  async function getAgent(sessionId) {
    if (!agents) throw new Error('Host 内没有 agents 服务，无法续聊');
    const existing = agents.get?.(sessionId);
    if (existing) return existing;
    bootLog(`resume 会话 ${sessionId}（provider=${provider} model=${model}）`);
    const { handle } = await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider, model },
    });
    return handle.agent;
  }

  /** 会话标题（Host 折叠后的最新标题）；拿不到就返回空串，不影响列表 */
  async function titlesFor(rows) {
    const ids = rows.map((row) => rowId(row));
    try {
      const snaps = await ctx.sessionQuery.readTitleSnapshots(ids);
      if (Array.isArray(snaps)) return ids.map((_, i) => snaps[i]?.title ?? '');
      if (snaps && typeof snaps === 'object') return ids.map((id) => snaps[id]?.title ?? '');
    } catch (error) {
      bootLog(`readTitleSnapshots 失败：${error.message}`);
    }
    return ids.map(() => '');
  }

  async function sessionListText() {
    const rows = (await ctx.sessionQuery.listSessions()) ?? [];
    const titles = await titlesFor(rows);
    return { rows, text: formatSessionList(rows, titles) };
  }

  /** 把一句话投进会话，等这一轮结束，返回助手文本 */
  async function promptSession(userId, sessionId, text) {
    const before = await ctx.sessionQuery.readSession(sessionId).catch(() => null);
    const baseline = maxSeq(before);
    const baseCount = eventsOf(before).length;
    const agent = await getAgent(sessionId);

    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    };
    agent.followup(message);
    bootLog(`已投递到 ${sessionId}（baseline=${baseline} count=${baseCount}）`);
    await reply(userId, '已投递到该会话，等待这一轮结束…', false);

    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await sleep(1500);
      let changed = false;
      try {
        const light = await ctx.sessionQuery.listEvents(sessionId);
        // listEvents 是轻量记录：有 seq 就用 seq，没有就退回比较条数
        changed = maxSeq(light) > baseline || eventsOf(light).length > baseCount;
      } catch (error) {
        bootLog(`listEvents 失败：${error.message}`);
      }
      if (!changed) continue;
      const full = await ctx.sessionQuery.readSession(sessionId).catch(() => null);
      const ended = eventsOf(full).some(
        (event) => (event?.type ?? event?.event?.type) === 'turn/end' && Number(event?.seq ?? event?.event?.seq) > baseline,
      );
      if (!ended) continue;
      const answer = extractAssistant(full, baseline);
      await reply(userId, answer || '（这一轮结束了，但没有可显示的助手文本）');
      return;
    }
    await reply(userId, '等待超时（3 分钟）。任务可能还在跑，可以到桌面端查看进度。');
  }

  async function handle(message) {
    const userId = message.FromUserName;
    if (!userId) return;
    if (allowUsers.length && !allowUsers.includes(userId)) {
      await reply(userId, '你没有权限使用这个机器人。').catch(() => {});
      return;
    }
    const text = String(message.Content ?? '').trim();
    if (!text) return;

    // 有待审批时，这条消息优先当投票
    const pendingApproval = approvals.get(userId);
    if (pendingApproval) {
      const key = text.toLowerCase();
      if (APPROVE.has(key)) {
        pendingApproval.resolve('allowed-once');
        await reply(userId, '✅ 已允许这一次。').catch(() => {});
        return;
      }
      if (DENY.has(key)) {
        pendingApproval.resolve('rejected');
        await reply(userId, '🚫 已拒绝。').catch(() => {});
        return;
      }
      await notify(userId, '这条是待审批的操作，请回复 1（允许一次）或 2（拒绝）。').catch(() => {});
      return;
    }

    if (text === '/help' || text === '/帮助') {
      await reply(userId, HELP);
      return;
    }
    if (text === '/id') {
      await reply(userId, `企业微信 UserID：${userId}\nHost：DSH Desktop（进程内插件）`);
      return;
    }
    if (text === '/ping') {
      await reply(userId, 'pong（插件已加载在 Desktop Host 内）');
      return;
    }
    if (text === '/sessions' || text === '/列表') {
      const { rows, text: listText } = await sessionListText();
      listed.set(userId, rows);
      bootLog(`listSessions -> ${rows.length} 行（含标题）`);
      await reply(userId, `DSH Desktop 会话（${rows.length} 条）：\n\n${listText}\n\n看某条聊了什么：/read <序号>；绑定：/use <序号>`);
      return;
    }
    if (text.startsWith('/use ') || text === '/use') {
      const arg = text.slice(4).trim();
      if (!arg) {
        await reply(userId, '用法：/use <序号|sessionId>（先发 /sessions 拿列表）');
        return;
      }
      const rows = listed.get(userId) ?? (await ctx.sessionQuery.listSessions());
      listed.set(userId, rows);
      let picked = null;
      if (/^\d+$/.test(arg)) picked = rows[Number(arg) - 1] ?? null;
      else picked = rows.find((row) => rowId(row) === (arg.startsWith('session-') ? arg : `session-${arg}`)) ?? null;
      if (!picked) {
        await reply(userId, '没找到这条会话。先发 /sessions，或用完整的 sessionId。');
        return;
      }
      const id = rowId(picked);
      bound.set(userId, id);
      let live = false;
      try {
        live = Boolean(agents?.get?.(id));
      } catch {
        live = false;
      }
      await reply(
        userId,
        `已绑定：${id}\n状态：${rowLive(picked) ? '运行中（桌面端正在用它）' : '未激活'}` +
          `\n${live ? 'Host 内已持有它的 Agent 句柄。' : 'Host 内暂无 Agent 句柄，需要时再恢复。'}` +
          '\n（续聊在阶段三接入）',
      );
      return;
    }
    if (text.startsWith('/read ') || text === '/read') {
      const [target, countArg] = text.replace('/read', '').trim().split(/\s+/);
      if (!target) {
        await reply(userId, '用法：/read <序号|sessionId> [条数]\n先发 /sessions 拿列表。');
        return;
      }
      const rows = listed.get(userId) ?? (await ctx.sessionQuery.listSessions());
      listed.set(userId, rows);
      const picked = /^\d+$/.test(target)
        ? rows[Number(target) - 1]
        : rows.find((row) => rowId(row) === (target.startsWith('session-') ? target : `session-${target}`));
      if (!picked) {
        await reply(userId, '没找到这条会话。先发 /sessions，或用完整的 sessionId。');
        return;
      }
      const limit = Math.min(Math.max(Number(countArg) || 8, 1), 30);
      const id = rowId(picked);
      await reply(userId, `读取 ${id} …`, false);
      try {
        const result = await ctx.sessionQuery.readSession(id);
        await reply(userId, `会话 ${id}\n${rowCwd(picked)}\n\n${formatTranscript(result, { limit })}`);
      } catch (error) {
        await reply(userId, `读取失败：${error.message}`);
      }
      return;
    }
    if (text === '/status' || text === '/状态') {
      const id = bound.get(userId);
      if (!id) {
        await reply(userId, '还没有绑定会话。先 /sessions，再 /use <序号>。');
        return;
      }
      const rows = await ctx.sessionQuery.listSessions();
      const row = (rows ?? []).find((item) => rowId(item) === id);
      await reply(
        userId,
        `绑定会话：${id}\n${row ? (rowLive(row) ? '运行中' : '未激活') + ' · ' + rowCwd(row) : '（列表里暂时看不到它）'}`,
      );
      return;
    }
    if (text === '/unuse') {
      bound.delete(userId);
      await reply(userId, '已解除绑定。');
      return;
    }
    if (text === '/debug') {
      // 用于核对当前安装版本的结构：只看字段名与样例，不改任何东西
      const rows = await ctx.sessionQuery.listSessions();
      const first = rows?.[0];
      const keys = first ? Object.keys(first) : [];
      let titleSample = '（未取到）';
      try {
        const snaps = await ctx.sessionQuery.readTitleSnapshots(rows?.length ? [rowId(first)] : []);
        titleSample = JSON.stringify(snaps, null, 2).slice(0, 600);
      } catch (error) {
        titleSample = `调用失败：${error.message}`;
      }
      await reply(
        userId,
        `listSessions 行字段：\n${keys.join(', ') || '(空)'}\n\n首行样例：\n${JSON.stringify(first, null, 2).slice(0, 900)}\n\nreadTitleSnapshots 样例：\n${titleSample}`,
      );
      return;
    }

    // 已绑定会话时，普通文字就是投递进那条会话（和桌面端共用同一个 Agent Runtime）
    const boundId = bound.get(userId);
    if (boundId) {
      await promptSession(userId, boundId, text);
      return;
    }

    await reply(userId, '还没绑定会话。先 /sessions 看列表，再 /use <序号>；之后直接发文字就能续聊。');
  }

  client.on('authenticated', () => bootLog('企业微信认证成功，开始接收消息'));
  client.on('error', (error) => bootLog(`连接错误：${error?.message ?? error}`));
  client.on('disconnected', (reason) => bootLog(`连接断开：${reason}`));
  client.connect();
  bootLog(`正在连接 ${wsUrl || 'wss://openws.work.weixin.qq.com'} …`);

  ctx.effect(() => () => {
    bootLog('插件卸载，关闭企业微信连接');
    client.close();
  });
}

const HELP = [
  'DSH Desktop 企业微信通道（阶段三：续聊）',
  '',
  '/sessions   列出 Desktop 里的会话',
  '/read <序号> 看某条会话的历史（只读）',
  '/use <序号> 绑定某条会话',
  '/status     查看当前绑定',
  '/unuse      解除绑定',
  '/debug      会话行字段结构',
  '/ping       连通性',
  '/id         你的 UserID',
  '',
  '绑定后直接发文字 = 投进那条会话，和桌面端共用同一个 Runtime。',
  '需要审批时这里会收到提示：回 1 允许一次，回 2 拒绝。',
].join('\n');
