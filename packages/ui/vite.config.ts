import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER_TARGET = process.env.PARLIAMENT_SERVER ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: SERVER_TARGET,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
