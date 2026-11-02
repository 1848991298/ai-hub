import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  build: {rollupOptions: {input: {hub: fileURLToPath(new URL('./index.html',import.meta.url)), market: fileURLToPath(new URL('./market.html',import.meta.url))}}},
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4317', changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, request) => {
            if (request.headers.origin === `http://${request.headers.host}`) outgoing.setHeader('Origin', 'http://127.0.0.1:4317');
          });
        },
      },
    },
  },
});
