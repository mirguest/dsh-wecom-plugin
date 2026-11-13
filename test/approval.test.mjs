import assert from 'node:assert/strict';
import * as p from '../lib/index.js';

const handlers = {};
const ctx = {
  get: () => undefined,          // 没有 agents 服务
  on: (name, fn) => { handlers[name] = fn; },
  effect: () => {},
  sessionQuery: { listSessions: async () => [] },
};

p.apply(ctx, { botId: 'fake-bot', secret: 'fake-secret', allowUsers: ['u1'] });
assert.equal(typeof handlers['approval/request'], 'function', '应注册审批应答者');

// 没有绑定会话时，必须 next() 交回桌面端，绝不擅自作答
let delegated = false;
const returned = await handlers['approval/request'](
  { agent: { session: { id: 'session-nobody' } }, tool: { name: 'pwsh' } },
  async () => { delegated = true; return 'from-desktop'; },
);
assert.equal(delegated, true, '未绑定时应委托');
assert.equal(returned, 'from-desktop');

console.log('  ✓ 注册了 approval/request 应答者');
console.log('  ✓ 未绑定会话时不接管，转交桌面端');
console.log('\n2/2 通过');
process.exit(0);
