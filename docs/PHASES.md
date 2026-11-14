# 实施记录（阶段一~三）

> 历史记录，最新用法以 [README](../README.md) 为准，变更历史见 [CHANGELOG](../CHANGELOG.md)。

## 为什么必须换架构

现有 `dsh-wecom` 是**独立进程**，通过 `dsh --profile sdk` 另起一套 Agent Runtime。桌面版持有的会话有写句柄，另一个进程 `resume` 必然被拒——前面几轮反复出现的

```
session "..." is already owned by an active write handle
```

就是这个原因，不是配置问题。

要"共享同一个 Agent Runtime"，唯一的位置是 **Desktop Host 进程内部**：插件与桌面 UI 处于同一 Cordis 容器，`ctx.sessionQuery` / `ctx.agents` 指向同一份运行时，因此天然看到同一批会话。

## API 核对结果（基于本机安装版 0.2.2-rc.1）

| 能力 | 结论 |
|---|---|
| `ctx.sessionQuery.listSessions()` | ✅ 存在（`dsh-session-query/lib/index.js:1072`），返回全部会话，最新在前，带 `live` / `persisted` |
| `ctx.sessionQuery.readSession(id)` / `filterSessions` / `listEvents` | ✅ 存在，只读 |
| `ctx.agents.create()` / `ctx.agents.resume()` | ✅ 存在（`dsh-agent/lib/index.js:582/595`），工厂实现，resume 加载持久会话 |
| Session Controller 的 `session/prompt`、`session/list` | ⚠️ 是 **Remote（对客户端）端点**，经 API Gateway 暴露、受 peer 权限约束；插件在 Host 内不走这条，直接用 `ctx.agents` 的进程内句柄 |
| `dsh-base` 是否含 session-query | ✅ `cordis.patch.yml:157` 挂载 `session-query-sqlite` |

## 阶段一做了什么

插件 `dsh-wecom-plugin`：

- 以 Cordis 插件形式导出 `name / inject / apply`（与官方插件同构，例如 `dsh-tool-todo` 的 `export { Config, apply, inject, name }`）
- `inject: ['sessionQuery']`，加载后启动企业微信长连接（复用已验证的 `aibot` + `ws-client`，零依赖，现位于 `lib/aibot.js` / `lib/ws-client.js`）
- 命令：`/ping`、`/id`、`/help`、`/sessions`、`/debug`
- `/sessions` 直接调 `ctx.sessionQuery.listSessions()`；行字段名做了三种兼容（`id`/`sessionId`/`session.id`）
- `/debug` 打印首行字段结构——用来一次性核对本机版本的返回形状
- 其他输入一律回"阶段一只读"

**没有**做的事（留给后两个阶段）：`/use`、续聊、审批转发、历史消息分页。

## 安装与验证

```powershell
cd dsh-wecom-plugin
.\install.ps1 -BotId "aib..." -Secret "gJ..." -AllowUsers "zhangsan"
# 或者不带参数，脚本会交互式问你要 BotId / Secret
.\install.ps1
```

脚本行为（这几条都是踩过的坑）：

- 凭据里的空白（含粘贴带进来的换行）会被清掉；写完后还会校验 `botId` / `secret` 是否在**单行**上，不达标直接报错而不是让你带着坏 YAML 重启。
- 写进 `cordis.patch.yml` 的是**带首尾标记的 `- insert:` 块**，重跑会原地替换，不会重复追加。
- 新插件必须用 `- insert:`；写成顶层 `- id:` 会被 loader 当成"改一个不存在的条目"，只打警告然后忽略。
- 包已 link 时跳过 pnpm，只重写配置。

加载过程的每一步都会落到 `~\.dsh\wecom-plugin.log`（打包版 GUI 看不到主进程 stdout，这是唯一可靠的观测点），正常内容是：

```
module imported (pid …)
apply() called; botId=set secret=set allowUsers=<你的 UserID>
正在连接 wss://openws.work.weixin.qq.com …
企业微信认证成功，开始接收消息
```

然后：

1. **停掉老的独立桥接**（`dsh-wecom` 的 serve 窗口）——两个连接会互踢
2. 完全退出并重新打开 DeepSeek Harness
3. 企业微信里发：

| 输入 | 期望 |
|---|---|
| `/ping` | `pong（插件已加载在 Desktop Host 内）` |
| `/sessions` | 列出桌面版里那些会话（时间、运行中/已落盘、工作目录） |
| `/debug` | `listSessions` 行的实际字段名 + 首行样例 |

把 `/sessions` 与 `/debug` 的回复贴回来，阶段二/三按真实字段写。

## 回滚

```powershell
.\install.ps1 -Uninstall      # 移除配置项，重启即恢复原状
```

或者手工删掉 `~/.dsh/profiles/desktop/cordis.patch.yml` 里的 `wecom-bridge` 那一段。

## 已知风险

| 风险 | 处理 |
|---|---|
| 插件加载失败导致桌面版起不来 | 配置项坏了就按上面的回滚删掉；`inject` 只依赖 sessionQuery，若该服务缺席插件不会挂载 |
| 长连接与 UI 争资源 | 阶段一只读、无定时轮询，消息驱动 |
| 两个 WeCom 连接互踢 | 必须先停老的 independent bridge |
| 插件在 Desktop 里没有独立日志文件 | 日志进桌面版主进程 stdout；打包版可能看不到——这也是阶段二要先确认 `/debug` 能回话的原因 |

