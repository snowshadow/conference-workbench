const BATCH_SAMPLES = 2048;
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(BATCH_SAMPLES); this.offset = 0; this.stopped = false;
    this.port.onmessage = event => {
      if (event.data?.type === 'flush') {
        this.stopped = true;
        if (this.offset) { const chunk = this.buffer.slice(0, this.offset); this.port.postMessage({ type: 'audio', chunk }, [chunk.buffer]); }
        this.offset = 0;
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }
  process(inputs) {
    if (this.stopped) return true;
    const channels = inputs[0] || [];
    if (!channels[0]?.length) return true;
    for (let index = 0; index < channels[0].length; index++) {
      let value = 0;
      for (const channel of channels) value += channel[index];
      this.buffer[this.offset++] = value / channels.length;
      if (this.offset === BATCH_SAMPLES) {
        const chunk = this.buffer;
        this.port.postMessage({ type: 'audio', chunk }, [chunk.buffer]);
        this.buffer = new Float32Array(BATCH_SAMPLES); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
