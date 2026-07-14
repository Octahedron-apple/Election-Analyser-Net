let aiWorker = null;
const activeRequests = {};
let reqCounter = 0;

function getWorker() {
  if (!aiWorker) {
    aiWorker = new Worker(
      new URL('./ai.worker.js', import.meta.url),
      { type: 'module' }
    );

    aiWorker.onmessage = (event) => {
      const { type, token, output, error, message, requestId } = event.data;
      
      if (type === 'STATUS') {
        if (statusSubscriber) statusSubscriber(message);
        console.log(`[AI Worker Status]: ${message}`);
        return;
      }
      
      const req = activeRequests[requestId];
      if (!req) return; // ignore orphan messages

      if (type === 'TOKEN') {
        req.accumulatedOutput += token;
        if (req.onToken) req.onToken(token);
      } else if (type === 'COMPLETE') {
        const { output, tool_calls } = event.data;
        if (req.onComplete) {
          req.onComplete(req.accumulatedOutput || output, tool_calls);
        }
        delete activeRequests[requestId];
      } else if (type === 'ERROR') {
        console.error('Error from AI Worker:', error);
        if (req.onComplete) {
          req.onComplete(`Error: ${error}`);
        }
        delete activeRequests[requestId];
      }
    };
  }
  return aiWorker;
}

export function generateCode(prompt, onToken, onComplete, tools) {
  const worker = getWorker();
  const requestId = `req_${++reqCounter}`;
  activeRequests[requestId] = {
    onToken,
    onComplete,
    accumulatedOutput: ''
  };
  worker.postMessage({ action: 'GENERATE', prompt, tools, stream: true, requestId });
}

export function generateBulk(prompt) {
  return new Promise((resolve, reject) => {
    const worker = getWorker();
    const requestId = `req_${++reqCounter}`;
    activeRequests[requestId] = {
      onToken: null,
      onComplete: (output) => {
        if (typeof output === 'string' && output.startsWith('Error:')) {
          reject(new Error(output));
        } else {
          resolve(output);
        }
      },
      accumulatedOutput: ''
    };
    worker.postMessage({ action: 'GENERATE', prompt, stream: false, requestId });
  });
}

let statusSubscriber = null;
export function subscribeAIStatus(callback) {
  statusSubscriber = callback;
}
