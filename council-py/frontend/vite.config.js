import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The backend defaults to :8001 so it can coexist with the MERN app in this repo.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:8001',
        changeOrigin: true,
      },
    },
  },
});
