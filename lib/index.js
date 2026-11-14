/**
 * dsh-wecom-plugin —— 在 DSH Desktop Host 进程内提供企业微信通道。
 *
 * 为什么必须是「进程内插件」：Desktop 的会话由本进程的 Agent 持有写句柄，
 * 另一个进程 resume 同一条会话会被拒（"already owned by an active write handle"）。
 * 插件与桌面 UI 共享同一个 Cordis 容器、同一个 Agent Runtime，因此天然看到
 * 同一批会话、同一条消息流，也不会产生跨进程写入。
 *
 * 能力一览：
 *   - /sessions /read   只读浏览 Host 里的会话（ctx.sessionQuery）
 *   - /use + 普通文字    绑定会话后续聊（ctx.agents.resume + agent.followup）
 *   - approval/request   waterfall 应答者：把「是否允许」转发到企业微信投票
 */
import { AibotClient, generateReqId } from './aibot.js';
import { createLogger } from './log.js';
import {
  eventsOf,
  extractAssistant,
  formatSessionList,
  formatTranscript,
  maxSeq,
  rowCwd,
  rowId,
  rowLive,
} from './session-format.js';
import { randomUUID } from 'node:crypto';

export const name = 'wecom-bridge';
/** 只依赖会话查询服务；agents / approval 按需探测，缺席时退化为只读 */
export const inject = ['sessionQuery'];

/* ---------------- 配置读取 ---------------- */

/** config.allowUsers 兼容 YAML 数组、逗号分隔字符串；空 = 不设白名单（放行所有人） */
const toUserList = (value) => {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
};

export function resolveConfig(config = {}) {
  const env = process.env;
  return {
    botId: config.botId || env.DSH_WECOM_BOT_ID || '',
    secret: config.secret || env.DSH_WECOM_SECRET || '',
    wsUrl: config.wsUrl || env.DSH_WECOM_WS_URL || '',
    allowUsers: toUserList(config.allowUsers?.length != null ? config.allowUsers : env.DSH_WECOM_ALLOW_USERS),
    provider: config.provider || env.DSH_WECOM_PROVIDER || 'deepseek-official',
    model: config.model || env.DSH_WECOM_MODEL || 'deepseek-flash',
    logPath: config.logPath || env.DSH_WECOM_LOG_PATH || undefined,
    socketFactory: config.socketFactory,
  };
}

/* ---------------- 审批词汇 ---------------- */

const APPROVE = new Set(['1', 'y', 'yes', '允许', '同意', '批准', 'allow']);
const DENY = new Set(['2', 'n', 'no', '拒绝', 'deny', 'reject']);

const HELP = [
  'DSH Desktop 企业微信通道',
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
  '需要审批时这里会收到提示：回 1 允许一次，回 2 拒绝（3 分钟不回复按取消）。',
].join('\n');

/* ---------------- 插件主体 ---------------- */

