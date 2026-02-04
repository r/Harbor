import { build, context } from 'esbuild';
import { copyFile, mkdir, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import sharp from 'sharp';

const isWatch = process.argv.includes('--watch');
const isChrome = process.argv.includes('--chrome');
const isSafari = process.argv.includes('--safari');

// Determine target browser
const targetBrowser = isChrome ? 'chrome' : isSafari ? 'safari' : 'firefox';

// Chrome and Safari use service workers which require ESM format
const useESM = isChrome || isSafari;

// Output directory - each browser gets its own folder
const outDir = `dist-${targetBrowser}`;

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
  'src/discovery-injected.ts',
  'src/page-chat.ts',
  'src/directory.ts',
  'src/sidebar.ts',
  'src/demo-bootstrap.ts',
  'src/js-runtime/worker-loader.ts',
];

// Generate PNG icons from SVG for Chrome (Chrome prefers PNG)
async function generatePngIcons(svgPath, outputDir) {
  const sizes = [16, 32, 48, 128];
  const svgBuffer = await readFile(svgPath);
  
  for (const size of sizes) {
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(`${outputDir}/icon-${size}.png`);
  }
  console.log(`[Harbor] ✓ Generated PNG icons from ${svgPath}`);
}

async function copyStatic() {
  await mkdir(outDir, { recursive: true });
  await mkdir(`${outDir}/js-runtime`, { recursive: true });
  await mkdir(`${outDir}/assets`, { recursive: true });
  
  // Copy the correct manifest for the target browser, adjusting paths for dist/ loading
  const manifestSource = isChrome ? 'manifest.chrome.json' 
                       : isSafari ? 'manifest.safari.json' 
                       : 'manifest.json';
  let manifest = await readFile(manifestSource, 'utf-8');
  // Remove dist/ prefix from paths since we're loading from dist/
  manifest = manifest.replace(/["']dist\//g, '"');
  await writeFile(`${outDir}/manifest.json`, manifest);
  
  // Copy assets (icons, wasm files, etc.)
  await cp('assets', `${outDir}/assets`, { recursive: true });
  
  // Generate PNG icons for Chrome (Chrome has better PNG support than SVG)
  if (isChrome || isSafari) {
    await generatePngIcons('assets/icon.svg', `${outDir}/assets`);
  }
  
  // Copy HTML and CSS files
  await copyFile('src/directory.html', `${outDir}/directory.html`);
  await copyFile('src/sidebar.html', `${outDir}/sidebar.html`);
  await copyFile('src/permission-prompt.html', `${outDir}/permission-prompt.html`);
  await copyFile('src/design-tokens.css', `${outDir}/design-tokens.css`);
  await copyFile('src/js-runtime/sandbox.html', `${outDir}/js-runtime/sandbox.html`).catch(() => {});
  await copyFile('src/js-runtime/builtin-echo-worker.js', `${outDir}/js-runtime/builtin-echo-worker.js`);
  
  // Copy demo files into dist for self-contained extension
  // Need to adjust paths in HTML files since the structure changes when copied
  await cp('demo', `${outDir}/demo`, { recursive: true }).catch(() => {});
  
  // Fix paths in demo HTML files (they reference src/ and dist/ which don't exist in the output)
  const demoHtmlFiles = [
    `${outDir}/demo/chat-poc/index.html`,
  ];
  for (const htmlFile of demoHtmlFiles) {
    if (existsSync(htmlFile)) {
      let html = await readFile(htmlFile, 'utf-8');
      // Fix CSS path: ../../src/design-tokens.css -> ../../design-tokens.css
      html = html.replace(/\.\.\/\.\.\/src\/design-tokens\.css/g, '../../design-tokens.css');
      // Fix JS path: ../../dist/demo-bootstrap.js -> ../../demo-bootstrap.js
      html = html.replace(/\.\.\/\.\.\/dist\/demo-bootstrap\.js/g, '../../demo-bootstrap.js');
      await writeFile(htmlFile, html);
    }
  }
  
  // Copy bundled MCP servers from mcp-servers/examples
  await mkdir(`${outDir}/bundled/gmail-harbor`, { recursive: true });
  await cp('../mcp-servers/examples/gmail', `${outDir}/bundled/gmail-harbor`, { recursive: true }).catch(() => {});
  
  // Safari: Patch import.meta.url and extract WASM files
  if (isSafari) {
    const bgPath = `${outDir}/background.js`;
    let bgCode = await readFile(bgPath, 'utf-8');
    if (bgCode.includes('import.meta')) {
      bgCode = bgCode.replace(/import\.meta\.url/g, 'browser.runtime.getURL("")');
      await writeFile(bgPath, bgCode);
      console.log('[Harbor] ✓ Patched import.meta.url for Safari compatibility');
    }
    
    // Extract wasmer WASI WASM from the library (it's embedded as a data URI)
    const wasmerLib = await readFile('node_modules/@wasmer/wasi/dist/Library.esm.min.js', 'utf-8');
    const wasmMatch = wasmerLib.match(/data:application\/wasm;base64,([A-Za-z0-9+/=]+)/);
    if (wasmMatch) {
      const wasmBytes = Buffer.from(wasmMatch[1], 'base64');
      await writeFile(`${outDir}/wasmer_wasi_js_bg.wasm`, wasmBytes);
      console.log(`[Harbor] ✓ Extracted wasmer WASM (${Math.round(wasmBytes.length/1024)} KB)`);
    }
  }
  
  // Print load instructions
  console.log('');
  console.log(`[Harbor] ✓ Built for ${targetBrowser.charAt(0).toUpperCase() + targetBrowser.slice(1)}`);
  console.log(`[Harbor] ✓ Load extension from: ${process.cwd()}/${outDir}`);
  if (isChrome) {
    console.log('[Harbor]   → chrome://extensions → Enable Developer Mode → Load unpacked');
  } else if (isSafari) {
    console.log('[Harbor]   → See installer/safari/README.md for Xcode setup');
  } else {
    console.log('[Harbor]   → about:debugging → This Firefox → Load Temporary Add-on');
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
