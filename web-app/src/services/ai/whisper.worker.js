import { WhisperWasmService, ModelManager } from '@timur00kh/whisper.wasm';

let modelManager = null;
let whisper = null;

self.addEventListener('message', async (e) => {
  const { type, payload, id } = e.data;

  try {
    if (type === 'LOAD_MODEL') {
      const { modelId = 'tiny' } = payload || {};
      
      if (!modelManager) {
        modelManager = new ModelManager();
      }
      
      self.postMessage({ type: 'STATUS', status: `Loading Whisper model (${modelId})...` });

      const modelData = await modelManager.loadModelByUrl(`${import.meta.env.BASE_URL}vendor/whisper/ggml-tiny.bin`, (progress) => {
        self.postMessage({ type: 'PROGRESS', progress });
      });

      self.postMessage({ type: 'STATUS', status: 'Initializing WASM engine...' });
      
      if (!whisper) {
        whisper = new WhisperWasmService();
        await whisper.init(modelData);
      }
      
      self.postMessage({ type: 'LOAD_COMPLETE', id });
      self.postMessage({ type: 'STATUS', status: 'Speech-to-Text ready.' });
    }
    
    if (type === 'TRANSCRIBE') {
      if (!whisper) throw new Error("Whisper is not initialized. Call LOAD_MODEL first.");
      
      const session = whisper.createSession();
      const audioData = payload.audioData; // Float32Array
      
      let fullText = '';
      
      try {
        for await (const chunk of session.streaming(audioData)) {
          if (chunk.text) {
            fullText += chunk.text;
            self.postMessage({ type: 'TRANSCRIPTION_CHUNK', text: chunk.text, id });
          }
        }
        
        self.postMessage({ type: 'TRANSCRIPTION_COMPLETE', text: fullText.trim(), id });
      } finally {
        if (session && typeof session.free === 'function') {
          session.free();
        } else if (session && typeof session.dispose === 'function') {
          session.dispose();
        }
      }
    }
  } catch (error) {
    console.error('Whisper worker error:', error);
    self.postMessage({ type: 'ERROR', error: error.message, id });
  }
});
