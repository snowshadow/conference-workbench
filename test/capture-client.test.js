import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { PCMResampler } from '../src/lib/audio-pipeline.js';

function fixture() {
  let now = 0, nextTimer = 0;
  const timers = new Map(), sockets = [], errors = [], states = [];
  const schedule = (callback, delay, repeat) => { const id = ++nextTimer; timers.set(id, { callback, delay, repeat, at: now + delay }); return id; };
  function advance(milliseconds) {
    const target = now + milliseconds;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; now = timer.at;
      if (timer.repeat) timer.at += timer.delay; else timers.delete(id);
      timer.callback();
    }
    now = target;
  }
  class FakeWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    send(data) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : data); }
    message(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const sandbox = { PCMResampler, URL, Date: { now: () => now }, WebSocket: FakeWebSocket,
    window: { location: { href: 'http://127.0.0.1:8797/', protocol: 'http:' } },
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: id => timers.delete(id),
    setTimeout: (fn, ms) => schedule(fn, ms, false), clearTimeout: id => timers.delete(id),
  };
  const source = fs.readFileSync(new URL('../src/lib/capture-client.js', import.meta.url), 'utf8').replace(/^import .+;\n/, '').replace('export class CaptureClient', 'class CaptureClient');
  vm.runInNewContext(`${source}\nglobalThis.CaptureClient = CaptureClient;`, sandbox);
  const client = new sandbox.CaptureClient({ meetingId: 'fixture-meeting', onState: value => states.push(value), onError: message => errors.push(message) });
  return { client, sockets, states, errors, timers, advance };
}

test('idle heartbeat loss reconnects without claiming audio loss or sending a failed frame', () => {
  const f = fixture(); f.client.connect(); const socket = f.sockets[0]; socket.open();
  f.advance(15000);
  assert.equal(f.client.state.connected, false); assert.equal(f.client.state.state, 'idle');
  assert.equal(f.client.state.error, undefined); assert.deepEqual(f.errors, []);
  assert.equal(socket.sent.some(message => message.type === 'failed'), false);
  f.advance(1500); assert.equal(f.sockets.length, 2);
  f.sockets[1].open(); f.sockets[1].message({ type: 'state', connected: true, state: 'idle', error: null });
  assert.equal(f.client.state.connected, true); assert.equal(f.client.state.error, null);
  f.client.disconnect(); assert.equal(f.timers.size, 0);
});

test('missing save acknowledgements during actual capture still stop audio and report interruption', () => {
  const f = fixture(); f.client.connect(); const socket = f.sockets[0]; socket.open();
  let closed = false;
  f.client.context = { close() { closed = true; return Promise.resolve(); } };
  f.client.lastSaved = 0;
  f.advance(12000); socket.message({ type: 'pong' }); f.advance(3000);
  assert.equal(closed, true); assert.equal(f.client.context, null);
  assert.equal(f.client.state.state, 'interrupted'); assert.match(f.client.state.error, /录音保存连接中断/);
  assert.equal(socket.sent.filter(message => message.type === 'failed').length, 1);
  assert.ok(f.errors.some(message => message.includes('录音保存连接中断')));
  f.client.disconnect();
});

test('late socket events cannot replace a newer connection or cancel its heartbeat', () => {
  const f = fixture(); f.client.connect(); const old = f.sockets[0]; old.open(); old.close();
  f.advance(1500); const current = f.sockets[1]; current.open();
  old.message({ type: 'state', state: 'interrupted', error: 'stale failure' });
  old.onclose(); old.onerror();
  assert.equal(f.client.state.connected, true); assert.equal(f.client.state.state, 'idle');
  f.advance(3000); assert.equal(current.sent.filter(message => message.type === 'ping').length, 1);
  assert.deepEqual(f.errors, []);
  f.client.disconnect(); current.onopen();
  assert.equal(f.client.state.error, undefined); assert.equal(f.timers.size, 0);
});
