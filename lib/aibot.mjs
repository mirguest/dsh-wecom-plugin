/**
 * 企业微信「智能机器人」WebSocket 长连接客户端（零依赖，Node ≥ 22 自带全局 WebSocket）。
 *
 * 协议来源：@wecom/aibot-node-sdk（腾讯企业微信团队官方实现）v1.0.x
 *   - 连接：wss://openws.work.weixin.qq.com
 *   - 认证：{ cmd:"aibot_subscribe", headers:{req_id}, body:{ bot_id, secret } }
 *   - 心跳：{ cmd:"ping", headers:{req_id} }              （服务端回同一 req_id）
 *   - 回复：{ cmd:"aibot_respond_msg", headers:{req_id: 收到的req_id}, body:{ msgtype:"stream", stream:{ id, finish, content } } }
 *   - 主动：{ cmd:"aibot_send_msg",    headers:{req_id}, body:{ chatid, msgtype:"markdown", markdown:{content} } }
 *   - 下行：{ cmd:"aibot_msg_callback", headers:{req_id}, body:{ msgid, from:{userid}, chattype, text:{content}, ... } }
 *           { cmd:"aibot_event_callback", ... }
 *
 * 这条通道是**出站**的：本机主动连腾讯的网关，因此不需要公网 IP、回调 URL、TLS 证书、可信IP。
 */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { WsSocket } from './ws-client.mjs';

export const DEFAULT_WS_URL = 'wss://openws.work.weixin.qq.com';

export const WsCmd = {
  SUBSCRIBE: 'aibot_subscribe',
  HEARTBEAT: 'ping',
  RESPONSE: 'aibot_respond_msg',
  SEND: 'aibot_send_msg',
  CALLBACK: 'aibot_msg_callback',
  EVENT_CALLBACK: 'aibot_event_callback',
};

