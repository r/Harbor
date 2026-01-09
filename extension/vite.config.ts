import { defineConfig, build } from 'vite';
import { resolve } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Determine target browser from env: 'firefox' (default), 'chrome', or 'all'
const targetBrowser = process.env.TARGET_BROWSER || 'firefox';

// Content scripts that must be bundled as IIFE (not ES modules)
// These are injected into web page contexts and cannot load separate modules
const contentScriptEntries = {
  'content-bridge': resolve(__dirname, 'src/provider/content-bridge.ts'),
  'vscode-detector': resolve(__dirname, 'src/vscode-detector.ts'),
  // provider-injected must be standalone since it's injected into web pages
  'provider-injected': resolve(__dirname, 'src/provider/injected.ts'),
};

// ES module entries (background, sidebar, etc.)
const esModuleEntries = {
  background: resolve(__dirname, 'src/background.ts'),
  sidebar: resolve(__dirname, 'src/sidebar.ts'),
  directory: resolve(__dirname, 'src/directory.ts'),
  'demo-bootstrap': resolve(__dirname, 'src/demo-bootstrap.ts'),
  'permission-prompt': resolve(__dirname, 'src/permission-prompt.ts'),
};

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: esModuleEntries,
      output: {
        entryFileNames: '[name].js',
        format: 'es',
      },
    },
  },
  publicDir: false,
  plugins: [
    {
      name: 'build-content-scripts',
      async closeBundle() {
        // Build content scripts as IIFE (required for Chrome content scripts)
        for (const [fileName, entry] of Object.entries(contentScriptEntries)) {
          // Convert filename to valid JS identifier for IIFE global name
          const globalName = fileName.replace(/-/g, '_');
          await build({
            configFile: false,
            build: {
              outDir: 'dist',
              emptyOutDir: false,
              sourcemap: true,
              lib: {
                entry,
                name: globalName,
                formats: ['iife'],
                fileName: () => `${fileName}.js`,
              },
              rollupOptions: {
                output: {
                  // Ensure single file output
                  inlineDynamicImports: true,
                },
              },
            },
          });
        }
      },
    },
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

        // Copy welcome.html (first-run welcome page)
        const welcomeHtml = readFileSync(
          resolve(__dirname, 'src/welcome.html'),
          'utf-8'
        );
        writeFileSync(resolve(__dirname, 'dist/welcome.html'), welcomeHtml);

        // Copy welcome.js (external script for welcome page)
        const welcomeJs = readFileSync(
          resolve(__dirname, 'src/welcome.js'),
          'utf-8'
        );
        writeFileSync(resolve(__dirname, 'dist/welcome.js'), welcomeJs);

        // Copy manifest.json based on target browser
        const manifestFile = targetBrowser === 'chrome' 
          ? 'manifest.chrome.json' 
          : 'manifest.json';
        const manifest = readFileSync(
          resolve(__dirname, manifestFile),
          'utf-8'
        );
        writeFileSync(resolve(__dirname, 'dist/manifest.json'), manifest);
        console.log(`[vite] Built for ${targetBrowser} browser (using ${manifestFile})`);

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

        // Copy demo/shared styles
        const sharedDir = resolve(__dirname, 'dist/shared');
        if (!existsSync(sharedDir)) {
          mkdirSync(sharedDir, { recursive: true });
        }
        const sharedStyles = readFileSync(
          resolve(__dirname, '../demo/shared/styles.css'),
          'utf-8'
        );
        writeFileSync(resolve(__dirname, 'dist/shared/styles.css'), sharedStyles);

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
        // Update title for extension context
        chatPocHtml = chatPocHtml.replace(
          '<title>Harbor Chat — API Demo</title>',
          '<title>Harbor Chat</title>'
        );
        // Update header badge for extension context
        chatPocHtml = chatPocHtml.replace(
          '<span class="header-badge">API Demo</span>',
          '<span class="header-badge" style="background: var(--harbor-success);">Extension</span>'
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
