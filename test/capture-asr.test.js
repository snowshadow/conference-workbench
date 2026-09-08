import test from 'node:test';
import assert from 'node:assert/strict';
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
  const sockets = [], received = [], results = [], gaps = [], states = [];
  server.on('connection', ws => {
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
