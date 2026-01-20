import { build, context } from 'esbuild';
import { copyFile, mkdir, cp } from 'node:fs/promises';

const isWatch = process.argv.includes('--watch');

const common = {
  bundle: true,
  sourcemap: true,
  format: 'iife',
  target: ['es2022'],
  outdir: 'dist',
  outbase: 'src',
  logLevel: 'info',
};

const entryPoints = [
  'src/background.ts',
  'src/agents/content-script.ts',
  'src/agents/injected.ts',
  'src/directory.ts',
  'src/sidebar.ts',
  'src/permission-prompt.ts',
  'src/demo-bootstrap.ts',
  'src/js-runtime/worker-loader.ts',
];

async function copyStatic() {
  await mkdir('dist', { recursive: true });
  await mkdir('dist/js-runtime', { recursive: true });
  await copyFile('src/directory.html', 'dist/directory.html');
  await copyFile('src/sidebar.html', 'dist/sidebar.html');
  await copyFile('src/permission-prompt.html', 'dist/permission-prompt.html');
  await copyFile('src/design-tokens.css', 'dist/design-tokens.css');
  await copyFile('src/js-runtime/sandbox.html', 'dist/js-runtime/sandbox.html').catch(() => {});
  await copyFile('src/js-runtime/builtin-echo-worker.js', 'dist/js-runtime/builtin-echo-worker.js');
  
  // Copy demo files
  await cp('demo', 'dist/../demo', { recursive: true }).catch(() => {});
}

if (isWatch) {
  const ctx = await context({
    ...common,
    entryPoints,
  });
  await ctx.watch();
  await copyStatic();
  console.log('[Harbor] esbuild watch started');
} else {
  await build({
    ...common,
    entryPoints,
  });
  await copyStatic();
}
