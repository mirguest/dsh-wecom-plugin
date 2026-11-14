import assert from 'node:assert/strict';
import { AibotClient, generateReqId, normalizeMessage, WsCmd } from '../lib/aibot.js';

// req_id 格式：prefix_timestamp_8位hex
assert.match(generateReqId('stream'), /^stream_\d+_[0-9a-f]{8}$/);

// 下行回调归一化
const msg = normalizeMessage({
  headers: { req_id: 'req-1' },
  body: { msgtype: 'text', from: { userid: 'zhangsan' }, text: { content: 'hi' }, msgid: 'm1', chatid: 'c1' },
});
assert.equal(msg.FromUserName, 'zhangsan');
assert.equal(msg.Content, 'hi');
assert.equal(msg.reqId, 'req-1');
assert.equal(msg.chatId, 'c1');

// 同一 req_id 串行发送 + 断连结算（队列里未发出的消息也要 reject，不能悬挂）
{
  const frames = [];
  const client = new AibotClient({ botId: 'b', secret: 's', socketFactory: () => ({ readyState: 1, addEventListener() {}, send: (d) => frames.push(d) }) });
  client.socket = { readyState: 1, send: (d) => frames.push(d) };

  const p1 = client.enqueue('r1', { cmd: 'x' });
  const p2 = client.enqueue('r1', { cmd: 'y' });
  assert.equal(frames.length, 1, '队头先发，后面的排队');
  client.failPending('测试断连');
  await assert.rejects(p1, /测试断连/);
  await assert.rejects(p2, /测试断连/);
}

// 回执驱动排水：ack 后下一条才发出
{
  const frames = [];
  const client = new AibotClient({ botId: 'b', secret: 's' });
  client.socket = { readyState: 1, send: (d) => frames.push(d) };
  const p1 = client.replyStream('r2', 's1', 'one');
  const p2 = client.replyStream('r2', 's1', 'two');
  assert.equal(frames.length, 1);
  client.onFrame({ headers: { req_id: 'r2' }, errcode: 0 });
  await p1;
  assert.equal(frames.length, 2, 'ack 后才发下一条');
  client.onFrame({ headers: { req_id: 'r2' }, errcode: 0 });
  await p2;
}

// 回执错误 → reject
{
  const client = new AibotClient({ botId: 'b', secret: 's' });
  client.socket = { readyState: 1, send: () => {} };
  const p = client.sendMarkdown('c', 'hi');
  client.onFrame({ headers: { req_id: client.pendingAcks.keys().next().value }, errcode: 1, errmsg: 'bad' });
  await assert.rejects(p, /bad/);
}

// 断连后的事件不能误伤新连接（socket 身份守卫）
{
  const registry = new Map();
  const oldSock = { readyState: 1, addEventListener: (type, fn) => registry.set(type, fn), send: () => {} };
  const client = new AibotClient({ botId: 'b', secret: 's', socketFactory: () => oldSock });
  client.connect(); // 把事件监听器挂到 oldSock 上
  let disconnected = 0;
  client.on('disconnected', () => { disconnected += 1; });
  client.socket = null; // 模拟 connect() 已切换到新连接
  registry.get('close')?.({ code: 1000, reason: 'stale' }); // 旧连接的迟到 close 事件
  assert.equal(disconnected, 0, '旧连接的迟到 close 不应触发 disconnected');
  client.close();
  assert.equal(WsCmd.CALLBACK, 'aibot_msg_callback');
}
