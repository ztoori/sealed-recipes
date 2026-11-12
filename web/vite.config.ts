import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500, rollupOptions: { input: { main: root + 'index.html', live: root + 'live.html' } } },
  server: { port: 5173, proxy: { '/api': process.env.SRS_API ?? 'http://127.0.0.1:8080', '/mock': 'http://127.0.0.1:8080', '/runner': process.env.SRS_API ?? 'http://127.0.0.1:8080' }, fs: { allow: ['..'] } },
});
