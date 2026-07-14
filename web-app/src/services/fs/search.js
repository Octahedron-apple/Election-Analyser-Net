import MiniSearch from 'minisearch';
import { fileSystemAPI } from './fileSystem.js';

let globalIndex = new MiniSearch({
  fields: ['text', 'path', 'name'],
  storeFields: ['path', 'name', 'text'],
  idField: 'path',
  searchOptions: {
    boost: { name: 3, path: 2, text: 1 },
    fuzzy: 0.2,
    prefix: true,
  }
});

/**
 * Rebuilds the search index by walking all text files in OPFS.
 */
export async function buildGlobalIndex() {
  globalIndex.removeAll();
  try {
    const tree = await fileSystemAPI.getDirectoryTree();
    let workspaceNode = tree.find(n => n.name === 'workspace');
    if (workspaceNode && workspaceNode.children) {
      await indexTree(workspaceNode.children);
    }
  } catch (err) {
    console.error("Failed to build global search index", err);
  }
}

async function indexTree(nodes) {
  for (const node of nodes) {
    if (node.type === 'directory') {
      if (node.children) {
        await indexTree(node.children);
      }
    } else {
      await updateFileInIndex(node.path);
    }
  }
}

/**
 * Updates or adds a single file to the search index.
 */
export async function updateFileInIndex(filePath) {
  // Only index text-based files
  const ext = filePath.split('.').pop().toLowerCase();
  const binaryExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'whl', 'wasm', 'mp4', 'zip', 'gz', 'tar'];
  if (binaryExts.includes(ext)) {
    return;
  }

  try {
    const content = await fileSystemAPI.readFile(filePath);
    const doc = {
      path: filePath,
      name: filePath.split('/').pop(),
      text: content
    };
    if (globalIndex.has(filePath)) {
      globalIndex.replace(doc);
    } else {
      globalIndex.add(doc);
    }
  } catch (err) {
    // File might not exist or be readable
    console.warn(`Could not index file ${filePath}`, err);
  }
}

/**
 * Removes a file from the index.
 */
export function removeFileFromIndex(filePath) {
  if (globalIndex.has(filePath)) {
    globalIndex.discard(filePath);
  }
}

/**
 * Executes a search against the global index.
 */
export function searchFiles(query) {
  if (!query || query.trim() === '') return [];
  return globalIndex.search(query);
}
