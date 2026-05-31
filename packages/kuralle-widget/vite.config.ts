import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  build: {
    lib: {
      entry: './src/embed.ts',
      name: 'KuralleWidget',
      fileName: 'widget',
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      output: {
        globals: {
          // Add any global dependencies here
        },
      },
    },
    // Optimize for small bundle size
    target: 'es2020',
    minify: 'esbuild',
  },
  // Ensure dependencies are bundled
  optimizeDeps: {
    include: ['convex-dev'],
  },
});
