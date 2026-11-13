import assert from 'node:assert/strict';
import * as p from '../lib/index.js';

const result = { events: [
  { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '帮我查 D 盘' }], source: { kind: 'user' } } },
  { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '运行时注入，不该显示' }], source: { kind: 'runtime' } } },
  { type: 'tool/call', seq: 3, data: { name: 'pwsh' } },
  { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: '还剩 128 GB' }] } } },
  { type: 'user/message', seq: 5, data: { content: [{ type: 'text', text: '谢谢' }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 6, data: { message: { content: [{ type: 'text', text: '不客气' }] } } },
]};
const all = p.formatTranscript(result, { limit: 10 });
assert.ok(all.includes('【你】帮我查 D 盘'));
assert.ok(all.includes('【DSH】还剩 128 GB'));
assert.ok(all.includes('1 次工具调用'));
assert.ok(!all.includes('运行时注入'), '注入上下文不应出现');
const last2 = p.formatTranscript(result, { limit: 2 });
assert.ok(last2.includes('共 4 条，这里显示最后 2 条'));
assert.ok(!last2.includes('帮我查 D 盘'), 'limit 只保留最后两条');
console.log('  ✓ 历史渲染：过滤注入上下文、标注工具次数');
console.log('  ✓ limit 只显示最后 N 条并给出总数');
console.log('\n2/2 通过');

