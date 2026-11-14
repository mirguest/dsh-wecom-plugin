import assert from 'node:assert/strict';
import {
  eventsOf,
  extractAssistant,
  extractTranscript,
  formatTranscript,
  maxSeq,
} from '../lib/session-format.js';

// readSession 兼容两种返回形态
const asArray = [
  { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'hi' }] } },
  { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } },
];
const asObject = { events: [...asArray, { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '答案' }] } } }] };
assert.equal(maxSeq(asArray), 2);
assert.equal(maxSeq(asObject), 3);
assert.equal(extractAssistant(asObject, 2), '答案');
assert.equal(extractAssistant(asObject, 3), '', '基线之后没有新的助手消息');
assert.equal(eventsOf(null).length, 0);
assert.equal(eventsOf({}).length, 0);

// 历史渲染：过滤注入上下文、标注工具次数、limit 截断
const result = { events: [
  { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '帮我查 D 盘' }], source: { kind: 'user' } } },
  { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '运行时注入，不该显示' }], source: { kind: 'runtime' } } },
  { type: 'tool/call', seq: 3, data: { name: 'pwsh' } },
  { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: '还剩 128 GB' }] } } },
  { type: 'user/message', seq: 5, data: { content: [{ type: 'text', text: '谢谢' }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 6, data: { message: { content: [{ type: 'text', text: '不客气' }] } } },
]};
const all = formatTranscript(result, { limit: 10 });
assert.ok(all.includes('【你】帮我查 D 盘'));
assert.ok(all.includes('【DSH】还剩 128 GB'));
assert.ok(all.includes('1 次工具调用'));
assert.ok(!all.includes('运行时注入'), '注入上下文不应出现');
const last2 = formatTranscript(result, { limit: 2 });
assert.ok(last2.includes('共 4 条，这里显示最后 2 条'));
assert.ok(!last2.includes('帮我查 D 盘'), 'limit 只保留最后两条');
assert.equal(extractTranscript(null).messages.length, 0);
