/**
 * 追问（user-questions/request）转发的离线端到端：
 * 绑定会话的追问推送到企业微信（prepend 抢在 Web UI 桥之前），
 * 回序号 / 自定义文本 / 多选 / 多题批次 / 超时交回 / 未绑定交回。
 * 假 socket 自动回执，不碰网络、不写真实 ~/.dsh。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as plugin from '../lib/index.js';

const workDir = mkdtempSync(join(tmpdir(), 'wecom-questions-'));

/** 假 socket：每发一帧立即得到服务端回执，promise 快速结算 */
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

const SESSION_ID = 'session-12345678-1234-1234-1234-123456789abc';

async function boot({ questionTimeoutMs = 180_000 } = {}) {
  const fake = new FakeSocket();
  const handlers = {};
  const handlerOptions = {};
  const ctx = {
    get: () => undefined,
    on: (name, fn, options) => {
      handlers[name] = fn;
      handlerOptions[name] = options;
    },
    effect: () => {},
    sessionQuery: {
      listSessions: async () => [{ header: { id: SESSION_ID, cwd: 'C:\\work', createdAt: 1794541437043 }, live: false, persisted: true }],
      readTitleSnapshots: async () => [],
      readSession: async () => ({ events: [] }),
      listEvents: async () => [],
    },
  };
  plugin.apply(ctx, {
    botId: 'fake-bot',
    secret: 'fake-secret',
    allowUsers: ['u1'],
    socketFactory: () => fake,
    logPath: join(workDir, 'plugin.log'),
    bindingsPath: join(workDir, `bindings-${Math.random().toString(36).slice(2)}.json`),
    questionTimeoutMs,
  });

  fake.readyState = 1;
  fake.listeners.get('open')?.forEach((fn) => fn({}));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const send = (content, reqId) => {
    fake.listeners.get('message')?.forEach((fn) =>
      fn(
        JSON.stringify({
          cmd: 'aibot_msg_callback',
          headers: { req_id: reqId },
          body: { msgid: `m-${reqId}`, from: { userid: 'u1' }, chattype: 'single', text: { content } },
        }),
      ),
    );
  };
  const lastStream = (reqId) => {
    const frames = fake.sent.filter((f) => f.headers?.req_id === reqId && f.body?.msgtype === 'stream');
    return frames[frames.length - 1]?.body?.stream?.content ?? '';
  };
  const lastNotify = () => {
    const frames = fake.sent.filter((f) => f.cmd === 'aibot_send_msg');
    return frames[frames.length - 1]?.body?.markdown?.content ?? '';
  };
  const waitFor = async (predicate, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };

  return { fake, handlers, handlerOptions, send, lastStream, lastNotify, waitFor };
}

const question = (overrides = {}) => ({
  id: 'q1',
  question: '用哪个分支？',
  options: [{ label: 'main' }, { label: 'dev' }],
  ...overrides,
});

const nextOf = () => {
  const spy = { called: false };
  const fn = async () => {
    spy.called = true;
    return { answers: [] };
  };
  return { spy, fn };
};

try {
  // 1) 绑定会话的追问推送到微信，回序号作答；桌面端桥不会被触发
  {
    const t = await boot();
    assert.ok(t.handlerOptions['user-questions/request']?.prepend, '追问监听必须 prepend');
    await t.send('/use 1', 'use-1');
    assert.ok(await t.waitFor(() => t.lastStream('use-1').includes('已绑定')), '/use 应完成绑定');

    const { spy, fn } = nextOf();
    const pending = t.handlers['user-questions/request'](
      { agent: { session: { id: SESSION_ID } }, questions: [question()] },
      fn,
    );
    assert.ok(await t.waitFor(() => /用哪个分支/.test(t.lastNotify())), '追问应推送到企业微信');
    assert.match(t.lastNotify(), /1\. main/);
    assert.match(t.lastNotify(), /2\. dev/);
    assert.match(t.lastNotify(), /回序号/);

    t.send('2', 'ans-1');
    const result = await pending;
    assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['dev'] }] });
    assert.equal(spy.called, false, '已由微信作答，不该再交回桌面端');
    assert.ok(await t.waitFor(() => /已提交回答/.test(t.lastNotify())), '应确认提交');
  }

  // 2) 多题批次：逐题推送；序号 + 自定义文本
  {
    const t = await boot();
    await t.send('/use 1', 'use-2');
    await t.waitFor(() => t.lastStream('use-2').includes('已绑定'));

    const { spy, fn } = nextOf();
    const pending = t.handlers['user-questions/request'](
      {
        agent: { session: { id: SESSION_ID } },
        questions: [question(), { id: 'q2', question: '备注写什么？' }],
      },
      fn,
    );
    assert.ok(await t.waitFor(() => /问题 1\/2/.test(t.lastNotify())), '第一题应带批次序号');
    t.send('1', 'ans-2a');
    assert.ok(await t.waitFor(() => /问题 2\/2/.test(t.lastNotify())), '第二题应继续推送');
    assert.match(t.lastNotify(), /直接回复内容/);
    t.send('就按这个来', 'ans-2b');
    const result = await pending;
    assert.deepEqual(result, {
      answers: [
        { id: 'q1', selected: ['main'] },
        { id: 'q2', selected: ['就按这个来'] },
      ],
    });
    assert.equal(spy.called, false);
  }

  // 3) 多选：逗号分隔的序号展开成多个选项
  {
    const t = await boot();
    await t.send('/use 1', 'use-3');
    await t.waitFor(() => t.lastStream('use-3').includes('已绑定'));

    const pending = t.handlers['user-questions/request'](
      {
        agent: { session: { id: SESSION_ID } },
        questions: [question({ multiSelect: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] })],
      },
      nextOf().fn,
    );
    await t.waitFor(() => /可多选/.test(t.lastNotify()));
    t.send('1, 3', 'ans-3');
    const result = await pending;
    assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['a', 'c'] }] });
  }

  // 4) 未绑定会话：立即 next() 交回桌面端
  {
    const t = await boot();
    const { spy, fn } = nextOf();
    const result = await t.handlers['user-questions/request'](
      { agent: { session: { id: 'session-unbound' } }, questions: [question()] },
      fn,
    );
    assert.equal(spy.called, true, '未绑定会话应交回桌面端');
    assert.deepEqual(result, { answers: [] });
  }

  // 5) 微信端一直不答：超时后 next() 交回桌面端
  {
    const t = await boot({ questionTimeoutMs: 80 });
    await t.send('/use 1', 'use-5');
    await t.waitFor(() => t.lastStream('use-5').includes('已绑定'));

    const { spy, fn } = nextOf();
    const pending = t.handlers['user-questions/request'](
      { agent: { session: { id: SESSION_ID } }, questions: [question()] },
      fn,
    );
    await t.waitFor(() => /用哪个分支/.test(t.lastNotify()));
    // 追问超时定时器是 unref 的；不挂一个普通定时器，事件循环会提前排空、测试被静默中断
    const keepAlive = setInterval(() => {}, 20);
    const result = await pending;
    clearInterval(keepAlive);
    assert.equal(spy.called, true, '超时应交回桌面端');
    assert.deepEqual(result, { answers: [] });
  }
} finally {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
