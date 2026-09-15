// Preserve a fractional source position across chunks so non-48k devices and
// the final short worklet batch do not accumulate timing drift.
export class PCMResampler {
  constructor(inputRate, outputRate = 16000) {
    this.ratio = inputRate / outputRate;
    this.pending = new Float32Array(0);
    this.totalInput = 0; this.emitted = 0; this.consumed = 0;
  }
  push(chunk, final = false) {
    const joined = new Float32Array(this.pending.length + chunk.length);
    joined.set(this.pending); joined.set(chunk, this.pending.length);
    this.totalInput += chunk.length;
    const output = [];
    const target = final ? Math.round(this.totalInput / this.ratio) : Math.ceil(Math.max(0, this.totalInput - 1) / this.ratio);
    while (this.emitted < target) {
      const position = this.emitted * this.ratio - this.consumed;
      const left = Math.floor(position), mix = position - left;
      const value = joined[left] * (1 - mix) + (joined[left + 1] ?? joined[left]) * mix;
      output.push(Math.max(-1, Math.min(1, value)));
      this.emitted++;
    }
    const consumed = Math.min(joined.length, Math.floor(this.emitted * this.ratio - this.consumed));
    this.pending = joined.slice(consumed); this.consumed += consumed;
    const pcm = new ArrayBuffer(output.length * 2);
    const view = new DataView(pcm);
    output.forEach((value, index) => view.setInt16(index * 2, value < 0 ? value * 32768 : value * 32767, true));
    return pcm;
  }
}
