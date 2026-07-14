import { pipeline, env } from '@xenova/transformers';

// Configure Transformers.js to serve models from the local public directory
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = import.meta.env.BASE_URL + 'models/';

// We use the Singleton pattern to ensure the pipeline is only loaded once
class PipelineSingleton {
    static task = 'feature-extraction';
    static model = 'Xenova/all-MiniLM-L6-v2';
    static instance = null;

    static async getInstance(progress_callback = null) {
        if (this.instance === null) {
            this.instance = pipeline(this.task, this.model, { progress_callback });
        }
        return this.instance;
    }
}

// Listen for messages from the main thread
self.addEventListener('message', async (event) => {
    const { id, type, chunks } = event.data;
    
    if (type !== 'EMBED') return;

    try {
        // Retrieve the pipeline. We pass a progress callback to update the main thread.
        const embedder = await PipelineSingleton.getInstance((progress) => {
            self.postMessage({ id, type: 'PROGRESS', progress });
        });

        // We run the model on all chunks.
        // We set pooling: 'mean' and normalize: true to get normalized cosine-similarity ready vectors
        const output = await embedder(chunks, { pooling: 'mean', normalize: true });
        
        // Output is a Tensor. We can convert it to a nested JS array.
        const embeddings = output.tolist();

        // Send the output back to the main thread
        self.postMessage({ id, type: 'COMPLETE', embeddings });
    } catch (error) {
        console.error("Embedding worker error:", error);
        self.postMessage({ id, type: 'ERROR', error: error.message });
    }
});
