/**
 * 端到端离线测试：用一个假 socket 把「认证 → 入站消息 → 命令路由 → 出站回复」
 * 整条链路走一遍，不碰网络、不写用户日志。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as plugin from '../lib/index.js';

const workDir = mkdtempSync(join(tmpdir(), 'wecom-cmd-'));

/** 最小 socket 假件：记录出站帧，供测试手动触发事件 */
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
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
}

const SESSION_ID = 'session-12345678-1234-1234-1234-123456789abc';
const fake = new FakeSocket();
const handlers = {};
const ctx = {
  get: () => undefined, // 没有 agents 服务 → 续聊链路会报错（测试里断言这个报错文案）
  on: (name, fn) => { handlers[name] = fn; },
  effect: () => {},
  sessionQuery: {
    listSessions: async () => [{ header: { id: SESSION_ID, cwd: 'C:\\work', createdAt: 1794541437043 }, live: true, persisted: true }],
    readTitleSnapshots: async (ids) => ids.map(() => ({ title: '测试会话' })),
    readSession: async () => ({ events: [
      { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
    ] }),
    listEvents: async () => [],
  },
};

plugin.apply(ctx, {
  botId: 'fake-bot',
  secret: 'fake-secret',
  allowUsers: ['u1'],
  socketFactory: () => fake,
  logPath: join(workDir, 'plugin.log'),
  bindingsPath: join(workDir, 'bindings.json'),
});

const emit = (type, payload) => fake.listeners.get(type)?.forEach((fn) => fn(payload));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const framesFor = (reqId) => fake.sent.filter((f) => f.headers?.req_id === reqId);
const lastContentFor = (reqId) => {
  const frames = framesFor(reqId);
  return frames[frames.length - 1]?.body?.stream?.content ?? '';
};

async function sendMessage(userId, content, reqId) {
  emit('message', JSON.stringify({
    cmd: 'aibot_msg_callback',
    headers: { req_id: reqId },
    body: { msgid: `m-${reqId}`, from: { userid: userId }, chattype: 'single', text: { content } },
  }));
  await tick();
}

/** /use、/unuse 现在要等一次真实落盘，回复帧可能晚几个事件循环才出现 */
async function waitReply(reqId, regex, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (regex.test(lastContentFor(reqId))) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

try {
  // 1) 认证握手（真实 WsSocket 在 upgrade 完成、readyState=1 后才发 open）
  fake.readyState = 1;
  emit('open');
  assert.equal(fake.sent[0]?.cmd, 'aibot_subscribe', 'open 后应发认证帧');
  emit('message', JSON.stringify({ cmd: 'aibot_subscribe', headers: { req_id: 'aibot_subscribe_1' }, errcode: 0 }));
  await tick();

  // 2) /ping 与 /help
  await sendMessage('u1', '/ping', 'msg-1');
  assert.match(lastContentFor('msg-1'), /pong/, '/ping 应回 pong');
  await sendMessage('u1', '/help', 'msg-2');
  assert.match(lastContentFor('msg-2'), /\/sessions/, '/help 应列出命令');

  // 3) /sessions 列表（含标题）
  await sendMessage('u1', '/sessions', 'msg-3');
  assert.match(lastContentFor('msg-3'), /1\. 测试会话 — session-12345678…/, '/sessions 应带标题与短 id');

  // 4) /read：先回「读取中」，ack 后排第二帧
  await sendMessage('u1', '/read 1', 'msg-4');
  assert.match(lastContentFor('msg-4'), /读取 session-/, '/read 先回读取中');
  emit('message', JSON.stringify({ headers: { req_id: 'msg-4' }, errcode: 0 }));
  await tick();
  assert.match(lastContentFor('msg-4'), /【你】hi/, 'ack 后应出历史正文');
  assert.match(lastContentFor('msg-4'), /【DSH】ok/);

  // 5) /use 绑定与 /status
  await sendMessage('u1', '/use 1', 'msg-5');
  assert.ok(await waitReply('msg-5', new RegExp(`已绑定：${SESSION_ID}`)), '/use 应绑定会话');
  await sendMessage('u1', '/status', 'msg-6');
  assert.match(lastContentFor('msg-6'), /运行中/, '/status 应显示运行中');

  // 5.5) /use 的绑定应同步落盘（桌面重启后自动接回）
  const persisted = JSON.parse(readFileSync(join(workDir, 'bindings.json'), 'utf8'));
  assert.equal(persisted.users.u1.sessionId, SESSION_ID, '/use 应持久化绑定');

  // 6) 绑定后发普通文字 → 没有 agents 服务，应回明确报错而不是静默
  await sendMessage('u1', '继续干活', 'msg-7');
  assert.match(lastContentFor('msg-7'), /agents 服务/, '无 agents 时应回错误文案');

  // 7) 审批：绑定用户收到通知，回 1 允许一次
  const approvalPromise = handlers['approval/request'](
    { agent: { session: { id: SESSION_ID } }, tool: { name: 'pwsh' } },
    async () => 'from-desktop',
  );
  await tick();
  const push = fake.sent.find((f) => f.cmd === 'aibot_send_msg');
  assert.match(push?.body?.markdown?.content ?? '', /需要你审批/, '审批提示应推送到企业微信');
  await sendMessage('u1', '1', 'msg-8');
  assert.equal(await approvalPromise, 'allowed-once', '回 1 应返回 allowed-once');
  assert.match(lastContentFor('msg-8'), /已允许/, '投票后应确认');

  // 8) 白名单：非白名单用户被拒
  await sendMessage('u2', '/ping', 'msg-9');
  assert.match(lastContentFor('msg-9'), /没有权限/, '非白名单用户应被拒绝');

  // 9) /unuse 解绑（同时清除持久化绑定）
  await sendMessage('u1', '/unuse', 'msg-10');
  assert.ok(await waitReply('msg-10', /已解除绑定/), '/unuse 应回解除确认');
  const afterUnuse = JSON.parse(readFileSync(join(workDir, 'bindings.json'), 'utf8'));
  assert.equal(afterUnuse.users.u1, undefined, '/unuse 应清除持久化绑定');
} finally {
  // Windows 上刚写入的文件可能仍被防病毒/索引器占用，rmSync 需要重试
  rmSync(workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
