const pendingTasks = new Map();
let worker = null;

function getWorker() {
  if (!worker) {
    worker = new Worker(
      new URL('./quickjs.worker.js', import.meta.url),
      { type: 'module' }
    );

    worker.onmessage = (event) => {
      const { txId, type, data, error } = event.data;
      
      if (type === 'LOG') {
        // Log sandboxed stdout stream to browser console
        console.log('[QuickJS Sandbox]:', ...data);
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
      console.error('QuickJS Worker Exception:', err);
    };
  }
  return worker;
}

export async function runJS(codeString) {
  const txId = Math.random().toString(36).slice(2);
  const workerInstance = getWorker();

  return new Promise((resolve, reject) => {
    pendingTasks.set(txId, { resolve, reject });
    workerInstance.postMessage({ txId, code: codeString });
  });
}
