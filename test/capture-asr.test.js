import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createASRSession } from '../server/capture/asr.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const end = Date.now() + 3500; while (Date.now() < end) { if (predicate()) return; await pause(10); } throw new Error('ASR test timed out'); }
function response(utterances, final = false) {
  const payload = Buffer.from(JSON.stringify({ result: { utterances } }));
  const header = final ? Buffer.from([0x11, 0x93, 0x10, 0, 0xff, 0xff, 0xff, 0xff]) : Buffer.from([0x11, 0x90, 0x10, 0]);
  const length = Buffer.alloc(4); length.writeUInt32BE(payload.length);
  return Buffer.concat([header, length, payload]);
}

test('ASR reconnect carries a new PCM epoch, marks unfinished speech and drains final response', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const sockets = [], received = [], results = [], gaps = [], states = [], connectionIds = [];
  server.on('connection', (ws, request) => {
    connectionIds.push(request.headers['x-api-connect-id']);
    sockets.push(ws); const frames = []; received.push(frames);
    ws.on('message', data => {
      const frame = Buffer.from(data); frames.push(frame);
      if (frame[1] === 0x22) ws.send(response([{ text: '尾句', start_time: 0, end_time: 100, definite: false }], true));
    });
  });
  const session = createASRSession({ config: { apiKey: 'test-only', url: `ws://127.0.0.1:${server.address().port}` },
    onTranscript: result => results.push(result), onGap: gap => gaps.push(gap), onState: state => states.push(state),
  });
  t.after(async () => { session.close(); for (const ws of sockets) ws.terminate(); await new Promise(resolve => server.close(resolve)); });
  session.push(Buffer.alloc(3200), 0);
  await until(() => received[0]?.length === 2);
  sockets[0].send(response([{ text: '连接前', start_time: 0, end_time: 50, definite: true }]));
  await until(() => results.length === 1);
  sockets[0].close();
  await until(() => gaps.length > 0);
  session.push(Buffer.alloc(3200), 1600);
  await until(() => received[1]?.length === 2);
  const final = await session.finish();
  assert.equal(final.drained, true);
  assert.equal(results.at(-1).epochStartSample, 1600);
  assert.equal(results[0].recognitionSessionId, connectionIds[0]);
  assert.equal(results.at(-1).recognitionSessionId, connectionIds[1]);
  assert.notEqual(results[0].recognitionSessionId, results.at(-1).recognitionSessionId);
  assert.equal(results.at(-1).utterances[0].definite, true);
  assert.equal(gaps[0].startSample, 800); assert.equal(gaps[0].endSample, 1600);
  assert.ok(states.some(s => s.asrState === 'reconnecting'));
  assert.equal(states.at(-1).asrState, 'stopped');
});

test('unconfigured ASR creates an explicit gap without preventing audio saving', async () => {
  const gaps = [], states = [];
  const session = createASRSession({ config: {}, onState: s => states.push(s), onTranscript() {}, onGap: g => gaps.push(g) });
  session.push(Buffer.alloc(3200), 0);
  const result = await session.finish();
  assert.equal(result.drained, false); assert.equal(states.at(-1).asrState, 'unconfigured');
  assert.equal(gaps[0].startSample, 0); assert.equal(gaps[0].endSample, 1600);
});

