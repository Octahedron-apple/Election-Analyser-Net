/**
 * RAG (Retrieval-Augmented Generation) Service
 *
 * Handles the full pipeline:
 * 1. Text extraction from DOCX (mammoth) and PDF (pdfjs-dist)
 * 2. Smart chunking at sentence/word boundaries near ~500 chars
 * 3. MiniSearch keyword indexing
 * 4. Query-time retrieval of top relevant chunks
 */

import mammoth from 'mammoth';

// ─── Text Extraction ──────────────────────────────────────────────────────────

/**
 * Extracts plain text from a DOCX file binary.
 * @param {Uint8Array} bytes - Raw file bytes
 * @returns {Promise<string>} Extracted plain text
 */
export async function extractDocxText(bytes) {
  const buffer = bytes.buffer ?? bytes;
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return result.value;
}

/**
 * Extracts plain text from a PDF file binary using pdfjs-dist.
 * @param {Uint8Array} bytes - Raw file bytes
 * @returns {Promise<string>} Extracted plain text
 */
export async function extractPdfText(bytes) {
  // Dynamically import to respect the vite optimizeDeps.exclude rule.
  const pdfjsLib = await import('pdfjs-dist');

  // Point to the local vendor worker to ensure 100% offline support.
  pdfjsLib.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}vendor/pdfjs/pdf.worker.min.mjs`;

  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  const pdf = await loadingTask.promise;

  let fullText = '';
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join(' ');
    fullText += pageText + '\n';
  }
  return fullText;
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 1000;
const OVERLAP = 150; // chars of overlap to preserve context at boundaries

/**
 * Splits text into ~500-char chunks, snapping to sentence/word boundaries.
 * @param {string} text - Full extracted text
 * @param {string} sourceFile - Filename for metadata
 * @returns {Array<{id: number, text: string, source: string}>}
 */
export function chunkText(text, sourceFile) {
  const chunks = [];
  let start = 0;
  let id = 0;

  while (start < text.length) {
    let end = start + CHUNK_SIZE;

    if (end >= text.length) {
      const chunk = text.slice(start).trim();
      if (chunk.length > 10) {
        chunks.push({ id: id++, text: chunk, source: sourceFile });
      }
      break;
    }

    // Walk back from end to find a good sentence/word boundary
    const sentenceEnd = Math.max(
      text.lastIndexOf('.', end),
      text.lastIndexOf('\n', end),
      text.lastIndexOf('!', end),
      text.lastIndexOf('?', end)
    );

    let boundary = end;
    if (sentenceEnd > start + 100) {
      boundary = sentenceEnd + 1;
    } else {
      const spaceIdx = text.lastIndexOf(' ', end);
      if (spaceIdx > start) {
        boundary = spaceIdx + 1;
      }
    }

    const chunk = text.slice(start, boundary).trim();
    if (chunk.length > 10) {
      chunks.push({ id: id++, text: chunk, source: sourceFile });
    }

    // Advance with overlap so boundary context is not lost
    start = boundary - OVERLAP;
  }

  return chunks;
}

// ─── Semantic Search & Worker Orchestration ────────────────────────────────────

let embeddingWorker = null;
let currentResolve = null;
let currentReject = null;
let currentOnProgress = null;

function getEmbeddingWorker() {
  if (!embeddingWorker) {
    embeddingWorker = new Worker(new URL('./embeddings.worker.js', import.meta.url), { type: 'module' });
    embeddingWorker.addEventListener('message', (event) => {
      const { type, embeddings, progress, error } = event.data;
      if (type === 'COMPLETE' && currentResolve) {
        currentResolve(embeddings);
        currentResolve = null;
        currentReject = null;
        currentOnProgress = null;
      } else if (type === 'PROGRESS' && currentOnProgress) {
        currentOnProgress(progress);
      } else if (type === 'ERROR' && currentReject) {
        currentReject(new Error(error));
        currentResolve = null;
        currentReject = null;
        currentOnProgress = null;
      }
    });
  }
  return embeddingWorker;
}

export function generateEmbeddings(texts, onProgress) {
  return new Promise((resolve, reject) => {
    if (currentResolve) {
      reject(new Error("Worker is busy processing another embedding request."));
      return;
    }
    currentResolve = resolve;
    currentReject = reject;
    currentOnProgress = onProgress;
    const worker = getEmbeddingWorker();
    worker.postMessage({ type: 'EMBED', id: Date.now(), chunks: texts });
  });
}

export function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
  }
  // No need to divide by norms because the worker returns normalized vectors
  return dotProduct;
}

/**
 * Searches the semantic chunks for the most relevant results.
 * @param {Array} allChunks - Array of all document chunks with vectors
 * @param {string} query - The search query
 * @param {number} topK - Number of results to return
 * @returns {Promise<Array<{text: string, source: string}>>}
 */
export async function retrieveChunks(allChunks, query, topK = 5) {
  if (allChunks.length === 0) return [];
  
  // Embed the query
  const [queryVector] = await generateEmbeddings([query]);
  
  // Calculate similarity scores for all chunks
  const scoredChunks = allChunks.map(chunk => ({
    ...chunk,
    score: cosineSimilarity(queryVector, chunk.vector)
  }));
  
  // Sort descending by score
  scoredChunks.sort((a, b) => b.score - a.score);
  
  // Return top K
  return scoredChunks.slice(0, topK).map(r => ({ text: r.text, source: r.source }));
}

// ─── Full Pipeline ────────────────────────────────────────────────────────────

/**
 * Extracts text from a file binary, chunks it, and returns a MiniSearch index.
 * Supports DOCX and PDF. Returns null for unsupported types.
 *
 * @param {Uint8Array} bytes - Raw file bytes
 * @param {string} filename - Used to determine file type and as metadata
 * @param {Function} onProgress - Callback for model download progress
 * @returns {Promise<{chunks: Array, chunkCount: number} | null>}
 */
export async function indexDocument(bytes, filename, onProgress) {
  const ext = filename.toLowerCase().split('.').pop();

  let rawText = '';
  if (ext === 'docx') {
    rawText = await extractDocxText(bytes);
  } else if (ext === 'pdf') {
    rawText = await extractPdfText(bytes);
  } else {
    return null;
  }

  if (!rawText || rawText.trim().length === 0) {
    return null;
  }

  const chunks = chunkText(rawText, filename);
  
  const textArray = chunks.map(c => c.text);
  const vectors = await generateEmbeddings(textArray, onProgress);
  
  const chunkData = chunks.map((chunk, i) => ({
    ...chunk,
    vector: vectors[i]
  }));
  
  return { chunks: chunkData, chunkCount: chunks.length };
}
