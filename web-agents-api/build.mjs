import { build, context } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const isWatch = process.argv.includes('--watch');
const isChrome = process.argv.includes('--chrome');
const isSafari = process.argv.includes('--safari');

// Determine target browser
const targetBrowser = isChrome ? 'chrome' : isSafari ? 'safari' : 'firefox';

// Chrome and Safari use service workers which require ESM format
const useESM = isChrome || isSafari;

const common = {
  bundle: true,
  sourcemap: true,
  format: useESM ? 'esm' : 'iife',  // Chrome/Safari service workers need ESM
  target: ['es2022'],
  outdir: 'dist',
  outbase: 'src',
  logLevel: 'info',
};

const entryPoints = [
  'src/background.ts',
  'src/content-script.ts',
  'src/injected.ts',
  'src/permission-prompt.ts',
  'src/sidebar.ts',
];

async function copyStatic() {
  await mkdir('dist', { recursive: true });
  await copyFile('src/permission-prompt.html', 'dist/permission-prompt.html');
  await copyFile('src/sidebar.html', 'dist/sidebar.html');
  await copyFile('src/design-tokens.css', 'dist/design-tokens.css');
  
  // Log which manifest to use - DON'T overwrite manifest.json
  // Firefox: Use manifest.json (uses background.scripts)
  // Chrome: Manually copy manifest.chrome.json to manifest.json (uses service_worker)
  // Safari: Manually copy manifest.safari.json to manifest.json
  if (isChrome) {
    console.log('[Web Agents API] Built for Chrome (ESM format)');
    console.log('[Web Agents API] To load in Chrome: copy manifest.chrome.json to manifest.json');
  } else if (isSafari) {
    console.log('[Web Agents API] Built for Safari (ESM format)');
    console.log('[Web Agents API] To use with Safari: copy manifest.safari.json to manifest.json');
  } else {
    console.log('[Web Agents API] Built for Firefox (IIFE format)');
    console.log('[Web Agents API] Load extension using manifest.json');
  }
}

console.log(`[Web Agents API] Building for ${targetBrowser}${useESM ? ' (ESM)' : ' (IIFE)'}...`);

if (isWatch) {
  const ctx = await context({
    ...common,
    entryPoints,
  });
  await ctx.watch();
  await copyStatic();
  console.log(`[Web Agents API] esbuild watch started for ${targetBrowser}`);
} else {
  await build({
    ...common,
    entryPoints,
  });
  await copyStatic();
  console.log(`[Web Agents API] Build complete for ${targetBrowser}`);
}
