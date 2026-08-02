import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The builder API and the agent runtime are the same Hono server here, but
    // they are separate concerns and can be split without touching the client.
    proxy: {
      '/api': 'http://localhost:8787',
      '/v1': 'http://localhost:8787',
      // The widget and the demo site are served by the API. Proxying them means
      // the origin-relative embed snippet works from the Vite origin too —
      // otherwise the copy-paste snippet 404s in dev.
      '/kuralle-agent.js': 'http://localhost:8787',
      '/embed-demo.html': 'http://localhost:8787',
    },
  },
});
