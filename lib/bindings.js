/**
 * 企业微信用户 → DSH 会话绑定的持久化。
 *
 * 为什么需要：Desktop 一重启，插件内存里的绑定就没了，用户必须重新 /use。
 * 落盘后重启自动接回；旧会话已不存在时自动换新——「免绑定」体验的基础。
 *
 * 存储位置：$DSH_HOME/wecom-plugin-bindings.json（可用 DSH_WECOM_BINDINGS_PATH 覆盖）。
 * 写入用「临时文件 + rename」原子替换，避免进程中断写坏文件；
 * 损坏的 JSON 视为空并记录 loadError，下一次 save 整体覆盖重建。
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export function defaultBindingsPath(env = process.env) {
  if (env.DSH_WECOM_BINDINGS_PATH) return env.DSH_WECOM_BINDINGS_PATH;
  const base = env.DSH_HOME || join(homedir(), '.dsh');
  return join(base, 'wecom-plugin-bindings.json');
}

export class BindingsStore {
  constructor(path) {
    this.path = path;
    this.data = { version: 1, users: {} };
    this.loadError = null;
    this._loaded = Promise.resolve();
    this._writing = Promise.resolve();
  }

  /** 读取落盘文件；文件不存在视为空。损坏的文件不抛错，由调用方检查 loadError。 */
  load() {
    this._loaded = readFile(this.path, 'utf8')
      .then((raw) => {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.users) {
          // 合并而不是整体替换：load 期间内存里可能已经有 set（启动瞬间就收到消息），
          // 内存里的更新更新，应优先于磁盘内容。
          this.data = { version: 1, users: { ...parsed.users, ...this.data.users } };
        }
      })
      .catch((error) => {
        if (error.code === 'ENOENT') return;
        this.loadError = error;
        this.data = { version: 1, users: this.data.users };
      });
    return this._loaded;
  }

  get(userId) {
    return this.data.users[userId];
  }

  set(userId, patch) {
    const current = this.data.users[userId] ?? {};
    this.data.users[userId] = { ...current, ...patch, updatedAt: Date.now() };
    return this.data.users[userId];
  }

  delete(userId) {
    delete this.data.users[userId];
  }

  /** 串行化原子落盘：先等 load 完成，避免把「读到的旧内容」再写回去。 */
  save() {
    const write = async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      await rename(temp, this.path);
    };
    this._writing = this._writing.then(() => this._loaded).then(write);
    return this._writing;
  }
}
