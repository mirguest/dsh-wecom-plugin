/**
 * 绑定持久化的单测：路径解析、存取回环、损坏文件自愈、并发保存不乱。
 * 全部写在临时目录里，不碰真实的 ~/.dsh。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BindingsStore, defaultBindingsPath } from '../lib/bindings.js';

const workDir = mkdtempSync(join(tmpdir(), 'wecom-bindings-'));

try {
  // 路径解析：显式覆盖 > DSH_HOME 下固定文件名
  assert.equal(defaultBindingsPath({ DSH_WECOM_BINDINGS_PATH: 'C:\\x\\b.json' }), 'C:\\x\\b.json');
  assert.ok(defaultBindingsPath({ DSH_HOME: 'C:\\home' }).endsWith('wecom-plugin-bindings.json'));
  assert.match(defaultBindingsPath({}), /wecom-plugin-bindings\.json$/);

  // 存取回环：save 后新实例 load 能读回来；delete 生效
  const path = join(workDir, 'bindings.json');
  const store = new BindingsStore(path);
  await store.load();
  store.set('u1', { sessionId: 'session-a', cwd: 'C:\\work' });
  await store.save();

  const again = new BindingsStore(path);
  await again.load();
  assert.equal(again.get('u1').sessionId, 'session-a');
  assert.equal(again.get('u1').cwd, 'C:\\work');

  again.delete('u1');
  await again.save();
  const third = new BindingsStore(path);
  await third.load();
  assert.equal(third.get('u1'), undefined, 'delete 后应读不到');

  // 损坏文件：不抛错、记录 loadError、按空处理；下一次 save 覆盖重建
  writeFileSync(path, '{broken json', 'utf8');
  const broken = new BindingsStore(path);
  await broken.load();
  assert.ok(broken.loadError, '损坏文件应记录 loadError');
  assert.equal(broken.get('u1'), undefined, '损坏文件按空处理');
  broken.set('u1', { sessionId: 'session-b' });
  await broken.save();
  const fixed = new BindingsStore(path);
  await fixed.load();
  assert.equal(fixed.get('u1').sessionId, 'session-b', 'save 应覆盖坏文件并重建');

  // load 尚未完成就发起 save：save 应等 load 完成再写，不丢旧数据
  const racing = new BindingsStore(path);
  const loading = racing.load();
  racing.set('u2', { sessionId: 'session-c' });
  await racing.save();
  await loading;
  const late = new BindingsStore(path);
  await late.load();
  assert.equal(late.get('u2').sessionId, 'session-c', '新增数据应落盘');
  assert.equal(late.get('u1').sessionId, 'session-b', 'load 中已有的旧数据不应被覆盖');

  // 文件不存在时 load 视为空
  const fresh = new BindingsStore(join(workDir, 'never-written.json'));
  await fresh.load();
  assert.equal(fresh.get('u1'), undefined);
  assert.ok(readFileSync(path, 'utf8').includes('"session-c"'));
} finally {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
