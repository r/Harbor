import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
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
        'demo-bootstrap': resolve(__dirname, 'src/demo-bootstrap.ts'),
        // JS AI Provider files
        'content-bridge': resolve(__dirname, 'src/provider/content-bridge.ts'),
        'provider-injected': resolve(__dirname, 'src/provider/injected.ts'),
        'permission-prompt': resolve(__dirname, 'src/permission-prompt.ts'),
        // VS Code MCP button detector
        'vscode-detector': resolve(__dirname, 'src/vscode-detector.ts'),
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
        // Copy design-tokens.css
        const designTokens = readFileSync(
          resolve(__dirname, 'src/design-tokens.css'),
          'utf-8'
        );
        writeFileSync(resolve(__dirname, 'dist/design-tokens.css'), designTokens);

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

        // Copy permission-prompt.html
        const permissionPromptHtml = readFileSync(
          resolve(__dirname, 'src/permission-prompt.html'),
          'utf-8'
        );
        writeFileSync(resolve(__dirname, 'dist/permission-prompt.html'), permissionPromptHtml);

        // Copy manifest.json
        const manifest = readFileSync(
          resolve(__dirname, 'manifest.json'),
          'utf-8'
        );
        writeFileSync(resolve(__dirname, 'dist/manifest.json'), manifest);

        // Copy icons
        const iconsDir = resolve(__dirname, 'dist/icons');
        if (!existsSync(iconsDir)) {
          mkdirSync(iconsDir, { recursive: true });
        }
        const harborIcon = readFileSync(
          resolve(__dirname, 'src/icons/harbor-icon.svg'),
          'utf-8'
        );
        writeFileSync(resolve(__dirname, 'dist/icons/harbor-icon.svg'), harborIcon);

        // Copy demo/chat-poc files (API demo/example code)
        const demoPocDir = resolve(__dirname, 'dist/demo');
        if (!existsSync(demoPocDir)) {
          mkdirSync(demoPocDir, { recursive: true });
        }
        
        // Read the demo HTML and inject bootstrap script for extension context
        let chatPocHtml = readFileSync(
          resolve(__dirname, '../demo/chat-poc/index.html'),
          'utf-8'
        );
        // Add bootstrap script before app.js to set up window.ai/window.agent
        chatPocHtml = chatPocHtml.replace(
          '<script type="module" src="app.js"></script>',
          '<script type="module" src="../demo-bootstrap.js"></script>\n  <script type="module" src="app.js"></script>'
        );
        writeFileSync(resolve(__dirname, 'dist/demo/index.html'), chatPocHtml);
        
        const chatPocJs = readFileSync(
          resolve(__dirname, '../demo/chat-poc/app.js'),
          'utf-8'
        );
        writeFileSync(resolve(__dirname, 'dist/demo/app.js'), chatPocJs);
      },
    },
  ],
});
