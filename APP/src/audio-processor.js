class AudioChunkProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.bufferQueue = [];
    }
  
    process(inputs, outputs) {
      const output = outputs[0];
      const outputData = output[0];
  
      // Si hay datos en el buffer, reproducirlos
      if (this.bufferQueue.length > 0) {
        const chunk = this.bufferQueue.shift();
        outputData.set(chunk);
      } else {
        outputData.fill(0); // Silencio si no hay datos
      }
  
      return true; // Mantener el procesador activo
    }
  
    enqueue(buffer) {
      this.bufferQueue.push(buffer);
    }
  }
  
  registerProcessor('audio-chunk-processor', AudioChunkProcessor);
  