for (const status of [401, 403]) test(`HTTP ${status} stops ASR retries, marks continued audio gaps and preserves its diagnosis after finish`, async t => {
  let attempts = 0;
  const server = http.createServer((_request, response) => {
    attempts++;
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Invalid X-Api-Key fixture-private-key' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const states = [], gaps = [], results = [];
  const session = createASRSession({ config: { apiKey: 'fixture-private-key', url: `ws://127.0.0.1:${server.address().port}` },
    onState: state => states.push(state), onGap: gap => gaps.push(gap), onTranscript: result => results.push(result),
  });
  t.after(async () => { session.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  session.push(Buffer.alloc(3200), 0);
  await until(() => states.at(-1)?.asrState === 'error');
  const failure = states.at(-1);
  assert.match(failure.asrError, new RegExp(`HTTP ${status}`));
  assert.match(failure.asrError, status === 401 ? /鉴权失败.*API Key/ : /资源权限/);
  assert.deepEqual(gaps.map(({ startSample, endSample }) => [startSample, endSample]), [[0, 1600]]);

  // More than the normal eight-second waiting queue: rejected sessions report
  // the whole new interval immediately instead of retaining/retrying PCM.
  session.push(Buffer.alloc(320_000), 1600);
  assert.deepEqual(gaps.map(({ startSample, endSample }) => [startSample, endSample]), [[0, 1600], [1600, 161600]]);
  assert.ok(gaps.every(gap => gap.reason === failure.asrError));
  await pause(1150);
  assert.equal(attempts, 1, 'authentication failures must not create another upstream request');
  assert.deepEqual(results, []);
  assert.deepEqual(await session.finish(), { drained: false });
  assert.deepEqual(await session.finish(), { drained: false }, 'finishing again has the same result');
  assert.deepEqual(states.at(-1), failure, 'pause/finish retains the useful authentication diagnosis');
  assert.equal(gaps.length, 2, 'finish does not duplicate gaps already recorded after rejection');
  assert.doesNotMatch(JSON.stringify({ states, gaps, results }), /fixture-private-key|Invalid X-Api-Key/);
});

test('temporary HTTP failure retries queued PCM and can finish successfully', async t => {
  let attempts = 0;
  const server = http.createServer(), upstream = new WebSocketServer({ noServer: true });
  const sockets = [], received = [], states = [], results = [], gaps = [];
  server.on('upgrade', (request, socket, head) => {
    attempts++;
    if (attempts === 1) { socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n'); return; }
    upstream.handleUpgrade(request, socket, head, ws => {
      sockets.push(ws);
      ws.on('message', data => {
        const frame = Buffer.from(data); received.push(frame);
        if (frame[1] === 0x22) ws.send(response([{ text: '服务恢复后的尾句', start_time: 0, end_time: 200, definite: false }], true));
      });
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const session = createASRSession({ config: { apiKey: 'test-only', url: `ws://127.0.0.1:${server.address().port}` },
    onState: state => states.push(state), onTranscript: result => results.push(result), onGap: gap => gaps.push(gap),
  });
  t.after(async () => { session.close(); for (const ws of sockets) ws.terminate(); upstream.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  session.push(Buffer.alloc(3200, 1), 0);
  await until(() => states.some(state => /HTTP 503/.test(state.asrError || '')));
  assert.equal(states.at(-1).asrState, 'reconnecting');
  session.push(Buffer.alloc(3200, 2), 1600);
  await until(() => received.length === 3);
  assert.equal(attempts, 2);
  assert.deepEqual(received.slice(1).map(frame => frame.subarray(8)), [Buffer.alloc(3200, 1), Buffer.alloc(3200, 2)]);
  const firstFinish = session.finish(), secondFinish = session.finish();
  assert.equal(firstFinish, secondFinish, 'concurrent stop callers wait for the same final response');
  assert.deepEqual(await firstFinish, { drained: true });
  assert.equal(results.at(-1).epochStartSample, 0);
  assert.equal(results.at(-1).utterances[0].definite, true);
  assert.deepEqual(states.at(-1), { asrState: 'stopped', asrError: null });
  assert.deepEqual(gaps, [], 'a failed handshake does not lose audio that was queued and later transcribed');
});

test('stopping during a temporary connection failure keeps its cause and marks the unsent tail', async t => {
  const server = http.createServer((_request, response) => { response.writeHead(429); response.end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const states = [], gaps = [];
  const session = createASRSession({ config: { apiKey: 'test-only', url: `ws://127.0.0.1:${server.address().port}` },
    onState: state => states.push(state), onGap: gap => gaps.push(gap), onTranscript() {},
  });
  t.after(async () => { session.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  session.push(Buffer.alloc(3200), 0);
  await until(() => states.some(state => /HTTP 429/.test(state.asrError || '')));
  const reason = states.at(-1).asrError;
  assert.deepEqual(await session.finish(), { drained: false });
  await pause(20); // A late close/error from the rejected socket must not erase it.
  assert.deepEqual(states.at(-1), { asrState: 'error', asrError: reason });
  assert.deepEqual(gaps, [{ startSample: 0, endSample: 1600, reason }]);
});

test('a protocol configuration rejection stops retrying and keeps already confirmed speech outside the gap', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const sockets = [], states = [], results = [], gaps = [];
  server.on('connection', ws => { sockets.push(ws); });
  const session = createASRSession({ config: { apiKey: 'test-only', url: `ws://127.0.0.1:${server.address().port}` },
    onState: state => states.push(state), onTranscript: result => results.push(result), onGap: gap => gaps.push(gap),
  });
  t.after(async () => { session.close(); for (const ws of sockets) ws.terminate(); await new Promise(resolve => server.close(resolve)); });
  session.push(Buffer.alloc(3200), 0);
  await until(() => states.at(-1)?.asrState === 'connected');
  sockets[0].send(response([{ text: '已经确认', start_time: 0, end_time: 50, definite: true }]));
  await until(() => results.length === 1);
  const payload = Buffer.from('fixture-private-error-body'), header = Buffer.from([0x11, 0xf0, 0x10, 0]);
  const codeAndSize = Buffer.alloc(8); codeAndSize.writeUInt32BE(45000001, 0); codeAndSize.writeUInt32BE(payload.length, 4);
  sockets[0].send(Buffer.concat([header, codeAndSize, payload]));
  await until(() => states.at(-1)?.asrState === 'error');
  assert.match(states.at(-1).asrError, /请求参数无效.*45000001/);
  assert.deepEqual(gaps.map(({ startSample, endSample }) => [startSample, endSample]), [[800, 1600]]);
  session.push(Buffer.alloc(3200), 1600);
  await pause(1150);
  assert.equal(sockets.length, 1);
  assert.deepEqual(await session.finish(), { drained: false });
  assert.deepEqual(gaps.map(({ startSample, endSample }) => [startSample, endSample]), [[800, 1600], [1600, 3200]]);
  assert.doesNotMatch(JSON.stringify({ states, gaps }), /fixture-private-error-body/);
});
