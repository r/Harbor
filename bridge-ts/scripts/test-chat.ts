#!/usr/bin/env npx tsx
/**
 * Test script for the Chat Orchestration system.
 * 
 * This demonstrates the full agent loop:
 * 1. Create a chat session with enabled MCP servers
 * 2. Send a message that requires tool use
 * 3. Watch the orchestrator call tools and get results
 * 4. Receive the final response
 * 
 * Prerequisites:
 * - llamafile running on localhost:8080
 * - An MCP server connected (e.g., memory server)
 * 
 * Usage:
 *   npx tsx scripts/test-chat.ts
 */

import { getLLMManager } from '../src/llm/manager.js';
import { getMcpClientManager } from '../src/mcp/manager.js';
import { getChatSessionStore, createSession, getChatOrchestrator } from '../src/chat/index.js';
import { InstalledServer } from '../src/types.js';

async function testChatOrchestration() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║           Chat Orchestration Test                         ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // 1. Check if LLM is available
  console.log('1. Checking LLM provider...');
  const llmManager = getLLMManager();
  const providers = await llmManager.detectAll();
  
  const llamafile = providers.find(p => p.id === 'llamafile');
  if (!llamafile?.available) {
    console.log('   ❌ Llamafile not detected. Please start llamafile first:');
    console.log('      ./your-model.llamafile --server');
    return;
  }
  
  console.log(`   ✓ Llamafile available`);
  if (llamafile.models?.length) {
    console.log(`     Model: ${llamafile.models[0].name}`);
  }

  // 2. Connect to an MCP server
  console.log('\n2. Connecting to MCP memory server...');
  const mcpManager = getMcpClientManager();
  
  const mockServer: InstalledServer = {
    id: 'memory-test',
    name: 'Memory Server',
    packageType: 'npm',
    packageId: '@modelcontextprotocol/server-memory',
    autoStart: false,
    args: [],
    requiredEnvVars: [],
    installedAt: Date.now(),
    catalogSource: null,
    homepageUrl: null,
    description: 'In-memory knowledge graph server',
  };

  const connectResult = await mcpManager.connect(mockServer, {});
  
  if (!connectResult.success) {
    console.log(`   ❌ Failed to connect: ${connectResult.error}`);
    console.log('      Make sure @modelcontextprotocol/server-memory is installed:');
    console.log('      npm install -g @modelcontextprotocol/server-memory');
    return;
  }
  
  console.log(`   ✓ Connected to ${connectResult.connectionInfo?.serverName}`);
  console.log(`     Tools: ${connectResult.tools?.length || 0}`);
  if (connectResult.tools?.length) {
    console.log(`     Available: ${connectResult.tools.map(t => t.name).join(', ')}`);
  }

  // 3. Create a chat session
  console.log('\n3. Creating chat session...');
  const sessionStore = getChatSessionStore();
  
  const session = createSession([mockServer.id], {
    name: 'Test Chat',
    systemPrompt: `You are a helpful assistant with access to a memory knowledge graph. 
You can create and query entities and relations using the available tools.
When the user asks you to remember something, use the create_entities tool.
When asked to recall, use the read_graph tool.
Be concise in your responses.`,
    config: {
      maxIterations: 5,
    },
  });
  
  sessionStore.save(session);
  console.log(`   ✓ Session created: ${session.id}`);
  console.log(`     Name: ${session.name}`);
  console.log(`     Enabled servers: ${session.enabledServers.join(', ')}`);

  // 4. Send a test message
  console.log('\n4. Sending test message...');
  const orchestrator = getChatOrchestrator();
  
  const testMessage = 'Please remember that my favorite color is blue, and I have a dog named Max.';
  console.log(`   User: "${testMessage}"\n`);
  
  const result = await orchestrator.run(session, testMessage, (step) => {
    // Log each step as it happens
    const prefix = '   ';
    switch (step.type) {
      case 'tool_calls':
        console.log(`${prefix}🔧 Tool calls:`);
        for (const tc of step.toolCalls || []) {
          console.log(`${prefix}   → ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 80)}...)`);
        }
        break;
      case 'tool_results':
        console.log(`${prefix}📋 Tool results:`);
        for (const tr of step.toolResults || []) {
          const content = tr.content.length > 100 ? tr.content.slice(0, 100) + '...' : tr.content;
          console.log(`${prefix}   ${tr.isError ? '❌' : '✓'} ${tr.toolName}: ${content}`);
        }
        break;
      case 'final':
        console.log(`${prefix}🤖 Assistant: ${step.content}`);
        break;
      case 'error':
        console.log(`${prefix}❌ Error: ${step.error}`);
        break;
    }
  });

  // 5. Summary
  console.log('\n5. Orchestration Summary:');
  console.log(`   • Iterations: ${result.iterations}`);
  console.log(`   • Steps: ${result.steps.length}`);
  console.log(`   • Duration: ${result.durationMs}ms`);
  console.log(`   • Reached max: ${result.reachedMaxIterations}`);
  
  // 6. Test recall
  console.log('\n6. Testing recall...');
  const recallMessage = 'What is my favorite color?';
  console.log(`   User: "${recallMessage}"\n`);
  
  const recallResult = await orchestrator.run(session, recallMessage, (step) => {
    const prefix = '   ';
    switch (step.type) {
      case 'tool_calls':
        console.log(`${prefix}🔧 Tool calls:`);
        for (const tc of step.toolCalls || []) {
          console.log(`${prefix}   → ${tc.name}`);
        }
        break;
      case 'tool_results':
        console.log(`${prefix}📋 Tool results received`);
        break;
      case 'final':
        console.log(`${prefix}🤖 Assistant: ${step.content}`);
        break;
    }
  });

  console.log(`\n   Recall completed in ${recallResult.durationMs}ms`);

  // 7. Cleanup
  console.log('\n7. Cleaning up...');
  await mcpManager.disconnect(mockServer.id);
  sessionStore.delete(session.id);
  console.log('   ✓ Disconnected and cleaned up');

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║           Test Complete!                                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
}

// Run the test
testChatOrchestration().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});


