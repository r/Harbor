#!/usr/bin/env npx ts-node
/**
 * Test script for the any-llm TypeScript port.
 * 
 * Run with: npx ts-node scripts/test-any-llm.ts
 */

import {
  completion,
  completionStream,
  listModels,
  checkProvider,
  getSupportedProviders,
  AnyLLM,
} from '../src/any-llm/index.js';

async function testProviders() {
  console.log('='.repeat(60));
  console.log('any-llm TypeScript Port - Test Script');
  console.log('='.repeat(60));
  
  // List supported providers
  const providers = getSupportedProviders();
  console.log('\n📋 Supported providers:', providers.join(', '));
  
  // Check each provider
  console.log('\n🔍 Checking provider availability...\n');
  
  for (const provider of providers) {
    const status = await checkProvider(provider);
    const icon = status.available ? '✅' : '❌';
    console.log(`${icon} ${provider}: ${status.available ? 'Available' : status.error || 'Not available'}`);
    
    if (status.available && status.models && status.models.length > 0) {
      console.log(`   Models: ${status.models.slice(0, 3).map(m => m.id).join(', ')}${status.models.length > 3 ? '...' : ''}`);
    }
  }
  
  // Test Ollama if available
  console.log('\n' + '='.repeat(60));
  console.log('Testing Ollama (local)...');
  console.log('='.repeat(60));
  
  const ollamaStatus = await checkProvider('ollama');
  if (ollamaStatus.available) {
    try {
      // Get first available model
      const models = await listModels('ollama');
      if (models.length === 0) {
        console.log('⚠️  No models installed in Ollama. Run: ollama pull llama3.2');
      } else {
        const modelId = models[0].id;
        console.log(`\n📤 Sending request to Ollama (${modelId})...`);
        
        const response = await completion({
          model: `ollama:${modelId}`,
          messages: [{ role: 'user', content: 'Say "Hello from any-llm!" in exactly 5 words.' }],
          max_tokens: 50,
        });
        
        console.log('📥 Response:', response.choices[0].message.content);
        console.log('📊 Usage:', response.usage);
      }
    } catch (error) {
      console.error('❌ Ollama test failed:', error);
    }
  } else {
    console.log('⚠️  Ollama not running. Start with: ollama serve');
  }
  
  // Test OpenAI if API key is set
  console.log('\n' + '='.repeat(60));
  console.log('Testing OpenAI (remote)...');
  console.log('='.repeat(60));
  
  if (process.env.OPENAI_API_KEY) {
    try {
      console.log('\n📤 Sending request to OpenAI...');
      
      const response = await completion({
        model: 'openai:gpt-4o-mini',
        messages: [{ role: 'user', content: 'Say "Hello from any-llm!" in exactly 5 words.' }],
        max_tokens: 50,
      });
      
      console.log('📥 Response:', response.choices[0].message.content);
      console.log('📊 Usage:', response.usage);
    } catch (error) {
      console.error('❌ OpenAI test failed:', error);
    }
  } else {
    console.log('⚠️  OPENAI_API_KEY not set. Skipping OpenAI test.');
  }
  
  // Test Anthropic if API key is set
  console.log('\n' + '='.repeat(60));
  console.log('Testing Anthropic (remote)...');
  console.log('='.repeat(60));
  
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      console.log('\n📤 Sending request to Anthropic...');
      
      const response = await completion({
        model: 'anthropic:claude-3-5-haiku-20241022',
        messages: [{ role: 'user', content: 'Say "Hello from any-llm!" in exactly 5 words.' }],
        max_tokens: 50,
      });
      
      console.log('📥 Response:', response.choices[0].message.content);
      console.log('📊 Usage:', response.usage);
    } catch (error) {
      console.error('❌ Anthropic test failed:', error);
    }
  } else {
    console.log('⚠️  ANTHROPIC_API_KEY not set. Skipping Anthropic test.');
  }
  
  // Test streaming
  console.log('\n' + '='.repeat(60));
  console.log('Testing Streaming...');
  console.log('='.repeat(60));
  
  if (ollamaStatus.available) {
    const models = await listModels('ollama');
    if (models.length > 0) {
      const modelId = models[0].id;
      console.log(`\n📤 Streaming from Ollama (${modelId})...`);
      process.stdout.write('📥 Response: ');
      
      for await (const chunk of completionStream({
        model: `ollama:${modelId}`,
        messages: [{ role: 'user', content: 'Count from 1 to 5, one number per line.' }],
        max_tokens: 50,
      })) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          process.stdout.write(content);
        }
      }
      console.log('\n');
    }
  }
  
  // Test class API
  console.log('='.repeat(60));
  console.log('Testing Class API (AnyLLM)...');
  console.log('='.repeat(60));
  
  if (ollamaStatus.available) {
    const llm = AnyLLM.create('ollama');
    const isAvailable = await llm.isAvailable();
    console.log(`\n✅ Created Ollama instance. Available: ${isAvailable}`);
    
    const models = await llm.listModels();
    console.log(`📋 Found ${models.length} models`);
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('Tests complete!');
  console.log('='.repeat(60));
}

testProviders().catch(console.error);

