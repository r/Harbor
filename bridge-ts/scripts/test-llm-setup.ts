#!/usr/bin/env npx tsx
/**
 * Test script for LLM Setup functionality.
 * 
 * Tests:
 * 1. Get setup status (what's available, downloaded, running)
 * 2. Download a model (optional - takes time)
 * 3. Start/stop the local LLM
 * 
 * Usage:
 *   npx tsx scripts/test-llm-setup.ts          # Just check status
 *   npx tsx scripts/test-llm-setup.ts download # Download recommended model
 *   npx tsx scripts/test-llm-setup.ts start    # Start downloaded model
 *   npx tsx scripts/test-llm-setup.ts stop     # Stop running model
 */

import { getLLMSetupManager } from '../src/llm/setup.js';
import { getLLMManager } from '../src/llm/manager.js';

async function showStatus() {
  console.log('\n═══ LLM Setup Status ═══\n');
  
  const setupManager = getLLMSetupManager();
  const status = await setupManager.getStatus();
  
  console.log('Running LLM:');
  if (status.available) {
    console.log(`  ✓ ${status.runningProvider} at ${status.runningUrl}`);
    if (status.activeModel) {
      console.log(`    Model: ${status.activeModel}`);
    }
  } else {
    console.log('  ✗ No LLM running');
  }
  
  console.log('\nDownloaded Models:');
  if (status.downloadedModels.length > 0) {
    for (const modelId of status.downloadedModels) {
      console.log(`  • ${modelId}`);
    }
  } else {
    console.log('  (none)');
  }
  
  console.log('\nAvailable Models:');
  for (const model of status.availableModels) {
    const downloaded = status.downloadedModels.includes(model.id);
    const marker = downloaded ? '✓' : ' ';
    const rec = model.recommended ? ' ⭐ RECOMMENDED' : '';
    console.log(`  [${marker}] ${model.name} (${model.sizeHuman})${rec}`);
    console.log(`      ${model.description}`);
    console.log(`      Tools: ${model.supportsTools ? 'Yes' : 'Limited'}`);
  }
  
  return status;
}

async function downloadModel(modelId: string) {
  console.log(`\n═══ Downloading ${modelId} ═══\n`);
  
  const setupManager = getLLMSetupManager();
  const status = await setupManager.getStatus();
  
  const model = status.availableModels.find(m => m.id === modelId);
  if (!model) {
    console.log(`Unknown model: ${modelId}`);
    console.log('Available models:', status.availableModels.map(m => m.id).join(', '));
    return;
  }
  
  console.log(`Model: ${model.name}`);
  console.log(`Size: ${model.sizeHuman}`);
  console.log(`URL: ${model.url}`);
  console.log('');
  
  const startTime = Date.now();
  let lastPercent = -1;
  
  await setupManager.downloadModel(modelId, (progress) => {
    if (progress.percent !== lastPercent) {
      lastPercent = progress.percent;
      const mb = Math.round(progress.bytesDownloaded / 1_000_000);
      const totalMb = Math.round(progress.totalBytes / 1_000_000);
      
      // Simple progress bar
      const barWidth = 30;
      const filled = Math.round((progress.percent / 100) * barWidth);
      const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
      
      process.stdout.write(`\r[${bar}] ${progress.percent}% (${mb}/${totalMb} MB)`);
    }
    
    if (progress.status === 'complete') {
      console.log('\n\n✓ Download complete!');
    } else if (progress.status === 'error') {
      console.log(`\n\n✗ Download failed: ${progress.error}`);
    }
  });
  
  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log(`Duration: ${duration} seconds`);
}

async function startModel(modelId?: string) {
  console.log('\n═══ Starting Local LLM ═══\n');
  
  const setupManager = getLLMSetupManager();
  const status = await setupManager.getStatus();
  
  // If no model specified, use first downloaded or recommended
  if (!modelId) {
    if (status.downloadedModels.length > 0) {
      modelId = status.downloadedModels[0];
    } else {
      console.log('No models downloaded. Run: npx tsx scripts/test-llm-setup.ts download');
      return;
    }
  }
  
  console.log(`Starting ${modelId}...`);
  
  const result = await setupManager.startLocalLLM(modelId);
  
  if (result.success) {
    console.log(`✓ Server running at ${result.url}`);
    console.log(`  PID: ${setupManager.getPid()}`);
    
    // Detect with LLM manager
    console.log('\nDetecting with LLM manager...');
    const llmManager = getLLMManager();
    const providers = await llmManager.detectAll();
    const llamafile = providers.find(p => p.id === 'llamafile');
    
    if (llamafile?.available) {
      console.log(`✓ Llamafile detected`);
      if (llamafile.models?.length) {
        console.log(`  Model: ${llamafile.models[0].name}`);
      }
    }
    
  } else {
    console.log(`✗ Failed to start: ${result.error}`);
  }
}

async function stopModel() {
  console.log('\n═══ Stopping Local LLM ═══\n');
  
  const setupManager = getLLMSetupManager();
  const stopped = await setupManager.stopLocalLLM();
  
  if (stopped) {
    console.log('✓ Stopped');
  } else {
    console.log('✗ Nothing to stop (no process running)');
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║              LLM Setup Test                                 ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  
  const command = process.argv[2];
  
  if (!command || command === 'status') {
    await showStatus();
    console.log('\nCommands:');
    console.log('  npx tsx scripts/test-llm-setup.ts download [model-id]');
    console.log('  npx tsx scripts/test-llm-setup.ts start [model-id]');
    console.log('  npx tsx scripts/test-llm-setup.ts stop');
    
  } else if (command === 'download') {
    const modelId = process.argv[3] || 'mistral-7b-instruct';
    await downloadModel(modelId);
    await showStatus();
    
  } else if (command === 'start') {
    const modelId = process.argv[3];
    await startModel(modelId);
    
  } else if (command === 'stop') {
    await stopModel();
    
  } else {
    console.log(`Unknown command: ${command}`);
    console.log('Use: status, download, start, stop');
  }
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});


