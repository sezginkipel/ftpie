import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Tauri conventions are preserved: fixed port 5173 with `strictPort` (the Rust
 * side points at it), `src-tauri` excluded from the watcher, and the build
 * target driven by `TAURI_ENV_*`.
 */
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
    // Monaco is large and split across several chunks plus five workers; the
    // default 500 kB warning is pure noise here.
    chunkSizeWarningLimit: 2000,
  },
  optimizeDeps: {
    // Pre-bundling the worker entry points confuses the `?worker` transform.
    exclude: ['monaco-editor'],
  },
  worker: {
    format: 'es',
  },
});
