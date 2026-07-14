import { loadPyodide } from 'pyodide';

let pyodidePromise = null;
let currentTxId = null;

function getPyodide() {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      const pyodide = await loadPyodide({
        // Load from local public/pyodide folder to prevent cross-origin dynamic import errors
        indexURL: './pyodide/',
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
  const { txId, pythonCodeString, inputStringData } = event.data;
  
  if (!txId) return;

  try {
    const pyodide = await getPyodide();
    currentTxId = txId;

    // Create a sandboxed dictionary for execution to prevent memory leaks
    const namespace = pyodide.globals.get('dict')();
    namespace.set('INPUT_DATA', inputStringData || '');

    // Load necessary packages based on imports in the python string
    await pyodide.loadPackagesFromImports(pythonCodeString);

    // Run the Python script string asynchronously inside the sandbox
    const result = await pyodide.runPythonAsync(pythonCodeString, { globals: namespace });

    // Safe conversion of Python proxy results back to native JavaScript structures
    let output = result;
    if (result && typeof result.toJs === 'function') {
      output = result.toJs();
    }
    
    // Explicitly release the Python memory space
    namespace.destroy();
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
