/**
 * 阶段二的离线自测：插件导出形状 + 真实行结构（header/live/persisted/formatStatus）的渲染。
 * 真正的"在 Desktop Host 内加载"由 ~/.dsh/wecom-plugin.log 验证。
 */
import assert from 'node:assert/strict';
import * as plugin from '../lib/index.js';

assert.equal(typeof plugin.apply, 'function', '应导出 apply');
assert.equal(plugin.name, 'wecom-bridge', '插件名');
assert.deepEqual(plugin.inject, ['sessionQuery'], '注入会话查询服务');

// 按实测结构构造（/debug 里拿到的真实形状）
const rows = [
  { header: { id: 'session-a', cwd: 'C:\\work\\a', createdAt: 1794541437043 }, live: true, persisted: true, formatStatus: 'current' },
  { header: { id: 'session-b', cwd: 'C:\\work\\b', createdAt: 1794500000000 }, live: false, persisted: true, formatStatus: 'migration-required' },
  { header: { id: 'session-c', cwd: 'C:\\work\\c' }, live: false, persisted: false },
];
const text = plugin.formatSessionList(rows);
assert.ok(!text.includes('undefined'), '不应出现 undefined');
assert.match(text, /1\. session-a/);
assert.match(text, /运行中/);
assert.match(text, /未激活/);
assert.match(text, /migration-required/, '非 current 格式要标出来');
assert.match(text, /C:\\work\\a/);
assert.equal(plugin.formatSessionList([]), '这个 Host 里没有会话。');

console.log('  ✓ 插件导出形状正确');
console.log('  ✓ 真实行结构渲染正常（无 undefined，含运行中/格式状态）');
console.log('\n2/2 通过');
