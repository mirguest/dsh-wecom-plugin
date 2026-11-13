/**
 * 阶段二的离线自测：插件导出形状 + 真实行结构（header/live/persisted/formatStatus）+ 标题渲染。
 * 真正的"在 Desktop Host 内加载"由 ~/.dsh/wecom-plugin.log 验证。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as plugin from '../lib/index.js';

// DSH's loader parses this file to validate the plugin's declared requirements.
// A UTF-8 BOM makes JSON.parse throw, and the loader then *disables the row
// silently* — the plugin never imports and the bot goes quiet. Guard it.
const packagePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const bytes = readFileSync(packagePath);
assert.ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), 'package.json 不能带 UTF-8 BOM');
assert.doesNotThrow(() => JSON.parse(bytes.toString('utf8')), 'package.json 必须能被 JSON.parse');

assert.equal(typeof plugin.apply, 'function', '应导出 apply');
assert.equal(plugin.name, 'wecom-bridge', '插件名');
assert.deepEqual(plugin.inject, ['sessionQuery'], '注入会话查询服务');

// 按实测结构构造（/debug 里拿到的真实形状）
const rows = [
  { header: { id: 'session-9101f6a0-3226-4d4e-8532-26f9d26e3f67', cwd: 'C:\\work\\a', createdAt: 1794541437043 }, live: true, persisted: true, formatStatus: 'current' },
  { header: { id: 'session-b860c1eb-05d0-440a-886b-fcfbf957ec2a', cwd: 'C:\\work\\b', createdAt: 1794500000000 }, live: false, persisted: true, formatStatus: 'migration-required' },
  { header: { id: 'session-3fe2b707-d1b3-41a4-9f0a-00f2dba77b2f', cwd: 'C:\\work\\c' }, live: false, persisted: false },
];
const text = plugin.formatSessionList(rows, ['修一下登录接口', '', '查 D 盘']);
assert.ok(!text.includes('undefined'), '不应出现 undefined');
assert.match(text, /1\. 修一下登录接口 — session-9101f6a0…/, '首行应是标题 + 短 id');
assert.match(text, /2\. （未命名） — session-b860c1eb…/, '没有标题时给占位');
assert.match(text, /3\. 查 D 盘 — session-3fe2b707…/);
assert.match(text, /运行中/);
assert.match(text, /未激活/);
assert.match(text, /migration-required/, '非 current 格式要标出来');
assert.match(text, /C:\\work\\a/);
assert.equal(plugin.formatSessionList([]), '这个 Host 里没有会话。');

console.log('  ✓ 插件导出形状正确');
console.log('  ✓ 列表带标题 + 短 id，无标题时有占位');
console.log('\n2/2 通过');
