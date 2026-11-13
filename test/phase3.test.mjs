import assert from 'node:assert/strict';
import * as p from '../lib/index.js';

// readSession 兼容两种返回形态
const asArray = [
  { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'hi' }] } },
  { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } },
];
const asObject = { events: [ ...asArray, { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '答案' }] } } } ] };
assert.equal(p.maxSeq(asArray), 2);
assert.equal(p.maxSeq(asObject), 3);
assert.equal(p.extractAssistant(asObject, 2), '答案');
assert.equal(p.extractAssistant(asObject, 3), '', '基线之后没有新的助手消息');
assert.equal(p.eventsOf(null).length, 0);
console.log('  ✓ eventsOf 兼容数组/对象');
console.log('  ✓ maxSeq / extractAssistant 只取基线之后的内容');
console.log('\n2/2 通过');