/** 与官方 SDK 一致的 req_id 格式：`{prefix}_{timestamp}_{8位随机 hex}` */
export function generateReqId(prefix) {
  return `${prefix}_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

/** 把下行回调 body 归一成桥接层认识的形状（和自建应用回调保持一致） */
export function normalizeMessage(frame) {
  const body = frame?.body ?? {};
  return {
    MsgType: body.msgtype ?? 'unknown',
    FromUserName: body.from?.userid,
    FromUserNameRaw: body.from,
    Content: body.text?.content ?? '',
    MsgId: body.msgid,
    AgentID: body.aibotid,
    chatId: body.chatid,
    chatType: body.chattype,
    reqId: frame?.headers?.req_id,
    raw: frame,
  };
}

export class AibotClient extends EventEmitter {
  constructor({
    botId,
    secret,
    wsUrl = DEFAULT_WS_URL,
    heartbeatMs = 30_000,
    maxMissedHeartbeat = 2,
    reconnectBaseMs = 1000,
    maxReconnectAttempts = 20,
    replyAckTimeoutMs = 10_000,
    socketFactory,
    log = console,
  }) {
    super();
    if (!botId || !secret) throw new Error('aibot: 需要 botId 与 secret（企业微信后台「智能机器人」里获取）');
    this.botId = botId;
    this.secret = secret;
    this.wsUrl = wsUrl;
    this.heartbeatMs = heartbeatMs;
    this.maxMissedHeartbeat = maxMissedHeartbeat;
    this.reconnectBaseMs = reconnectBaseMs;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.replyAckTimeoutMs = replyAckTimeoutMs;
    // 默认用自带的 RFC6455 实现；测试可注入假 socket
    this.socketFactory = socketFactory ?? ((url) => new WsSocket(url));
    this.log = log;

    this.socket = null;
    this.authenticated = false;
    this.closedByUser = false;
    this.reconnectAttempts = 0;
    this.missedHeartbeats = 0;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.pendingAcks = new Map();
    this.queues = new Map();
  }

  get isConnected() {
    return Boolean(this.socket && this.socket.readyState === 1 && this.authenticated);
  }

  connect() {
    this.closedByUser = false;
    this.clearReconnect();
    this.teardownSocket();
    this.authenticated = false;

    let socket;
    try {
      socket = this.socketFactory(this.wsUrl);
    } catch (error) {
      this.log.error?.(`[aibot] 建立连接失败：${error.message}`);
      this.scheduleReconnect();
      return this;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.log.info?.(`[aibot] 已连接 ${this.wsUrl}，发送认证帧…`);
      this.send({
        cmd: WsCmd.SUBSCRIBE,
        headers: { req_id: generateReqId(WsCmd.SUBSCRIBE) },
        body: { bot_id: this.botId, secret: this.secret },
      });
    });

    socket.addEventListener('message', (event) => {
      // 兼容两种形态：自带 WsSocket 直接给字符串，浏览器/ws 给 { data }
      const raw = typeof event === 'string' ? event : String(event?.data ?? '');
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch {
        this.log.warn?.('[aibot] 收到无法解析的帧');
        return;
      }
      this.onFrame(frame);
    });

    socket.addEventListener('close', (event) => {
      this.stopHeartbeat();
      this.authenticated = false;
      this.failPending(`连接已关闭（${event?.code ?? '?'} ${event?.reason ?? ''}）`);
      this.emit('disconnected', event?.reason || `code: ${event?.code ?? '?'}`);
      if (!this.closedByUser) this.scheduleReconnect();
    });

    socket.addEventListener('error', (error) => {
      const message = error?.message ?? error?.error?.message ?? String(error);
      this.log.error?.(`[aibot] 连接错误：${message}`);
      this.emit('error', error instanceof Error ? error : new Error(message));
    });

    return this;
  }

  onFrame(frame) {
    const cmd = frame.cmd ?? '';
    const reqId = frame.headers?.req_id ?? '';

    if (cmd === WsCmd.CALLBACK || cmd === WsCmd.EVENT_CALLBACK) {
      if (frame.body?.event?.eventtype === 'disconnected_event') {
        // 同一机器人有新连接建立，本连接会被服务端断开；不自动重连，避免两边互踢
        this.log.warn?.('[aibot] 服务端提示已有新连接，本连接停止重连');
        this.closedByUser = true;
        this.emit('superseded');
      }
      this.emit('frame', frame);
      if (cmd === WsCmd.CALLBACK) this.emit('message', normalizeMessage(frame));
      else this.emit('event', frame.body?.event ?? {}, frame);
      return;
    }

    if (reqId.startsWith(WsCmd.SUBSCRIBE)) {
      if (frame.errcode !== 0) {
        this.log.error?.(`[aibot] 认证失败 errcode=${frame.errcode} errmsg=${frame.errmsg}`);
        this.emit('error', new Error(`aibot 认证失败：${frame.errmsg}（${frame.errcode}）`));
        this.closedByUser = true;
        this.teardownSocket();
        return;
      }
      this.authenticated = true;
      this.reconnectAttempts = 0;
      this.missedHeartbeats = 0;
      this.startHeartbeat();
      this.log.info?.('[aibot] 认证成功，开始接收消息');
      this.emit('authenticated');
      return;
    }

    if (reqId.startsWith(WsCmd.HEARTBEAT)) {
      if (frame.errcode === 0) this.missedHeartbeats = 0;
      return;
    }

    const pending = this.pendingAcks.get(reqId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingAcks.delete(reqId);
      if (frame.errcode !== 0) pending.reject(new Error(`aibot 回执错误 ${frame.errcode}: ${frame.errmsg}`));
      else pending.resolve(frame);
      this.drain(reqId);
      return;
    }
  }

  send(frame) {
    if (!this.socket || this.socket.readyState !== 1) throw new Error('aibot: 连接未就绪');
    this.socket.send(JSON.stringify(frame));
  }

  /** 同一 req_id 的消息串行发送（服务端按 req_id 回执） */
  enqueue(reqId, frame) {
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(reqId) ?? [];
      queue.push({ frame, resolve, reject });
      this.queues.set(reqId, queue);
      if (queue.length === 1) this.pump(reqId);
    });
  }

  pump(reqId) {
    const queue = this.queues.get(reqId);
    if (!queue?.length) {
      this.queues.delete(reqId);
      return;
    }
    const item = queue[0];
    try {
      this.send(item.frame);
    } catch (error) {
      queue.shift();
      item.reject(error);
      this.pump(reqId);
      return;
    }
    const timer = setTimeout(() => {
      this.pendingAcks.delete(reqId);
      queue.shift();
      item.reject(new Error(`aibot: ${reqId} 回执超时`));
      this.pump(reqId);
    }, this.replyAckTimeoutMs);
    timer.unref?.();
    this.pendingAcks.set(reqId, { resolve: item.resolve, reject: item.reject, timer });
  }

  drain(reqId) {
    const queue = this.queues.get(reqId);
    if (!queue?.length) {
      this.queues.delete(reqId);
      return;
    }
    queue.shift();
    this.pump(reqId);
  }

  /**
   * 流式回复：finish=false 是中间态（会被同一条消息替换），finish=true 是终态。
   * @param {string} reqId 收到的回调帧的 req_id（必须原样透传）
   */
  replyStream(reqId, streamId, content, finish = false) {
    return this.enqueue(reqId, {
      cmd: WsCmd.RESPONSE,
      headers: { req_id: reqId },
      body: { msgtype: 'stream', stream: { id: streamId, finish, content } },
    });
  }

  /** 主动推送（审批提示、超时提醒、异步补发长文） */
  sendMarkdown(chatid, content) {
    const reqId = generateReqId(WsCmd.SEND);
    return this.enqueue(reqId, {
      cmd: WsCmd.SEND,
      headers: { req_id: reqId },
      body: { chatid, msgtype: 'markdown', markdown: { content } },
    });
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.missedHeartbeats >= this.maxMissedHeartbeat) {
        this.log.warn?.('[aibot] 连续心跳无响应，重建连接');
        this.stopHeartbeat();
        this.teardownSocket();
        this.scheduleReconnect();
        return;
      }
      this.missedHeartbeats += 1;
      try {
        this.send({ cmd: WsCmd.HEARTBEAT, headers: { req_id: generateReqId(WsCmd.HEARTBEAT) } });
      } catch {
        /* close 事件会接管 */
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  scheduleReconnect() {
    if (this.closedByUser) return;
    if (this.maxReconnectAttempts !== -1 && this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log.error?.(`[aibot] 重连次数已达上限（${this.maxReconnectAttempts}）`);
      this.emit('error', new Error('aibot: 重连次数已达上限'));
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(this.reconnectBaseMs * 2 ** (this.reconnectAttempts - 1), 30_000);
    this.log.warn?.(`[aibot] ${delay}ms 后第 ${this.reconnectAttempts} 次重连`);
    this.emit('reconnecting', this.reconnectAttempts);
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  failPending(reason) {
    for (const [reqId, pending] of this.pendingAcks) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${reason}（req_id ${reqId}）`));
    }
    this.pendingAcks.clear();
    this.queues.clear();
  }

  teardownSocket() {
    if (!this.socket) return;
    try {
      this.socket.removeEventListener?.('open', () => {});
      this.socket.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }

  close() {
    this.closedByUser = true;
    this.clearReconnect();
    this.stopHeartbeat();
    this.failPending('客户端主动关闭');
    this.teardownSocket();
  }
}
