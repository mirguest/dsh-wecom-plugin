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
import { BindingsStore, defaultBindingsPath } from './bindings.js';
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
    questionTimeoutMs: Number(config.questionTimeoutMs || env.DSH_WECOM_QUESTION_TIMEOUT_MS || 180_000),
    newSessionCwd: config.newSessionCwd || env.DSH_WECOM_NEW_SESSION_CWD || '',
    bindingsPath: config.bindingsPath || env.DSH_WECOM_BINDINGS_PATH || undefined,
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
  '/use <序号> 绑定/切换会话（可省略）',
  '/status     查看当前绑定',
  '/unuse      解除绑定',
  '/debug      会话行字段结构',
  '/ping       连通性',
  '/id         你的 UserID',
  '',
  '直接发消息 = 投进当前会话；没绑定时自动开一条新会话，绑定跨重启保留。',
  '需要审批时这里会收到提示：回 1 允许一次，回 2 拒绝（3 分钟不回复按取消）。',
  '需要回答问题时同样推到这里：回序号（可多选逗号分隔），或直接回复内容。',
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
  /** 绑定关系的落盘存储：重启后自动接回，不用重新 /use */
  const bindings = new BindingsStore(options.bindingsPath ?? defaultBindingsPath());
  const bindingsReady = bindings.load().then(() => {
    if (bindings.loadError) bootLog(`绑定文件损坏，将忽略并重建：${bindings.loadError.message}`);
    return bindings;
  });
  /** 同一用户并发触发的自动绑定只执行一次 */
  const bindingInFlight = new Map();
  /** 企业微信用户 -> 最近一次 /sessions 的结果 */
  const listed = new Map();
  /** agents 服务（Host 内的 Agent 注册表）；取不到就退化成只读 */
  const agents = ctx.get?.('agents');
  /** 会话控制器：桌面「新建会话 / 接回会话」的同一条路（预设组合、默认模型、工具齐全） */
  const sessionController = ctx.get?.('sessionController');

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
   *
   * 必须 prepend：dsh-api-remotes 把 approval/request 桥接成远程瀑布事件，
   * Web UI 会先注册并在弹窗期间挂住瀑布流——不 prepend 的话插件永远排
   * 在它后面，绑定会话的审批就永远到不了企业微信。
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
  }, { prepend: true });

  /* ---------------- 追问转发 ---------------- */

  /** 企业微信用户 -> 待答的追问批次（questions / index / answers / settle） */
  const questionPending = new Map();

  /** 把当前这一题渲染成企业微信里好读的几行 */
  async function askQuestion(userId) {
    const pending = questionPending.get(userId);
    if (!pending) return;
    const question = pending.questions[pending.index];
    const options = Array.isArray(question?.options) ? question.options : [];
    const lines = [
      pending.questions.length > 1 ? `❓ 问题 ${pending.index + 1}/${pending.questions.length}` : '❓ 需要你回答',
      question?.header ? `【${question.header}】` : '',
      question?.question ?? '',
      question?.detail ? `说明：${question.detail}` : '',
    ].filter(Boolean);
    options.forEach((option, i) => {
      const label = typeof option === 'string' ? option : option.label;
      const desc = typeof option === 'string' ? '' : option.description;
      lines.push(`${i + 1}. ${label}${desc ? ` —— ${desc}` : ''}`);
    });
    lines.push(
      '',
      options.length
        ? question?.multiSelect
          ? '可多选：回序号（逗号分隔）；也可以直接回复自定义内容。'
          : '回序号；也可以直接回复自定义内容。'
        : '直接回复内容。',
    );
    await notify(userId, lines.join('\n'));
  }

  /** 把一条入站消息当作当前问题的答案；批次答完就结算整个瀑布流 */
  function answerQuestion(userId, text) {
    const pending = questionPending.get(userId);
    if (!pending) return false;
    const question = pending.questions[pending.index];
    const options = Array.isArray(question?.options) ? question.options : [];
    const tokens = String(text).split(/[,，、\s]+/).map((item) => item.trim()).filter(Boolean);
    const valid = tokens
      .map((item) => (/^\d+$/.test(item) ? Number(item) : NaN))
      .filter((n) => !Number.isNaN(n) && n >= 1 && n <= options.length);
    let answer;
    if (valid.length && options.length && (question.multiSelect || tokens.length === 1)) {
      answer = {
        id: question.id,
        selected: valid.map((n) => (typeof options[n - 1] === 'string' ? options[n - 1] : options[n - 1].label)),
      };
    } else if (options.length) {
      answer = { id: question.id, selected: [], custom: text };
    } else {
      answer = { id: question.id, selected: [text] };
    }
    pending.answers.push(answer);
    pending.index += 1;
    if (pending.index < pending.questions.length) {
      void askQuestion(userId);
      return true;
    }
    pending.settle(pending.answers);
    return true;
  }

  /**
   * user-questions/request 的应答者：与审批同一套「只接管绑定会话」的规则，
   * 同样必须 prepend——Web UI 的远程瀑布桥会先挂住问题，不 prepend 就永远
   * 轮不到企业微信。超时 / 请求取消时不作答，next() 交回桌面端。
   */
  async function onQuestion(req, next) {
    const sessionId = req?.agent?.session?.id ?? req?.agent?.id ?? req?.sessionId;
    const userId = [...bound.entries()].find(([, id]) => id === sessionId)?.[0];
    if (!userId) return next();
    const list = Array.isArray(req?.questions) ? req.questions : [];
    if (!list.length) return next();
    if (questionPending.has(userId)) {
      bootLog(`追问 session=${sessionId}：该用户已有待答追问，转交桌面端`);
      return next();
    }
    if (!client.isConnected) {
      bootLog('企业微信连接未就绪，追问转交桌面端');
      return next();
    }

    bootLog(`追问 session=${sessionId}（${list.length} 题）`);
    const answers = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        questionPending.delete(userId);
        resolve(null); // 超时：按「未作答」处理
      }, options.questionTimeoutMs);
      timer.unref?.();
      req?.signal?.addEventListener?.(
        'abort',
        () => {
          clearTimeout(timer);
          questionPending.delete(userId);
          resolve(null);
        },
        { once: true },
      );
      questionPending.set(userId, {
        questions: list,
        answers: [],
        index: 0,
        settle: (value) => {
          clearTimeout(timer);
          questionPending.delete(userId);
          resolve(value);
        },
      });
      void askQuestion(userId); // 立即推送第一题，别等答案才发
    });

    if (answers === null) {
      bootLog(`追问未在微信端作答 session=${sessionId}，交回桌面端`);
      return next();
    }
    await notify(userId, '✅ 已提交回答。');
    return { answers };
  }

  ctx.on('user-questions/request', (req, next) => onQuestion(req, next), { prepend: true });

  /* ---------------- 会话读写 ---------------- */

  /**
   * 用 agentPresets 手工组合默认预设（没有 sessionController 的宿主上的兜底路径）。
   * 桌面上不会走到这里：sessionController 已经做了同样的事。
   */
  async function composedPreset() {
    const presets = ctx.get?.('agentPresets');
    if (!presets) return null;
    try {
      const resolvedId = (await presets.resolve(undefined)).id;
      return {
        agentPreset: resolvedId,
        setup: async (agentCtx) => {
          try {
            const { installModelSelection } = await import('@deepseek-ai/dsh-agent');
            installModelSelection?.(agentCtx);
          } catch {
            /* dsh-agent 缺失时跳过模型选择安装 */
          }
          await presets.mount(agentCtx, resolvedId);
        },
      };
    } catch (error) {
      bootLog(`解析默认预设失败，退化为无预设创建：${error.message}`);
      return null;
    }
  }

  /** 拿 Host 内的 Agent：优先 sessionController（含预设组合），否则 live 直取 / 手动 resume */
  async function getAgent(sessionId) {
    if (sessionController?.resolveAgent) {
      const result = await sessionController.resolveAgent(sessionId);
      if ('error' in result) throw new Error(result.error?.message ?? '会话不可用');
      return result.agent;
    }
    if (!agents) throw new Error('Host 内没有 agents 服务，无法续聊');
    const existing = agents.get?.(sessionId);
    if (existing) return existing;
    bootLog(`resume 会话 ${sessionId}（provider=${provider} model=${model}）`);
    const composed = await composedPreset();
    const { handle } = await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider, model },
      ...(composed ? { setup: composed.setup } : {}),
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

  /* ---------------- 免绑定：自动接回 / 自动开会话 ---------------- */

  /** 自动开新会话的默认工作目录：配置 > 最近一条会话的 cwd > 交给 Host 默认 */
  async function defaultNewSessionCwd() {
    const configured = String(options.newSessionCwd ?? '').trim();
    if (configured) return configured;
    try {
      const rows = (await ctx.sessionQuery.listSessions()) ?? [];
      const cwd = rows.length ? rowCwd(rows[0]) : '';
      if (cwd) return cwd;
    } catch (error) {
      bootLog(`读取最近会话 cwd 失败：${error.message}`);
    }
    return '';
  }

  /** 在 Host 内开一条全新会话并绑定（与桌面「新建会话」同路：预设、默认模型、工具齐全） */
  async function createAndBind(userId) {
    const cwd = await defaultNewSessionCwd();

    // 优先走会话控制器：这正是桌面 UI「新建会话」用的路径（含预设组合 → shell 等工具）
    if (sessionController?.create) {
      bootLog(`经 sessionController 开新会话（cwd=${cwd || '(Host 默认)'}）`);
      const created = await sessionController.create({ ...(cwd ? { cwd } : {}) });
      return await finishBinding(userId, created.sessionId, cwd);
    }

    // 兜底：没有会话控制器的宿主（headless 等）手工组合预设
    if (!agents) throw new Error('Host 内没有 agents 服务，无法自动开新会话');
    const sessionId = `session-${randomUUID()}`;
    const composed = await composedPreset();
    bootLog(`自动开新会话 ${sessionId}（cwd=${cwd || '(Host 默认)'}，预设=${composed?.agentPreset ?? '(无)'}）`);
    await agents.create({
      sessionId,
      meta: {
        ...(cwd ? { cwd } : {}),
        ...(composed?.agentPreset ? { agentPreset: composed.agentPreset } : {}),
      },
      agentOptions: { provider, model },
      ...(composed ? { setup: composed.setup } : {}),
    });
    return await finishBinding(userId, sessionId, cwd);
  }

  /** 绑定到内存与落盘，并告知用户 */
  async function finishBinding(userId, sessionId, cwd) {
    bound.set(userId, sessionId);
    bindings.set(userId, { sessionId, ...(cwd ? { cwd } : {}) });
    await bindings.save();
    notify(userId, `已自动开新会话：${sessionId}\n直接发消息就能继续；/sessions 看全部会话，/use <序号> 换绑，/unuse 解绑。`);
    return sessionId;
  }

  /**
   * 免手动 /use：内存里有绑定直接用；否则尝试接回持久化的绑定
   * （会话还在本机列表里）；都不行就自动开一条新会话。
   */
  function autoBind(userId) {
    const inMemory = bound.get(userId);
    if (inMemory) return Promise.resolve(inMemory);
    const inflight = bindingInFlight.get(userId);
    if (inflight) return inflight;
    const task = (async () => {
      await bindingsReady;
      const saved = bindings.get(userId);
      if (saved?.sessionId) {
        const rows = (await ctx.sessionQuery.listSessions()) ?? [];
        if (rows.some((row) => rowId(row) === saved.sessionId)) {
          bound.set(userId, saved.sessionId);
          bootLog(`自动接回持久化绑定 ${userId} -> ${saved.sessionId}`);
          return saved.sessionId;
        }
        bootLog(`持久化绑定 ${saved.sessionId} 已不存在，自动开新会话`);
      }
      return await createAndBind(userId);
    })();
    bindingInFlight.set(userId, task);
    void task.then(
      () => bindingInFlight.delete(userId),
      () => bindingInFlight.delete(userId),
    );
    return task;
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

    // 有待答追问时，这条消息当作答案（回序号或自定义内容）
    if (questionPending.has(userId)) {
      if (answerQuestion(userId, text)) return;
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
      await reply(ctxInfo, `DSH Desktop 会话（${rows.length} 条）：\n\n${listText}\n\n看某条聊了什么：/read <序号>；换绑：/use <序号>（直接发消息会自动开会话）`);
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
      bindings.set(userId, { sessionId: id });
      await bindings.save();
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
        await reply(ctxInfo, '还没有绑定会话。直接发消息会自动开一条新会话；也可以 /sessions → /use <序号> 手动绑定。');
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
      bindings.delete(userId);
      await bindings.save();
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

    // 未绑定也直接可用：自动接回上次的绑定；没有就自动开一条新会话（免手动 /use）
    const boundId = bound.get(userId) ?? (await autoBind(userId));
    await promptSession(ctxInfo, boundId, text);
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
