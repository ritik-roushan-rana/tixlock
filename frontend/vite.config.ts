import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    // The API base URL is supplied by VITE_API_URL, so no dev proxy is required.
    // A proxy is still configured for /api as a convenience: it means a developer
    // who leaves VITE_API_URL unset gets same-origin relative requests that work
    // out of the box against a backend on :3000.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
