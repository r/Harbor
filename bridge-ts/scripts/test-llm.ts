#!/usr/bin/env npx tsx
/**
 * Test script for the LLM provider.
 * 
 * Usage:
 *   npx tsx scripts/test-llm.ts
 * 
 * Make sure llamafile is running on localhost:8080 first.
 */

import { LlamafileProvider } from '../src/llm/llamafile.js';
import { getLLMManager } from '../src/llm/manager.js';

async function testProvider() {
  console.log('Testing LlamafileProvider directly...\n');

  const provider = new LlamafileProvider();

  console.log('1. Detecting llamafile...');
  const available = await provider.detect();
  console.log(`   ${available ? '✓ llamafile is running' : '✗ llamafile not detected'}`);
  
  if (!available) {
    console.log('\n   Start llamafile and try again:');
    console.log('   ./llamafile --server --nobrowser');
    return false;
  }

  console.log('\n2. Listing models...');
  const models = await provider.listModels();
  console.log(`   ✓ Found ${models.length} model(s):`);
  for (const model of models) {
    console.log(`   - ${model.id} (tools: ${model.supportsTools})`);
  }

  console.log('\n3. Sending chat message...');
  const response = await provider.chat({
    messages: [
      { role: 'user', content: 'Say "Hello from Harbor!" and nothing else.' },
    ],
    maxTokens: 50,
    temperature: 0,
  });
  
  console.log(`   ✓ Response (finish: ${response.finishReason}):`);
  console.log(`   "${response.message.content}"`);
  
  if (response.usage) {
    console.log(`   Tokens: ${response.usage.promptTokens} prompt, ${response.usage.completionTokens} completion`);
  }

  return true;
}

async function testManager() {
  console.log('\n\nTesting LLMManager...\n');

  const manager = getLLMManager();

  console.log('1. Detecting all providers...');
  const providers = await manager.detectAll();
  console.log(`   ✓ Detected ${providers.length} provider(s):`);
  for (const p of providers) {
    console.log(`   - ${p.name}: ${p.available ? 'available' : 'not available'} (${p.baseUrl})`);
  }

  const active = manager.getActiveId();
  console.log(`   Active: ${active || 'none'}`);

  if (!manager.hasAvailableProvider()) {
    console.log('\n   No providers available. Start llamafile first.');
    return false;
  }

  console.log('\n2. Listing models from active provider...');
  const models = await manager.listModels();
  console.log(`   ✓ Found ${models.length} model(s)`);

  console.log('\n3. Sending chat via manager...');
  const response = await manager.chat({
    messages: [
      { role: 'user', content: 'What is 2 + 2? Reply with just the number.' },
    ],
    maxTokens: 10,
    temperature: 0,
  });
  
  if (response.finishReason === 'error') {
    console.log(`   ✗ Error: ${response.error}`);
    return false;
  }
  
  console.log(`   ✓ Response: "${response.message.content.trim()}"`);

  return true;
}

async function testToolCalling() {
  console.log('\n\nTesting Tool Calling...\n');

  const manager = getLLMManager();

  if (!manager.hasAvailableProvider()) {
    console.log('   Skipping - no provider available');
    return true;
  }

  console.log('1. Sending chat with tool definitions...');
  const response = await manager.chat({
    messages: [
      { role: 'user', content: 'What is the weather in San Francisco?' },
    ],
    tools: [
      {
        name: 'get_weather',
        description: 'Get the current weather for a location',
        inputSchema: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'The city name' },
          },
          required: ['location'],
        },
      },
    ],
    maxTokens: 100,
    temperature: 0,
  });

  console.log(`   Finish reason: ${response.finishReason}`);
  
  if (response.finishReason === 'tool_calls' && response.message.toolCalls) {
    console.log('   ✓ LLM wants to call tools:');
    for (const tc of response.message.toolCalls) {
      console.log(`   - ${tc.name}(${JSON.stringify(tc.arguments)})`);
    }
  } else if (response.finishReason === 'stop') {
    console.log('   Note: LLM did not request tool call (model may not support it)');
    console.log(`   Response: "${response.message.content.substring(0, 100)}..."`);
  } else if (response.finishReason === 'error') {
    console.log(`   ✗ Error: ${response.error}`);
  }

  return true;
}

async function main() {
  console.log('='.repeat(60));
  console.log('LLM Provider Test');
  console.log('='.repeat(60));

  try {
    const providerOk = await testProvider();
    if (!providerOk) {
      process.exit(1);
    }

    const managerOk = await testManager();
    if (!managerOk) {
      process.exit(1);
    }

    await testToolCalling();

    console.log('\n' + '='.repeat(60));
    console.log('All tests passed! ✓');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\nTest failed:', error);
    process.exit(1);
  }
}

main();


