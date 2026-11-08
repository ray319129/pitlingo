/**
 * 語音辨識測試：把分頁聲音降到 16 kHz 單聲道 16-bit，每 0.1 秒送一批回主執行緒。
 * ⚠️ 只存在於測試版。
 *
 * 為什麼在 worklet 裡降頻：播放用的 AudioContext 要維持原本的取樣率（否則使用者聽到的聲音會變差），
 * 送去辨識的只需要 16 kHz——一小時的上傳量從 ~600MB（48k 立體聲 float）降到 ~115MB。
 */
class PitLingoAsrCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.acc = 0; this.sum = 0; this.n = 0;
    this.out = new Int16Array(1600);
    this.len = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const a = input && input[0];
    if (!a) return true;
    const b = input[1];
    for (let i = 0; i < a.length; i++) {
      this.sum += b ? (a[i] + b[i]) / 2 : a[i];
      this.n++;
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        const v = this.sum / this.n;
        this.sum = 0; this.n = 0;
        this.out[this.len++] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
        if (this.len === this.out.length) {
          this.port.postMessage(this.out.slice(0));
          this.len = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pl-asr-capture', PitLingoAsrCapture);
