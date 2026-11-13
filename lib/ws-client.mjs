/**
 * 极简 WebSocket 客户端（RFC 6455 子集），只做企业微信长连接需要的部分：
 *  - HTTPS 升级握手 + Sec-WebSocket-Accept 校验
 *  - 文本帧收发（客户端侧强制掩码）
 *  - ping/pong、close、单帧分片拼接
 *
 * 为什么不用 Node 自带的全局 WebSocket：实测在本机上 undici 的实现与
 * wss://openws.work.weixin.qq.com 握手失败（原始 HTTP Upgrade 返回 101 正常），
 * 自己实现反而更稳，也能兼容 Node 18。
 */
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:https';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const mask = randomBytes(4);
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | data.length;
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

export class WsSocket extends EventEmitter {
  constructor(url, { timeoutMs = 10_000, headers = {} } = {}) {
    super();
    this.url = new URL(url);
    this.readyState = 0; // 0 connecting, 1 open, 2 closing, 3 closed
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = null;

    const key = randomBytes(16).toString('base64');
    const req = request({
      protocol: 'https:',
      hostname: this.url.hostname,
      port: this.url.port || 443,
      path: `${this.url.pathname || '/'}${this.url.search}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        ...headers,
      },
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`ws: 握手超时（${timeoutMs}ms）`));
    });

    req.on('upgrade', (res, socket) => {
      const expected = createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        this._fail(new Error('ws: Sec-WebSocket-Accept 校验失败'));
        return;
      }
      this.socket = socket;
      this.readyState = 1;
      socket.setNoDelay(true);
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('close', () => this._onClose());
      socket.on('error', (error) => this._fail(error));
      this.emit('open');
    });

    req.on('response', (res) => {
      res.resume();
      this._fail(new Error(`ws: 握手被拒绝（HTTP ${res.statusCode}）`));
    });

    req.on('error', (error) => this._fail(error));
    req.end();
    this._req = req;
  }

  _fail(error) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('error', error);
    this.emit('close', { code: 1006, reason: error.message });
  }

  _onClose() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code: 1000, reason: '' });
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    for (;;) {
      const frame = this._readFrame();
      if (!frame) return;
      this._dispatch(frame);
    }
  }

  _readFrame() {
    const buf = this._buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) return null;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return null;
      length = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    let mask;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + length) return null;
    let payload = buf.subarray(offset, offset + length);
    if (masked) {
      const out = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i += 1) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    this._buffer = buf.subarray(offset + length);
    return { fin, opcode, payload };
  }

  _dispatch({ fin, opcode, payload }) {
    if (opcode === OPCODE.PING) {
      this._write(encodeFrame(OPCODE.PONG, payload));
      return;
    }
    if (opcode === OPCODE.PONG) return;
    if (opcode === OPCODE.CLOSE) {
      try {
        this._write(encodeFrame(OPCODE.CLOSE, payload.subarray(0, 2)));
      } catch {
        /* ignore */
      }
      this.socket?.end();
      return;
    }
    if (opcode === OPCODE.CONT) {
      this._fragments.push(payload);
    } else {
      this._fragments = [payload];
      this._fragmentOpcode = opcode;
    }
    if (!fin) return;
    const data = Buffer.concat(this._fragments);
    this._fragments = [];
    this._fragmentOpcode = null;
    this.emit('message', data.toString('utf8'));
  }

  _write(buf) {
    this.socket.write(buf);
  }

  send(text) {
    if (this.readyState !== 1) throw new Error('ws: 连接未就绪');
    this._write(encodeFrame(OPCODE.TEXT, text));
  }

  close() {
    if (this.readyState !== 1) {
      this.readyState = 3;
      return;
    }
    this.readyState = 2;
    try {
      this._write(encodeFrame(OPCODE.CLOSE, Buffer.alloc(0)));
    } catch {
      /* ignore */
    }
    this.socket?.end();
  }

  /** 与浏览器 WebSocket 对齐的最小事件接口，便于替换/测试 */
  addEventListener(type, handler) {
    this.on(type, handler);
  }

  removeEventListener(type, handler) {
    this.off(type, handler);
  }
}

/** 工厂：给 AibotClient 的默认 socketFactory */
export function connectWebSocket(url, options) {
  return new WsSocket(url, options);
}
