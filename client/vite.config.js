import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/* Dev: Vite serves the UI on 5173 and proxies /api to the Express server on 8787,
   so the browser only ever talks to one origin and CORS never enters the picture.
   Prod: `npm run build` emits ../server/public, which Express serves directly. */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_ORIGIN || 'http://localhost:8787',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: { react: ['react', 'react-dom'] }
      }
    }
  }
});
