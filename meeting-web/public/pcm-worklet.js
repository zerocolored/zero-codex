class PCM16 extends AudioWorkletProcessor {
  constructor(){super();this.buffer=new Int16Array(320);this.index=0}
  process(inputs){const channel=inputs[0]?.[0];if(channel)for(const sample of channel){this.buffer[this.index++]=Math.round(Math.max(-1,Math.min(1,sample))*(sample<0?32768:32767));if(this.index===320){this.port.postMessage(this.buffer.buffer,[this.buffer.buffer]);this.buffer=new Int16Array(320);this.index=0}}return true}
}
registerProcessor('pcm16',PCM16)
