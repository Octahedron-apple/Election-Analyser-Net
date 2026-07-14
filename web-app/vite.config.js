import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        bihar: resolve(__dirname, 'bihar.html'),
        maharashtra: resolve(__dirname, 'maharashtra.html')
      }
    }
  }
});
