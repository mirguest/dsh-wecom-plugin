# dsh-wecom-plugin

> 在 DSH Desktop Host **进程内**接入企业微信智能机器人，让手机能列出、查看、续跑桌面上的那条会话。

一个 [DeepSeek Harness](https://github.com/)（DSH）Cordis 插件。企业微信侧走智能机器人的 **WebSocket 长连接**（出站，无需公网 IP / 回调 URL / 可信 IP）。

---

## 为什么是"插件"而不是"桥接服务"

DSH Desktop 的会话由它自己的进程持有写句柄。任何**另一个进程**去 `resume` 同一条会话都会被拒绝：

```
session "..." is already owned by an active write handle
```

所以要把手机接到桌面那条会话上，唯一的位置就是 **Desktop Host 进程内部**——插件与桌面 UI 共享同一个 Cordis 容器、同一个 Agent Runtime，因此天然看到同一批会话、同一条消息流，也不会产生跨进程写入。

## 工作原理

```
企业微信 App
   │  ① 发消息
   ▼
openws.work.weixin.qq.com  ──② 长连接（本机主动连出）──▶  dsh-wecom-plugin
                                                          （跑在 Desktop Host 进程内）
                                                             │ ③ ctx.sessionQuery
                                                             │    ctx.agents
                                                             ▼
                                                     Desktop 的 Agent Runtime
                                                             │
                                                    ④ 会话事件 / 工具执行
```

| 能力 | 用到的 Host API |
|---|---|
| 列出会话 | `ctx.sessionQuery.listSessions()` |
| 读历史 | `ctx.sessionQuery.readSession(id)` |
| 取活动 Agent | `ctx.agents.get(sessionId)` |
| 恢复冷会话 | `ctx.agents.resume({ resumeSessionId, agentOptions })` |
| 投递一轮输入 | `agent.followup({ id, role:'user', content, source:{kind:'user'} })` |
| 审批 | `approval/request` waterfall 应答者 |

## 安装

```powershell
# 在插件目录里执行
.\install.ps1 -BotId "aib..." -Secret "gPJ..." -AllowUsers "zhangsan"
# 或者不带参数，脚本会交互式询问
.\install.ps1
```

脚本做两件事：把本仓库 `link:` 进 `~/.dsh/profiles/desktop/node_modules`，并在 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加：

```yaml
# >>> wecom-bridge (managed by install.ps1)
- insert:
    - id: wecom-bridge
      name: dsh-wecom-plugin
      config:
        botId: "aib..."
        secret: "gPJ..."
        allowUsers: ["<你的企业微信 UserID>"]
# <<< wecom-bridge
```

> 新插件**必须**走 `- insert:`。写成顶层 `- id:` 会被 loader 当成"覆盖一个不存在的条目"，只打一条警告然后忽略。

重启 DeepSeek Harness。加载过程会写到 `~/.dsh/wecom-plugin.log`：

```
module imported (pid …)
apply() called; botId=set secret=set allowUsers=<你的 UserID>
正在连接 wss://openws.work.weixin.qq.com …
企业微信认证成功，开始接收消息
```

卸载：`.\install.ps1 -Uninstall`（移除配置块，不影响已装包）。

## 命令

| 命令 | 作用 |
|---|---|
| `/sessions` | 列出 Desktop 全部会话（标题 / 短 id / 时间 / 运行中 / 已落盘 / 格式状态 / 工作目录） |
| `/read <序号> [条数]` | 看某条会话的历史对话（只读，过滤系统注入上下文） |
| `/use <序号\|sessionId>` | 绑定会话；之后直接发文字即投递进去 |
| `/status` | 当前绑定与运行状态 |
| `/unuse` | 解除绑定 |
| `/ping` `/id` `/debug` `/help` | 连通性与诊断 |

审批：触发 `ask` 策略的工具操作会推到企业微信，回 `1` 允许一次、`2` 拒绝（3 分钟不回按取消）。未绑定会话的审批仍由桌面端应答，插件不接管。

## 已知边界

- **没有实时双向同步**：手机看到的是"这一轮结束后"的结果，桌面正在跑的过程不可见。
- 审批是双端并存、先答先得。
- `/read` 一次最多 30 条，没有分页。
- 一次只能绑定一条会话。

## 安全

- `allowUsers` 白名单，非白名单直接拒绝，不触发任何会话操作。
- 凭据只存在于 `~/.dsh/profiles/desktop/cordis.patch.yml`（本机，未提交到仓库）。
- 插件不做任何 HTTP 入站监听；只有一条出站 WSS。
- 高风险操作仍走 Host 的审批 seam，插件只是把询问转发给人。

## 开发

```bash
npm test          # 4 个测试文件，纯 Node，无需 DSH 运行时
```

```
lib/index.js      Cordis 插件：命令路由、审批应答者、会话读写
lib/aibot.mjs     企业微信长连接客户端（认证/心跳/重连/流式回复）
lib/ws-client.mjs 零依赖 RFC6455 客户端（Node 内置 WebSocket 与该网关握手会失败）
test/*.test.mjs   离线单测
docs/PHASES.md    分阶段实施记录与踩过的坑
```

## 兼容性

实测于 DSH Desktop **0.2.2-rc.1**（Windows）。依赖的是 Host 内部的 `sessionQuery` / `agents` / `approval` seam，属于跨版本可能变动的接口；升级 DSH 后先看 `~/.dsh/wecom-plugin.log` 是否仍然 `认证成功`。

## License

MIT
