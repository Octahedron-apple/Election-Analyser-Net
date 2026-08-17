const pendingTasks = new Map();
let worker = null;

function getWorker() {
  if (!worker) {
    worker = new Worker(
      new URL('./pyodide.worker.js', import.meta.url)
    );

    worker.onmessage = (event) => {
      const { txId, type, data, error } = event.data;

      if (type === 'STDOUT') {
        if (logSubscriber) logSubscriber({ type: 'stdout', text: data });
        console.log('[Python STDOUT]:', data);
        return;
      }
      if (type === 'STDERR') {
        if (logSubscriber) logSubscriber({ type: 'stderr', text: data });
        console.error('[Python STDERR]:', data);
        return;
      }

      const task = pendingTasks.get(txId);
      if (!task) return;

      pendingTasks.delete(txId);

      if (type === 'RESULT') {
        task.resolve(data);
      } else if (type === 'ERROR') {
        task.reject(new Error(error));
      }
    };

    worker.onerror = (err) => {
      console.error('Pyodide Worker Exception:', err);
    };
  }
  return worker;
}

export async function runPython(code, inputStringData = '') {
  const txId = Math.random().toString(36).slice(2);
  const w = getWorker();
  
  let baseUrl = '';
  if (typeof window !== 'undefined' && window.location) {
    try {
      baseUrl = new URL('.', window.location.href).href;
      console.log('[pyodide.js] Calculated baseUrl:', baseUrl, 'from window.location.href:', window.location.href);
    } catch (e) {
      console.error('[pyodide.js] Error calculating baseUrl:', e);
    }
  }

  return new Promise((resolve, reject) => {
    pendingTasks.set(txId, { resolve, reject });
    w.postMessage({ txId, pythonCodeString: code, inputStringData, baseUrl });
  });
}

export const executePython = runPython;

let logSubscriber = null;
export function subscribePythonLogs(callback) {
  logSubscriber = callback;
}
