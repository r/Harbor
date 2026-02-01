import { build, context } from 'esbuild';
import { copyFile, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
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
  format: useESM ? 'esm' : 'iife',  // Chrome/Safari service workers need ESM
  target: ['es2022'],
  outdir: outDir,
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
  console.log(`[Web Agents API] ✓ Generated PNG icons from ${svgPath}`);
}

async function copyStatic() {
  await mkdir(outDir, { recursive: true });
  await mkdir(`${outDir}/assets`, { recursive: true });
  
  // Copy the correct manifest for the target browser, adjusting paths for dist/ loading
  const manifestSource = isChrome ? 'manifest.chrome.json' 
                       : isSafari ? 'manifest.safari.json' 
                       : 'manifest.json';
  let manifest = await readFile(manifestSource, 'utf-8');
  // Remove dist/ prefix from paths since we're loading from dist/
  manifest = manifest.replace(/["']dist\//g, '"');
  await writeFile(`${outDir}/manifest.json`, manifest);
  
  // Copy assets (icons, etc.)
  await cp('assets', `${outDir}/assets`, { recursive: true });
  
  // Generate PNG icons for Chrome (Chrome has better PNG support than SVG)
  if (isChrome || isSafari) {
    await generatePngIcons('assets/icon.svg', `${outDir}/assets`);
  }
  
  // Copy HTML and CSS files
  await copyFile('src/permission-prompt.html', `${outDir}/permission-prompt.html`);
  await copyFile('src/sidebar.html', `${outDir}/sidebar.html`);
  await copyFile('src/design-tokens.css', `${outDir}/design-tokens.css`);
  
  // Safari: Add browser compatibility shim (Safari uses `browser` not `chrome`)
  if (isSafari) {
    const shim = `if (typeof chrome === 'undefined' && typeof browser !== 'undefined') { globalThis.chrome = browser; }\n`;
    for (const file of ['content-script.js', 'background.js', 'injected.js']) {
      const filePath = `${outDir}/${file}`;
      if (existsSync(filePath)) {
        const content = await readFile(filePath, 'utf-8');
        await writeFile(filePath, shim + content);
      }
    }
    console.log('[Web Agents API] ✓ Added Safari browser compatibility shim');
  }
  
  // Print load instructions
  console.log('');
  console.log(`[Web Agents API] ✓ Built for ${targetBrowser.charAt(0).toUpperCase() + targetBrowser.slice(1)}`);
  console.log(`[Web Agents API] ✓ Load extension from: ${process.cwd()}/${outDir}`);
  if (isChrome) {
    console.log('[Web Agents API]   → chrome://extensions → Enable Developer Mode → Load unpacked');
  } else if (isSafari) {
    console.log('[Web Agents API]   → See installer/safari/README.md for Xcode setup');
  } else {
    console.log('[Web Agents API]   → about:debugging → This Firefox → Load Temporary Add-on');
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
