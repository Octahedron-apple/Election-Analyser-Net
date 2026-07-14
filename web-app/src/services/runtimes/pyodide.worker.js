// Use importScripts to load Pyodide classically (bypassing ES module dynamic import restrictions in workers)
importScripts('https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js');

let pyodidePromise = null;
let currentTxId = null;

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
  const { txId, pythonCodeString, inputStringData } = event.data;
  
  if (!txId) return;

  try {
    const pyodide = await getPyodide();
    currentTxId = txId;

    // Inject INPUT_DATA into global namespace
    pyodide.globals.set('INPUT_DATA', inputStringData || '');

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
