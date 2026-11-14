/**
 * 插件日志：桌面版是打包 GUI，主进程 stdout 通常看不到，
 * 所以把加载过程的每一步都落到日志文件，便于事后确认「到底加载了没有」。
 *
 * 路径优先级：config.logPath > 环境变量 DSH_WECOM_LOG_PATH >
 *            $DSH_HOME/wecom-plugin.log > ~/.dsh/wecom-plugin.log
 * 单测可以注入临时路径，避免污染用户真实的日志。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function defaultLogPath() {
  if (process.env.DSH_WECOM_LOG_PATH) return process.env.DSH_WECOM_LOG_PATH;
  const base = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(base, 'wecom-plugin.log');
}

/** 返回一个 (message) => void 的日志函数；同时回显到 stdout，便于前台调试 */
export function createLogger(logPath = defaultLogPath()) {
  const say = (...args) => console.log('[wecom-bridge]', ...args);
  return (message) => {
    const line = `${new Date().toISOString()} ${message}\n`;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, line, 'utf8');
    } catch {
      /* 落盘失败就算了，不影响主流程 */
    }
    say(message);
  };
}
