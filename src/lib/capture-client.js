import { PCMResampler } from './audio-pipeline.js';

export class CaptureClient {
  constructor({ meetingId, onState = () => {}, onPartial = () => {}, onError = () => {}, onCommand = () => {} }) {
    Object.assign(this, { meetingId, onState, onPartial, onError, onCommand });
    this.state = { connected: false, state: 'idle' };
    this.streams = []; this.commands = new Map(); this.processing = new Set();
    this.ws = null; this.disconnected = false; this.flushed = null; this.ready = null;
  }
  connect() {
    if (this.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) return;
    this.disconnected = false;
    const url = new URL('/ws/capture', window.location.href);
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('meetingId', this.meetingId);
    const ws = this.ws = new WebSocket(url);
    let pingTimer;
    ws.onopen = () => {
      if (this.ws !== ws || this.disconnected) { ws.close(); return; }
      this.setState({ connected: true });
      this.lastPong = Date.now();
      this.pingTimer = pingTimer = setInterval(() => {
        if (this.ws !== ws || this.disconnected) return;
        if (Date.now() - this.lastPong > 12000 || (this.context && Date.now() - this.lastSaved > 12000)) {
          // The socket is also used while browsing or waiting to record. A lost
          // heartbeat then means reconnecting transport, not lost microphone audio.
          if (this.hasCaptureActivity()) this.fail('录音保存连接中断，请重新打开会议并授权');
          this.setState({ connected: false }); ws.close();
        } else this.send({ type: 'ping' });
      }, 3000);
    };
    ws.onmessage = event => {
      if (this.ws !== ws || this.disconnected) return;
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'state') { const { type, ...patch } = message; this.setState(patch); }
      else if (message.type === 'partial') this.onPartial(message);
      else if (message.type === 'pong') this.lastPong = Date.now();
      else if (message.type === 'saved') { this.lastSaved = Date.now(); this.savedSamples = message.sampleCount; }
      else if (message.type === 'ready') { this.ready?.resolve(message); this.ready = null; }
      else if (message.type === 'interrupted') this.fail(message.message, false);
      else if (message.type === 'command') {
        const command = message.command;
        this.commands.set(command.id, command); this.onCommand(command);
        if (command.status === 'running' && ['pause', 'stop', 'end'].includes(command.action)) this.drain(command);
        if (command.status === 'error') {
          if (this.ready?.commandId === command.id) { this.ready.reject(new Error(command.error || '录音命令失败')); this.ready = null; }
          this.onError(command.error || '录音命令失败');
        }
      }
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      if (this.pingTimer === pingTimer) this.pingTimer = null;
      if (this.ws !== ws) return;
      const capturing = this.hasCaptureActivity();
      this.cleanupAudio();
      this.ready?.reject(new Error('录音连接已断开')); this.ready = null;
      this.setState({ connected: false, ...(capturing ? { state: 'interrupted', error: '录音连接已断开' } : {}) });
      if (!this.disconnected) {
        if (capturing) this.onError('录音连接已断开；已保存的录音仍可回听');
        this.reconnectTimer = setTimeout(() => this.connect(), 1500);
      }
    };
    ws.onerror = () => { if (this.ws === ws && !this.disconnected && this.hasCaptureActivity()) this.onError('无法连接录音服务，请确认本地服务正在运行'); };
  }
  hasCaptureActivity() { return Boolean(this.context || this.starting || this.ready || this.processing.size); }
  setState(patch) { this.state = { ...this.state, ...patch }; this.onState(this.state); }
  send(message) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('录音保存连接未就绪');
    this.ws.send(JSON.stringify(message));
  }
  async request(action) {
    const response = await fetch(`/api/meetings/${encodeURIComponent(this.meetingId)}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
    const command = await response.json();
    if (!response.ok) throw new Error(command.error || '录音操作失败');
    this.commands.set(command.id, command); this.onCommand(command);
    if (command.status === 'error') this.onError(command.error);
    return command;
  }
  executeCommand(commandId, audioSource = 'microphone') { return this.startFromGesture(commandId, audioSource); }
  async startFromGesture(commandId, audioSource = 'microphone') {
    if (this.context || this.starting) return;
    const command = this.commands.get(commandId);
    if (!command || command.status !== 'needs_user_action') throw new Error('请重新发起录音命令');
    this.starting = true;
    try {
      if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('录音保存连接未就绪');
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风采集，请使用本机浏览器');
      // getDisplayMedia must be invoked synchronously from the user's click.
      let displayPromise;
      if (audioSource === 'meeting') {
        if (!navigator.mediaDevices.getDisplayMedia) throw new Error('当前浏览器不支持会议声音采集');
        displayPromise = navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include' });
      }
      if (displayPromise) {
        const display = await displayPromise; this.streams.push(display);
        if (!display.getAudioTracks().length) throw new Error('未获得会议声音，请选择共享音频，或改用麦克风');
      }
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      this.streams.push(microphone);
      if (this.disconnected) throw new Error('已离开会议，录音授权已取消');
      if (this.commands.get(commandId)?.status !== 'needs_user_action') throw new Error('录音授权命令已取消，请重新开始');
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioContext();
      await this.context.suspend();
      await this.context.audioWorklet.addModule('/pcm-worklet.js');
      this.resampler = new PCMResampler(this.context.sampleRate);
      this.worklet = new AudioWorkletNode(this.context, 'pcm-capture');
      this.worklet.port.onmessage = event => {
        if (event.data.type === 'audio') this.writePCM(event.data.chunk);
        else if (event.data.type === 'flushed') { this.writePCM(new Float32Array(0), true); this.flushed?.(); this.flushed = null; }
      };
      this.worklet.onprocessorerror = () => this.fail('音频处理器停止运行，请重新授权录音');
      this.mix = this.context.createGain(); this.mix.gain.value = this.streams.length > 1 ? 0.65 : 1;
      for (const stream of this.streams) {
        const source = this.context.createMediaStreamSource(stream); source.connect(this.mix);
        for (const track of stream.getTracks()) track.onended = () => { if (!this.cleaning) this.fail('音频设备或共享来源已断开，请重新授权录音'); };
      }
      this.mix.connect(this.worklet);
      const muted = this.context.createGain(); muted.gain.value = 0;
      this.worklet.connect(muted); muted.connect(this.context.destination);
      const ready = new Promise((resolve, reject) => { this.ready = { resolve, reject, commandId }; });
      this.send({ type: 'begin', commandId });
      await ready;
      this.lastSaved = Date.now();
      await this.context.resume();
    } catch (error) {
      this.cleanupAudio();
      try { this.send({ type: 'failed', commandId, message: error.name === 'NotAllowedError' ? '音频授权被拒绝，请重新授权' : error.message }); } catch { /* connection error is already visible */ }
      this.onError(error.name === 'NotAllowedError' ? '音频授权被拒绝，请重新授权' : error.message);
    } finally { this.starting = false; }
  }
  writePCM(chunk, final = false) {
    if (!this.resampler) return;
    const pcm = this.resampler.push(chunk, final);
    if (!pcm.byteLength) return;
    if (this.ws?.readyState !== WebSocket.OPEN || this.ws.bufferedAmount > 512000) { this.fail('音频保存连接拥堵或断开，录音已停止'); return; }
    this.ws.send(pcm);
  }
  async drain(command) {
    if (this.processing.has(command.id)) return;
    this.processing.add(command.id);
    try {
      if (!this.worklet || !this.context) throw new Error('浏览器没有正在采集的音频');
      // The worklet sends its short batch before the flushed marker. WS ordering
      // therefore guarantees the server receives the final PCM before drained.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.flushed = null; reject(new Error('音频处理器未能保存尾段')); }, 3000);
        this.flushed = () => { clearTimeout(timer); resolve(); };
        this.worklet.port.postMessage({ type: 'flush' });
      });
      this.cleanupAudio();
      this.send({ type: 'drained', commandId: command.id });
    } catch (error) { this.fail(error.message); }
    finally { this.processing.delete(command.id); }
  }
  fail(message, notifyServer = true) {
    // Late worklet/socket events after stop must not turn an idle meeting into a
    // failed recording. Actual capture and pending audio setup still fail loudly.
    if (!this.hasCaptureActivity()) return;
    this.ready?.reject(new Error(message)); this.ready = null;
    this.cleanupAudio();
    if (notifyServer) { try { this.send({ type: 'failed', message }); } catch { /* disconnected */ } }
    this.setState({ state: 'interrupted', error: message }); this.onError(message); this.onPartial({ text: '' });
  }
  cleanupAudio() {
    this.cleaning = true;
    this.worklet?.disconnect(); this.mix?.disconnect();
    for (const stream of this.streams) for (const track of stream.getTracks()) { track.onended = null; track.stop(); }
    this.streams = [];
    this.context?.close().catch(() => {});
    this.context = null; this.worklet = null; this.mix = null; this.resampler = null;
    this.cleaning = false;
  }
  disconnect() {
    this.disconnected = true; clearTimeout(this.reconnectTimer); clearInterval(this.pingTimer);
    this.ready?.reject(new Error('已离开会议')); this.ready = null;
    this.cleanupAudio(); this.ws?.close(); this.ws = null;
  }
}
