// Central event loop for file system actions
self.onmessage = async (event) => {
  const { txId, action, filePath, fileContent } = event.data;

  try {
    // Access the root directory of the browser's native OPFS
    const root = await navigator.storage.getDirectory();

    if (action === 'WRITE_FILE') {
      // Resolve directories recursively and get/create file handle
      const fileHandle = await getFileHandleRecursive(root, filePath, { create: true });
      
      // Open a high-speed synchronous access handle to write raw contents
      const accessHandle = await fileHandle.createSyncAccessHandle();
      
      try {
        let writeBuffer;
        if (fileContent instanceof Uint8Array) {
          writeBuffer = fileContent;
        } else {
          const encoder = new TextEncoder();
          writeBuffer = encoder.encode(fileContent || '');
        }
        
        accessHandle.truncate(0); // Clear old content
        accessHandle.write(writeBuffer, { at: 0 });
        accessHandle.flush(); // Commit data changes to system disk
      } finally {
        accessHandle.close(); // Release file lock
      }

      self.postMessage({ txId, type: 'SUCCESS' });
    }

    if (action === 'READ_FILE') {
      const fileHandle = await getFileHandleRecursive(root, filePath);
      const accessHandle = await fileHandle.createSyncAccessHandle();
      
      let textContent = '';
      try {
        const fileSize = accessHandle.getSize();
        const readBuffer = new Uint8Array(fileSize);
        accessHandle.read(readBuffer, { at: 0 });
        const decoder = new TextDecoder();
        textContent = decoder.decode(readBuffer);
      } finally {
        accessHandle.close();
      }

      self.postMessage({ txId, type: 'SUCCESS', data: textContent });
    }
    if (action === 'READ_FILE_BINARY') {
      const fileHandle = await getFileHandleRecursive(root, filePath);
      const accessHandle = await fileHandle.createSyncAccessHandle();
      
      let readBuffer;
      try {
        const fileSize = accessHandle.getSize();
        readBuffer = new Uint8Array(fileSize);
        accessHandle.read(readBuffer, { at: 0 });
      } finally {
        accessHandle.close();
      }

      self.postMessage({ txId, type: 'SUCCESS', data: readBuffer });
    }
    
    if (action === 'DELETE_ENTRY') {
      const parts = filePath.split('/');
      let currentHandle = root;

      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!part || part === '.') continue;
        currentHandle = await currentHandle.getDirectoryHandle(part, { create: false });
      }

      const entryName = parts[parts.length - 1];

      let isMoved = false;
      try {
        const fileHandle = await currentHandle.getFileHandle(entryName);
        const trashDir = await root.getDirectoryHandle('.trash', { create: true });
        const trashFileName = `${Date.now()}_${entryName}`;
        
        if (fileHandle.move) {
          await fileHandle.move(trashDir, trashFileName);
          isMoved = true;
        } else {
          const destFileHandle = await trashDir.getFileHandle(trashFileName, { create: true });
          const srcAccessHandle = await fileHandle.createSyncAccessHandle();
          const fileSize = srcAccessHandle.getSize();
          const readBuffer = new Uint8Array(fileSize);
          srcAccessHandle.read(readBuffer, { at: 0 });
          srcAccessHandle.close();

          const destAccessHandle = await destFileHandle.createSyncAccessHandle();
          destAccessHandle.truncate(0);
          destAccessHandle.write(readBuffer, { at: 0 });
          destAccessHandle.flush();
          destAccessHandle.close();
        }
      } catch (e) {
        // Fail silently and proceed to hard delete
      }

      if (!isMoved) {
        await currentHandle.removeEntry(entryName, { recursive: true });
      }

      self.postMessage({ txId, type: 'SUCCESS' });
    }
    
    if (action === 'CLEAR_TRASH') {
      try {
        await root.removeEntry('.trash', { recursive: true });
      } catch (e) {}
      self.postMessage({ txId, type: 'SUCCESS' });
    }
    
    if (action === 'MOVE_ENTRY') {
      const { sourcePath, targetPath } = event.data;
      
      // Read source file
      const srcFileHandle = await getFileHandleRecursive(root, sourcePath);
      const srcAccessHandle = await srcFileHandle.createSyncAccessHandle();
      let readBuffer;
      try {
        const fileSize = srcAccessHandle.getSize();
        readBuffer = new Uint8Array(fileSize);
        srcAccessHandle.read(readBuffer, { at: 0 });
      } finally {
        srcAccessHandle.close();
      }
      
      // Write to target file
      const destFileHandle = await getFileHandleRecursive(root, targetPath, { create: true });
      const destAccessHandle = await destFileHandle.createSyncAccessHandle();
      try {
        destAccessHandle.truncate(0);
        destAccessHandle.write(readBuffer, { at: 0 });
        destAccessHandle.flush();
      } finally {
        destAccessHandle.close();
      }
      
      // Delete source entry
      const parts = sourcePath.split('/');
      let currentHandle = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!part || part === '.') continue;
        currentHandle = await currentHandle.getDirectoryHandle(part, { create: false });
      }
      const entryName = parts[parts.length - 1];
      await currentHandle.removeEntry(entryName, { recursive: true });

      self.postMessage({ txId, type: 'SUCCESS' });
    }
    
    if (action === 'GET_TREE') {
      // Utility loop to map out the current directory layout tree for the UI
      const fileTree = await generateVisualTreeArray(root);
      self.postMessage({ txId, type: 'SUCCESS', data: fileTree });
    }

    if (action === 'GET_WORKSPACE_HANDLE') {
      // Resolve/create the dedicated workspace directory handle
      const workspaceHandle = await root.getDirectoryHandle('workspace', { create: true });
      self.postMessage({ txId, type: 'SUCCESS', data: workspaceHandle });
    }

  } catch (err) {
    self.postMessage({ txId, type: 'ERROR', error: err.message });
  }
};

// Helper to traverse and retrieve directory handles inside directory structures recursively
async function getDirectoryHandleRecursive(rootHandle, dirPath, options = {}) {
  const parts = dirPath.split('/');
  let currentHandle = rootHandle;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part === '.' || part === '..') continue;
    currentHandle = await currentHandle.getDirectoryHandle(part, options);
  }
  return currentHandle;
}

// Helper to traverse and retrieve file handles inside directory structures recursively
async function getFileHandleRecursive(rootHandle, filePath, options = {}) {
  const parts = filePath.split('/');
  let currentHandle = rootHandle;

  // Walk intermediate directories
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!part || part === '.') continue;
    currentHandle = await currentHandle.getDirectoryHandle(part, { create: options.create });
  }

  // Get final file handle
  const fileName = parts[parts.length - 1];
  return await currentHandle.getFileHandle(fileName, options);
}

// Recursive helper to map OPFS directory hierarchies into visual tree elements
async function generateVisualTreeArray(dirHandle, currentPath = '') {
  const results = [];
  for await (const entry of dirHandle.values()) {
    if (entry.name === '.trash') continue;
    
    const entryPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
    if (entry.kind === 'file') {
      results.push({ name: entry.name, path: entryPath, type: 'file' });
    } else if (entry.kind === 'directory') {
      results.push({
        name: entry.name,
        path: entryPath,
        type: 'directory',
        children: await generateVisualTreeArray(entry, entryPath)
      });
    }
  }
  return results;
}