export function apply(ctx, config = {}) {
  const options = resolveConfig(config);
  const bootLog = createLogger(options.logPath);
  const { botId, secret, wsUrl, allowUsers, provider, model } = options;

  bootLog(`apply() called; botId=${botId ? 'set' : 'MISSING'} secret=${secret ? 'set' : 'MISSING'} allowUsers=${allowUsers.join('|') || '(无白名单=放行所有人)'}`);
  if (!botId || !secret) {
    bootLog('缺少 botId / secret，插件不启动。请配置 cordis.patch.yml 或环境变量 DSH_WECOM_BOT_ID / DSH_WECOM_SECRET');
    return;
  }

  const client = new AibotClient({
    botId,
    secret,
    wsUrl: wsUrl || undefined,
    socketFactory: options.socketFactory,
    log: { info: bootLog, warn: bootLog, error: bootLog, debug: () => {} },
  });

  /** 企业微信用户 -> 最近一条入站消息的回复上下文（用于主动推送，如审批提示） */
  const lastCtx = new Map();
  /** 企业微信用户 -> 绑定的 DSH 会话 */
  const bound = new Map();
  /** 企业微信用户 -> 最近一次 /sessions 的结果 */
  const listed = new Map();
  /** agents 服务（Host 内的 Agent 注册表）；取不到就退化成只读 */
  const agents = ctx.get?.('agents');

  /** 在入站消息的流式气泡里回话（reqId 按消息线程化，互不串流） */
  const reply = async (ctxInfo, text, final = true) => {
    if (!ctxInfo?.reqId) return;
    await client.replyStream(ctxInfo.reqId, ctxInfo.streamId, text, final);
  };

  /** 主动消息：审批提示不能复用某条入站消息的流式气泡。fire-and-forget，成败只记日志 */
  const notify = (userId, text) => {
    const c = lastCtx.get(userId);
    client.sendMarkdown(c?.chatid ?? userId, text).catch((error) => bootLog(`主动推送失败：${error?.message ?? error}`));
  };

  client.on('message', (message) => {
    const ctxInfo = {
      reqId: message.reqId,
      streamId: generateReqId('stream'),
      chatid: message.chatId || message.FromUserName,
    };
    lastCtx.set(message.FromUserName, ctxInfo);
    void handle(message, ctxInfo).catch((error) => {
      bootLog(`处理失败：${error?.message ?? error}`);
      reply(ctxInfo, `处理失败：${error?.message ?? error}`).catch(() => {});
    });
  });

  /* ---------------- 审批转发 ---------------- */

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
    if (approvals.has(userId)) {
      bootLog(`审批请求 session=${sessionId}：该用户已有待决审批，转交桌面端`);
      return next();
    }

    const tool = req?.tool?.name ?? req?.tool ?? req?.toolName ?? '敏感操作';
    const reason = req?.displayReason ?? req?.reason ?? '';
    bootLog(`审批请求 session=${sessionId} tool=${tool}`);

    // 连接都没建立时通知必然发不出去，转交桌面端，别把审批挂死
    if (!client.isConnected) {
      bootLog('企业微信连接未就绪，审批转交桌面端');
      return next();
    }
    notify(userId, `⚠️ 需要你审批\n工具：${tool}${reason ? `\n原因：${reason}` : ''}\n\n回复 1 = 允许一次\n回复 2 = 拒绝（3 分钟不回复按取消）`);

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

  /* ---------------- 会话读写 ---------------- */

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
  async function promptSession(ctxInfo, sessionId, text) {
    const before = await ctx.sessionQuery.readSession(sessionId).catch(() => null);
    const baseline = maxSeq(before);
    const baseCount = eventsOf(before).length;
    const agent = await getAgent(sessionId);

    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    });
    bootLog(`已投递到 ${sessionId}（baseline=${baseline} count=${baseCount}）`);
    await reply(ctxInfo, '已投递到该会话，等待这一轮结束…', false);

    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
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
      await reply(ctxInfo, answer || '（这一轮结束了，但没有可显示的助手文本）');
      return;
    }
    await reply(ctxInfo, '等待超时（3 分钟）。任务可能还在跑，可以到桌面端查看进度。');
  }

  /* ---------------- 命令路由 ---------------- */

  /** 按 序号|sessionId 在缓存的列表里找会话 */
  async function pickSession(userId, target) {
    const rows = listed.get(userId) ?? (await ctx.sessionQuery.listSessions()) ?? [];
    listed.set(userId, rows);
    if (!Array.isArray(rows) || !rows.length) return null;
    if (/^\d+$/.test(target)) return rows[Number(target) - 1] ?? null;
    return rows.find((row) => rowId(row) === (target.startsWith('session-') ? target : `session-${target}`)) ?? null;
  }

  async function handle(message, ctxInfo) {
    const userId = message.FromUserName;
    if (!userId) return;
    if (allowUsers.length && !allowUsers.includes(userId)) {
      bootLog(`拒绝非白名单用户 ${userId}`);
      await reply(ctxInfo, '你没有权限使用这个机器人。');
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
        await reply(ctxInfo, '✅ 已允许这一次。');
        return;
      }
      if (DENY.has(key)) {
        pendingApproval.resolve('rejected');
        await reply(ctxInfo, '🚫 已拒绝。');
        return;
      }
      notify(userId, '这条是待审批的操作，请回复 1（允许一次）或 2（拒绝）。');
      return;
    }

    if (text === '/help' || text === '/帮助') {
      await reply(ctxInfo, HELP);
      return;
    }
    if (text === '/id') {
      await reply(ctxInfo, `企业微信 UserID：${userId}\nHost：DSH Desktop（进程内插件）`);
      return;
    }
    if (text === '/ping') {
      await reply(ctxInfo, 'pong（插件已加载在 Desktop Host 内）');
      return;
    }
    if (text === '/sessions' || text === '/列表') {
      const { rows, text: listText } = await sessionListText();
      listed.set(userId, rows);
      bootLog(`listSessions -> ${rows.length} 行（含标题）`);
      await reply(ctxInfo, `DSH Desktop 会话（${rows.length} 条）：\n\n${listText}\n\n看某条聊了什么：/read <序号>；绑定：/use <序号>`);
      return;
    }
    if (text.startsWith('/use ') || text === '/use') {
      const arg = text.slice(4).trim();
      if (!arg) {
        await reply(ctxInfo, '用法：/use <序号|sessionId>（先发 /sessions 拿列表）');
        return;
      }
      const picked = await pickSession(userId, arg);
      if (!picked) {
        await reply(ctxInfo, '没找到这条会话。先发 /sessions，或用完整的 sessionId。');
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
        ctxInfo,
        `已绑定：${id}\n状态：${rowLive(picked) ? '运行中（桌面端正在用它）' : '未激活'}` +
          `\n${live ? 'Host 内已持有它的 Agent 句柄。' : 'Host 内暂无 Agent 句柄，需要时再恢复。'}` +
          '\n绑定后直接发文字即可续聊。',
      );
      return;
    }
    if (text.startsWith('/read ') || text === '/read') {
      const [target, countArg] = text.replace('/read', '').trim().split(/\s+/);
      if (!target) {
        await reply(ctxInfo, '用法：/read <序号|sessionId> [条数]\n先发 /sessions 拿列表。');
        return;
      }
      const picked = await pickSession(userId, target);
      if (!picked) {
        await reply(ctxInfo, '没找到这条会话。先发 /sessions，或用完整的 sessionId。');
        return;
      }
      const limit = Math.min(Math.max(Number(countArg) || 8, 1), 30);
      const id = rowId(picked);
      await reply(ctxInfo, `读取 ${id} …`, false);
      try {
        const result = await ctx.sessionQuery.readSession(id);
        await reply(ctxInfo, `会话 ${id}\n${rowCwd(picked)}\n\n${formatTranscript(result, { limit })}`);
      } catch (error) {
        await reply(ctxInfo, `读取失败：${error.message}`);
      }
      return;
    }
    if (text === '/status' || text === '/状态') {
      const id = bound.get(userId);
      if (!id) {
        await reply(ctxInfo, '还没有绑定会话。先 /sessions，再 /use <序号>。');
        return;
      }
      const rows = (await ctx.sessionQuery.listSessions()) ?? [];
      const row = rows.find((item) => rowId(item) === id);
      await reply(
        ctxInfo,
        `绑定会话：${id}\n${row ? (rowLive(row) ? '运行中' : '未激活') + ' · ' + rowCwd(row) : '（列表里暂时看不到它）'}`,
      );
      return;
    }
    if (text === '/unuse') {
      bound.delete(userId);
      await reply(ctxInfo, '已解除绑定。');
      return;
    }
    if (text === '/debug') {
      // 用于核对当前安装版本的结构：只看字段名与样例，不改任何东西。
      // 注意：回复里包含会话元数据（如工作目录），请只在受信任的聊天里使用。
      const rows = (await ctx.sessionQuery.listSessions()) ?? [];
      const first = rows[0];
      const keys = first ? Object.keys(first) : [];
      let titleSample = '（未取到）';
      try {
        const snaps = await ctx.sessionQuery.readTitleSnapshots(rows.length ? [rowId(first)] : []);
        titleSample = JSON.stringify(snaps, null, 2).slice(0, 600);
      } catch (error) {
        titleSample = `调用失败：${error.message}`;
      }
      await reply(
        ctxInfo,
        `listSessions 行字段：\n${keys.join(', ') || '(空)'}\n\n首行样例：\n${JSON.stringify(first, null, 2).slice(0, 900)}\n\nreadTitleSnapshots 样例：\n${titleSample}`,
      );
      return;
    }

    // 已绑定会话时，普通文字就是投递进那条会话（和桌面端共用同一个 Agent Runtime）
    const boundId = bound.get(userId);
    if (boundId) {
      await promptSession(ctxInfo, boundId, text);
      return;
    }

    await reply(ctxInfo, '还没绑定会话。先 /sessions 看列表，再 /use <序号>；之后直接发文字就能续聊。');
  }

  /* ---------------- 连接生命周期 ---------------- */

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
