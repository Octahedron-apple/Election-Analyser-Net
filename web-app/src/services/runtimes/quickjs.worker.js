import { getQuickJS } from 'quickjs-emscripten';

let quickJSPromise = null;

function initQuickJS() {
  if (!quickJSPromise) {
    quickJSPromise = getQuickJS();
  }
  return quickJSPromise;
}

self.onmessage = async (event) => {
  const { txId, code } = event.data;

  let vm = null;
  let result = null;

  try {
    const QuickJS = await initQuickJS();
    vm = QuickJS.newContext();

    // Set up console.log binding to redirect logs to host
    const logHandle = vm.newFunction('log', (...args) => {
      const nativeArgs = args.map(arg => {
        try {
          return vm.dump(arg);
        } catch (e) {
          return '[Opaque object]';
        }
      });
      self.postMessage({ txId, type: 'LOG', data: nativeArgs });
    });

    const consoleHandle = vm.newObject();
    vm.setProp(consoleHandle, 'log', logHandle);
    vm.setProp(vm.global, 'console', consoleHandle);

    // Dispose binding handles immediately as we've assigned them to properties
    logHandle.dispose();
    consoleHandle.dispose();

    // Evaluate sandboxed script
    result = vm.evalCode(code);

    if (result.error) {
      const errorObj = vm.dump(result.error);
      const errorStr = (errorObj && errorObj.stack) || (errorObj && errorObj.message) || String(errorObj);
      self.postMessage({ txId, type: 'ERROR', error: errorStr });
    } else {
      const output = vm.dump(result.value);
      self.postMessage({ txId, type: 'RESULT', data: output });
    }

  } catch (err) {
    self.postMessage({ txId, type: 'ERROR', error: err.message });
  } finally {
    // Explicitly dispose resources to prevent memory leaks in WASM linear memory
    if (result) {
      if (result.value) result.value.dispose();
      if (result.error) result.error.dispose();
    }
    if (vm) {
      vm.dispose();
    }
  }
};
