/**
 * 免绑定端到端（离线）：未绑定用户的第一条普通消息自动开新会话；
 * 持久化绑定跨重启自动接回；旧绑定失效自动换新；newSessionCwd 覆盖；
 * 有 sessionController 时走桌面同一条创建/接回路径；没有时退回 agents+预设组合。
 * 假 socket 自动回执（errcode=0），promise 不悬挂；不碰网络、不写真实 ~/.dsh。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as plugin from '../lib/index.js';

const workDir = mkdtempSync(join(tmpdir(), 'wecom-autobind-'));

/** 假 socket：每发一帧都立即得到服务端回执，队列里的 promise 快速结算 */
class FakeSocket {
  constructor() {
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener() {}
  send(data) {
    const frame = JSON.parse(data);
    this.sent.push(frame);
    setTimeout(() => {
      this.listeners
        .get('message')
        ?.forEach((fn) => fn(JSON.stringify({ headers: { req_id: frame.headers?.req_id }, errcode: 0 })));
    }, 0);
  }
  close() {
    this.readyState = 3;
  }
}

const BEFORE_EVENTS = [
  { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '之前的结果' }] } } },
  { type: 'turn/end', seq: 3, data: {} },
];
const AFTER_EVENTS = [
  ...BEFORE_EVENTS,
  { type: 'user/message', seq: 4, data: { content: [{ type: 'text', text: '第二条' }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 5, data: { message: { content: [{ type: 'text', text: '这一轮的答案' }] } } },
  { type: 'turn/end', seq: 6, data: {} },
];

/**
 * 起一个插件实例。
 * @param {{ rows?: object[], saved?: object, newSessionCwd?: string, withController?: boolean, withAgents?: boolean, withPresets?: boolean }} options
 */
async function boot({
  rows = [],
  saved = null,
  newSessionCwd = '',
  withController = true,
  withAgents = true,
  withPresets = false,
} = {}) {
  const bindingsPath = join(workDir, `bindings-${Math.random().toString(36).slice(2)}.json`);
  if (saved) writeFileSync(bindingsPath, `${JSON.stringify({ version: 1, users: saved })}\n`, 'utf8');

  const fake = new FakeSocket();
  const agent = { followups: [], followup(msg) { this.followups.push(msg); } };
  const calls = { create: [], resume: [], controllerCreate: [], resolveAgent: [], createdIds: [] };
  const agentsService = {
    get: (id) => (id === 'live-session' ? agent : undefined),
    create: async (options) => {
      calls.create.push(options);
      return { handle: { agent, dispose: async () => {} } };
    },
    resume: async (options) => {
      calls.resume.push(options);
      return { handle: { agent, dispose: async () => {} } };
    },
  };
  const controller = {
    create: async (request) => {
      calls.controllerCreate.push(request);
      const id = `session-${randomUUID()}`;
      calls.createdIds.push(id);
      return { sessionId: id };
    },
    resolveAgent: async (sessionId) => {
      calls.resolveAgent.push(sessionId);
      return { agent };
    },
  };
  const presets = {
    mounted: 0,
    resolve: async (id) => ({ id: id ?? 'standard' }),
    mount: async () => {
      presets.mounted += 1;
    },
  };
  const ctx = {
    get: (name) => {
      if (name === 'agents' && withAgents) return agentsService;
      if (name === 'sessionController' && withController) return controller;
      if (name === 'agentPresets' && withPresets) return presets;
      return undefined;
    },
    on: () => {},
    effect: () => {},
    sessionQuery: {
      listSessions: async () => rows,
      readTitleSnapshots: async () => [],
      readSession: async () => ({ events: agent.followups.length ? AFTER_EVENTS : BEFORE_EVENTS }),
      listEvents: async () => ({ events: AFTER_EVENTS }),
    },
  };

  plugin.apply(ctx, {
    botId: 'fake-bot',
    secret: 'fake-secret',
    allowUsers: ['u1'],
    socketFactory: () => fake,
    logPath: join(workDir, 'plugin.log'),
    bindingsPath,
    ...(newSessionCwd ? { newSessionCwd } : {}),
  });

  fake.readyState = 1;
  fake.listeners.get('open')?.forEach((fn) => fn({}));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const lastContent = (reqId) => {
    const frames = fake.sent.filter((f) => f.headers?.req_id === reqId && f.body?.msgtype === 'stream');
    return frames[frames.length - 1]?.body?.stream?.content ?? '';
  };
  const send = (user, content, reqId) => {
    fake.listeners.get('message')?.forEach((fn) =>
      fn(
        JSON.stringify({
          cmd: 'aibot_msg_callback',
          headers: { req_id: reqId },
          body: { msgid: `m-${reqId}`, from: { userid: user }, chattype: 'single', text: { content } },
        }),
      ),
    );
  };
  const waitFor = async (predicate, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };

  return { fake, agent, calls, presets, bindingsPath, send, lastContent, waitFor };
}

const row = (id, cwd = 'C:\\work') => ({ header: { id, cwd, createdAt: 1794541437043 }, live: false, persisted: true });

try {
  // 1) 新用户第一条消息：经 sessionController 开新会话（桌面同路，含预设与工具）、沿用最近 cwd、通知 + 落盘
  {
    const t = await boot({ rows: [row('session-old')] });
    t.send('u1', '帮我看看目录', 'auto-1');
    assert.ok(await t.waitFor(() => t.lastContent('auto-1').includes('这一轮的答案')), '应完成这一轮并回答案');
    assert.equal(t.calls.controllerCreate.length, 1, '应经 sessionController 开新会话');
    assert.deepEqual(t.calls.controllerCreate[0], { cwd: 'C:\\work' }, '默认沿用最近会话的工作目录');
    assert.equal(t.calls.create.length, 0, '有会话控制器时不应直连 agents.create');
    const sessionId = t.calls.createdIds[0];
    assert.match(sessionId, /^session-/);
    assert.equal(t.agent.followups.length, 1);
    assert.equal(t.agent.followups[0].content[0].text, '帮我看看目录', '消息应投进新会话');
    assert.ok(
      t.fake.sent.some((f) => f.cmd === 'aibot_send_msg' && /已自动开新会话/.test(f.body?.markdown?.content ?? '')),
      '应推送「已自动开新会话」说明',
    );
    const persisted = JSON.parse(readFileSync(t.bindingsPath, 'utf8'));
    assert.equal(persisted.users.u1.sessionId, sessionId, '绑定应落盘');
  }

  // 2) 持久化绑定跨重启自动接回：走 resolveAgent，不新建
  {
    const savedId = 'session-12345678-1234-1234-1234-123456789abc';
    const t = await boot({
      rows: [row(savedId)],
      saved: { u1: { sessionId: savedId, cwd: 'C:\\work', updatedAt: 1 } },
    });
    t.send('u1', '接着上次聊', 'auto-2');
    assert.ok(await t.waitFor(() => t.lastContent('auto-2').includes('这一轮的答案')), '应完成这一轮并回答案');
    assert.equal(t.calls.controllerCreate.length, 0, '会话还在时不该新建');
    assert.equal(t.calls.resolveAgent.length, 1, '应经 sessionController 接回');
    assert.equal(t.calls.resolveAgent[0], savedId);
    assert.equal(t.agent.followups[0].content[0].text, '接着上次聊');
  }

  // 3) 旧绑定失效：自动换新会话，并更新落盘
  {
    const goneId = 'session-gone-9999';
    const t = await boot({
      rows: [row('session-other')],
      saved: { u1: { sessionId: goneId, updatedAt: 1 } },
    });
    t.send('u1', '开始新讨论', 'auto-3');
    assert.ok(await t.waitFor(() => t.lastContent('auto-3').includes('这一轮的答案')), '应完成这一轮并回答案');
    assert.equal(t.calls.controllerCreate.length, 1, '旧绑定不存在时应自动开新会话');
    assert.notEqual(t.calls.createdIds[0], goneId);
    assert.ok(
      t.fake.sent.some((f) => /已自动开新会话/.test(f.body?.markdown?.content ?? '')),
      '换新后应说明',
    );
    const persisted = JSON.parse(readFileSync(t.bindingsPath, 'utf8'));
    assert.equal(persisted.users.u1.sessionId, t.calls.createdIds[0], '落盘应更新为新会话');
  }

  // 4) newSessionCwd 配置优先于「最近会话 cwd」
  {
    const t = await boot({ rows: [row('session-old', 'C:\\work')], newSessionCwd: 'D:\\projects' });
    t.send('u1', '换目录干活', 'auto-4');
    assert.ok(await t.waitFor(() => t.lastContent('auto-4').includes('这一轮的答案')), '应完成这一轮并回答案');
    assert.equal(t.calls.controllerCreate.length, 1);
    assert.deepEqual(t.calls.controllerCreate[0], { cwd: 'D:\\projects' }, '配置的目录应优先');
  }

  // 5) 没有 sessionController：退回 agents + agentPresets 组合（setup 挂载预设）
  {
    const t = await boot({ rows: [row('session-old')], withController: false, withPresets: true });
    t.send('u1', '兜底路径干活', 'auto-5');
    assert.ok(await t.waitFor(() => t.lastContent('auto-5').includes('这一轮的答案')), '应完成这一轮并回答案');
    assert.equal(t.calls.create.length, 1, '无控制器时应直连 agents.create');
    const options = t.calls.create[0];
    assert.equal(options.meta.agentPreset, 'standard', '应带上解析出的默认预设');
    assert.equal(options.meta.cwd, 'C:\\work');
    assert.equal(typeof options.setup, 'function', '应带 setup 组合回调');
    await options.setup({});
    assert.equal(t.presets.mounted, 1, 'setup 应挂载预设（shell 等工具由此而来）');
    assert.equal(t.calls.resume.length, 1, '冷会话应走 agents.resume');
    assert.equal(typeof t.calls.resume[0].setup, 'function', 'resume 也应带组合回调');
  }

  // 6) 没有 agents 服务时给明确报错，不静默
  {
    const t = await boot({ rows: [row('session-old')], withController: false, withAgents: false });
    t.send('u1', '干活', 'auto-6');
    assert.ok(await t.waitFor(() => t.lastContent('auto-6').includes('agents 服务')), '应回错误文案');
    assert.equal(t.calls.create.length, 0);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
