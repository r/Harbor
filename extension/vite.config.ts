import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background.ts'),
        sidebar: resolve(__dirname, 'src/sidebar.ts'),
        directory: resolve(__dirname, 'src/directory.ts'),
        chat: resolve(__dirname, 'src/chat.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        format: 'es',
      },
    },
  },
  publicDir: false,
  plugins: [
    {
      name: 'copy-html-and-manifest',
      writeBundle() {
        // Copy sidebar.html
        const sidebarHtml = readFileSync(
          resolve(__dirname, 'src/sidebar.html'),
          'utf-8'
        );
        writeFileSync(resolve(__dirname, 'dist/sidebar.html'), sidebarHtml);

        // Copy directory.html
        const directoryHtml = readFileSync(
          resolve(__dirname, 'src/directory.html'),
          'utf-8'
        );
        writeFileSync(resolve(__dirname, 'dist/directory.html'), directoryHtml);

        // Copy chat.html
        const chatHtml = readFileSync(
          resolve(__dirname, 'src/chat.html'),
          'utf-8'
        );
        writeFileSync(resolve(__dirname, 'dist/chat.html'), chatHtml);

        // Copy manifest.json
        const manifest = readFileSync(
          resolve(__dirname, 'manifest.json'),
          'utf-8'
        );
        writeFileSync(resolve(__dirname, 'dist/manifest.json'), manifest);
      },
    },
  ],
});
