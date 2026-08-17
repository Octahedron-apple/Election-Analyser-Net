// Use importScripts to load Pyodide classically (bypassing ES module dynamic import restrictions in workers)
importScripts('https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js');

let pyodidePromise = null;
let currentTxId = null;
let appBaseUrl = '';

function getPyodide() {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      const pyodide = await loadPyodide({
        indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.25.0/full/',
        stdout: (text) => {
          self.postMessage({ txId: currentTxId, type: 'STDOUT', data: text });
        },
        stderr: (text) => {
          self.postMessage({ txId: currentTxId, type: 'STDERR', data: text });
        }
      });
      return pyodide;
    })();
  }
  return pyodidePromise;
}

self.onmessage = async (event) => {
  const { txId, pythonCodeString, inputStringData, baseUrl } = event.data;
  
  if (!txId) return;
  if (baseUrl) {
    appBaseUrl = baseUrl;
    console.log('[pyodide.worker.js] Received baseUrl from main thread:', appBaseUrl);
  }

  try {
    const pyodide = await getPyodide();
    currentTxId = txId;

    // Inject INPUT_DATA and BASE_URL into global namespace
    pyodide.globals.set('INPUT_DATA', inputStringData || '');
    pyodide.globals.set('BASE_URL', appBaseUrl || '');
    
    if (appBaseUrl) {
      console.log('[pyodide.worker.js] Injected BASE_URL into Pyodide globals:', appBaseUrl);
    }

    // Load necessary packages based on imports in the python string
    await pyodide.loadPackagesFromImports(pythonCodeString);

    // Run the Python script string asynchronously in the global scope
    const result = await pyodide.runPythonAsync(pythonCodeString);

    // Safe conversion of Python proxy results back to native JavaScript structures
    let output = result;
    if (result && typeof result.toJs === 'function') {
      output = result.toJs();
    }
    
    if (result && typeof result.destroy === 'function') {
      result.destroy();
    }

    self.postMessage({ txId, type: 'RESULT', data: output });
  } catch (err) {
    self.postMessage({ txId, type: 'ERROR', error: err.message });
  } finally {
    currentTxId = null;
  }
};
