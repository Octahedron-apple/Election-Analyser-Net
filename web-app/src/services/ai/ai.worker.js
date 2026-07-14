import { CreateMLCEngine } from '@mlc-ai/web-llm';
import { pipeline, env } from '@xenova/transformers';

env.allowLocalModels = false;

let engine = null;
let useFallback = false;
let fallbackGenerator = null;

// Using a lightweight coder model available in WebLLM's prebuilt registry.
const modelId = "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC";

async function getEngine() {
  if (useFallback) {
    return null;
  }
  if (!engine) {
    self.postMessage({ type: 'STATUS', message: 'Initializing WebLLM WebGPU Engine...' });

    const initProgressCallback = (progress) => {
      // progress.progress is a float from 0 to 1
      const pct = Math.round(progress.progress * 100);
      self.postMessage({
        type: 'STATUS',
        message: `Loading WebGPU model: ${pct}% - ${progress.text}`
      });
    };

    try {
      engine = await CreateMLCEngine(
        modelId,
        { initProgressCallback }
      );
      self.postMessage({ type: 'STATUS', message: 'Model ready with WebGPU acceleration!' });
    } catch (e) {
      console.warn("Failed to initialize WebLLM with WebGPU:", e);
      useFallback = true;
      self.postMessage({ type: 'STATUS', message: 'WebGPU not supported or initialization failed. Switching to CPU/WASM fallback...' });
    }
  }
  return engine;
}

async function getFallbackGenerator() {
  if (!fallbackGenerator) {
    self.postMessage({ type: 'STATUS', message: 'Initializing CPU fallback (Transformers.js)...' });

    const progress_callback = (progress) => {
      if (progress.status === 'progress') {
        const pct = Math.round(progress.progress);
        self.postMessage({
          type: 'STATUS',
          message: `Loading fallback model (${progress.file}): ${pct}%`
        });
      }
    };

    try {
      fallbackGenerator = await pipeline('text-generation', 'Xenova/Qwen1.5-0.5B-Chat', {
        progress_callback
      });
      self.postMessage({ type: 'STATUS', message: 'Fallback model ready (CPU/WASM)!' });
    } catch (err) {
      console.error("Failed to initialize Transformers.js fallback:", err);
      self.postMessage({ type: 'ERROR', error: `CPU fallback failed to initialize: ${err.message}` });
      throw err;
    }
  }
  return fallbackGenerator;
}

self.onmessage = async (e) => {
  const { action, prompt, tools, stream = true, requestId } = e.data;

  if (action === 'GENERATE') {
    try {
      const messages = Array.isArray(prompt) ? prompt : [
        { role: 'user', content: prompt }
      ];

      const eng = await getEngine();

      if (eng) {
        const request = {
          messages,
          temperature: 0.3,
          stream: stream,
          max_tokens: 2048,
        };
        
        if (tools && tools.length > 0) {
          // WebLLM currently restricts native function calling to Hermes models.
          // For Qwen2.5, we inject the tool schema into the system prompt and rely on 
          // the frontend's JSON extraction fallback.
          const toolsPrompt = `\nYou have access to the following tools:\n${JSON.stringify(tools, null, 2)}\nIf you need to use a tool, you MUST output ONLY a valid JSON object containing "name" and "args" properties, and absolutely no other text.`;
          
          if (messages[0] && messages[0].role === 'system') {
            messages[0].content += toolsPrompt;
          } else {
            messages.unshift({ role: 'system', content: toolsPrompt });
          }
        }

        const chunks = await eng.chat.completions.create(request);

        let finalOutput = '';
        let toolCalls = [];

        for await (const chunk of chunks) {
          const token = chunk.choices[0]?.delta?.content || '';
          finalOutput += token;
          
          // Accumulate tool calls natively
          if (chunk.choices[0]?.delta?.tool_calls) {
            for (const tcDelta of chunk.choices[0].delta.tool_calls) {
              const index = tcDelta.index;
              if (!toolCalls[index]) {
                toolCalls[index] = {
                  id: tcDelta.id || '',
                  type: 'function',
                  function: { name: tcDelta.function?.name || '', arguments: tcDelta.function?.arguments || '' }
                };
              } else {
                if (tcDelta.function?.name) toolCalls[index].function.name += tcDelta.function.name;
                if (tcDelta.function?.arguments) toolCalls[index].function.arguments += tcDelta.function.arguments;
              }
            }
          }

          // Stream token to main thread if streaming is enabled
          if (token && stream) {
            self.postMessage({ type: 'TOKEN', token, requestId });
          }
        }

        // Clean up tool calls array
        const finalToolCalls = toolCalls.filter(tc => tc && tc.function && tc.function.name);

        // Signal completion
        self.postMessage({ 
          type: 'COMPLETE', 
          output: finalOutput,
          tool_calls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
          requestId
        });

      } else {
        // CPU fallback generation via Transformers.js
        const gen = await getFallbackGenerator();

        const formattedPrompt = gen.tokenizer.apply_chat_template(messages, {
          tokenize: false,
          add_generation_prompt: true,
        });

        let finalOutput = '';
        let lastLength = 0;

        const output = await gen(formattedPrompt, {
          max_new_tokens: 512,
          temperature: 0.3,
          do_sample: true,
          callback_function: (beams) => {
            const token_ids = beams[0].output_token_ids;
            const fullText = gen.tokenizer.decode(token_ids, { skip_special_tokens: true });
            const token = fullText.slice(lastLength);
            lastLength = fullText.length;
            if (token) {
              if (stream) {
                self.postMessage({ type: 'TOKEN', token, requestId });
              }
              finalOutput += token;
            }
          }
        });

        const outputText = Array.isArray(output) ? output[0].generated_text : output.generated_text;
        const finalGeneratedText = outputText.substring(formattedPrompt.length);

        self.postMessage({ 
          type: 'COMPLETE', 
          output: finalGeneratedText,
          requestId
        });
      }

    } catch (err) {
      console.error('Error during generation:', err);
      self.postMessage({ type: 'ERROR', error: err.message, requestId });
    }
  }
};
