import { build, context } from 'esbuild';
import { copyFile, mkdir, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const isWatch = process.argv.includes('--watch');
const isChrome = process.argv.includes('--chrome');
const isSafari = process.argv.includes('--safari');

// Determine target browser
const targetBrowser = isChrome ? 'chrome' : isSafari ? 'safari' : 'firefox';

// Chrome and Safari use service workers which require ESM format
const useESM = isChrome || isSafari;

// Output directory - always use 'dist' for the JS output
// The manifest selection determines which browser the build is for
const outDir = 'dist';

const common = {
  bundle: true,
  sourcemap: true,
  format: useESM ? 'esm' : 'iife',
  target: ['es2022'],
  outdir: outDir,
  outbase: 'src',
  logLevel: 'info',
};

const entryPoints = [
  'src/background.ts',
  'src/discovery.ts',
  'src/page-chat.ts',
  'src/directory.ts',
  'src/sidebar.ts',
  'src/demo-bootstrap.ts',
  'src/js-runtime/worker-loader.ts',
  'src/agents/content-script.ts',
  'src/agents/injected.ts',
];

async function copyStatic() {
  await mkdir(outDir, { recursive: true });
  await mkdir(`${outDir}/js-runtime`, { recursive: true });
  await mkdir(`${outDir}/agents`, { recursive: true });
  await copyFile('src/directory.html', `${outDir}/directory.html`);
  await copyFile('src/sidebar.html', `${outDir}/sidebar.html`);
  await copyFile('src/permission-prompt.html', `${outDir}/permission-prompt.html`);
  await copyFile('src/design-tokens.css', `${outDir}/design-tokens.css`);
  await copyFile('src/js-runtime/sandbox.html', `${outDir}/js-runtime/sandbox.html`).catch(() => {});
  await copyFile('src/js-runtime/builtin-echo-worker.js', `${outDir}/js-runtime/builtin-echo-worker.js`);
  
  // Copy demo files (shared across all builds)
  await cp('demo', 'demo', { recursive: true }).catch(() => {});
  
  // Copy bundled MCP servers from project root demo folder
  await mkdir('bundled/gmail-harbor', { recursive: true });
  await cp('../demo/gmail-mcp-server/harbor', 'bundled/gmail-harbor', { recursive: true }).catch(() => {});
  
  // Log which manifest to use
  // NOTE: The build outputs to dist/, but manifests are NOT copied.
  // Firefox: Load extension folder with manifest.json (uses background.scripts)
  // Chrome: Copy manifest.chrome.json to manifest.json before loading (uses service_worker)
  // Safari: Copy manifest.safari.json to manifest.json before loading
  if (isChrome) {
    console.log('[Harbor] Built for Chrome (ESM format)');
    console.log('[Harbor] To load in Chrome:');
    console.log('         1. Copy manifest.chrome.json to manifest.json');
    console.log('         2. Load unpacked extension from this folder');
  } else if (isSafari) {
    console.log('[Harbor] Built for Safari (ESM format)');
    console.log('[Harbor] To use with Safari:');
    console.log('         1. Copy manifest.safari.json to manifest.json');
    console.log('         2. Follow installer/safari/README.md for Xcode setup');
  } else {
    console.log('[Harbor] Built for Firefox (IIFE format)');
    console.log('[Harbor] Load extension from about:debugging using manifest.json');
  }
}

console.log(`[Harbor] Building for ${targetBrowser}${useESM ? ' (ESM)' : ' (IIFE)'}...`);

if (isWatch) {
  const ctx = await context({
    ...common,
    entryPoints,
  });
  await ctx.watch();
  await copyStatic();
  console.log(`[Harbor] esbuild watch started for ${targetBrowser}`);
} else {
  await build({
    ...common,
    entryPoints,
  });
  await copyStatic();
  console.log(`[Harbor] Build complete for ${targetBrowser}`);
}
