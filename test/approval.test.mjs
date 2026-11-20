import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as plugin from '../lib/index.js';

const workDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
try {
  const handlers = {};
  const handlerOptions = {};
  const ctx = {
    get: () => undefined, // 没有 agents 服务
    on: (name, fn, options) => {
      handlers[name] = fn;
      handlerOptions[name] = options;
    },
    effect: () => {},
    sessionQuery: { listSessions: async () => [] },
  };

  // 离线：socketFactory 直接失败，测试不碰网络；日志写进临时目录
  plugin.apply(ctx, {
    botId: 'fake-bot',
    secret: 'fake-secret',
    allowUsers: ['u1'],
    socketFactory: () => { throw new Error('offline test'); },
    logPath: join(workDir, 'plugin.log'),
  });
  assert.equal(typeof handlers['approval/request'], 'function', '应注册审批应答者');
  assert.ok(
    handlerOptions['approval/request']?.prepend,
    '审批监听必须 prepend：否则会被 Web UI 的远程瀑布桥抢在前面，企业微信永远收不到',
  );

  // 没有绑定会话时，必须 next() 交回桌面端，绝不擅自作答
  let delegated = false;
  const returned = await handlers['approval/request'](
    { agent: { session: { id: 'session-nobody' } }, tool: { name: 'pwsh' } },
    async () => { delegated = true; return 'from-desktop'; },
  );
  assert.equal(delegated, true, '未绑定时应委托');
  assert.equal(returned, 'from-desktop');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
