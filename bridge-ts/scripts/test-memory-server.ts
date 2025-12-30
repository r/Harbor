#!/usr/bin/env npx tsx
/**
 * Test script for Memory Server tools
 * 
 * This script systematically tests all memory server operations
 * to identify what works and what doesn't.
 */

import { getMcpClientManager } from '../src/mcp/manager.js';

interface TestResult {
  name: string;
  success: boolean;
  input: unknown;
  output?: unknown;
  error?: string;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<unknown>): Promise<void> {
  console.log(`\n📋 Testing: ${name}`);
  console.log('─'.repeat(50));
  
  try {
    const result = await fn();
    console.log('✅ SUCCESS');
    console.log('Output:', JSON.stringify(result, null, 2).slice(0, 500));
    results.push({ name, success: true, input: name, output: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log('❌ FAILED:', message);
    results.push({ name, success: false, input: name, error: message });
  }
}

async function main() {
  console.log('🧪 Memory Server Tool Tester');
  console.log('='.repeat(50));
  
  const mcpManager = getMcpClientManager();
  const serverId = 'memory-test';
  
  // Connect to memory server
  console.log('\n🔌 Connecting to memory server...');
  
  const connectResult = await mcpManager.connect(
    {
      id: serverId,
      name: 'Memory Server Test',
      packageType: 'npm',
      packageId: '@modelcontextprotocol/server-memory',
      autoStart: false,
      args: [],
      requiredEnvVars: [],
      installedAt: Date.now(),
      catalogSource: null,
      homepageUrl: null,
      description: 'Test instance',
    },
    {}
  );
  
  if (!connectResult.success) {
    console.error('Failed to connect:', connectResult.error);
    process.exit(1);
  }
  
  console.log('✅ Connected!');
  console.log('Available tools:', connectResult.tools?.map(t => t.name).join(', '));
  
  // List all tools with their schemas
  console.log('\n📖 Tool Schemas:');
  console.log('─'.repeat(50));
  for (const tool of connectResult.tools || []) {
    console.log(`\n${tool.name}:`);
    console.log('  Description:', tool.description);
    console.log('  Schema:', JSON.stringify(tool.inputSchema, null, 2).split('\n').map(l => '  ' + l).join('\n'));
  }
  
  // Test 1: Create a simple entity
  await test('create_entities - single entity', async () => {
    return mcpManager.callTool(serverId, 'create_entities', {
      entities: [
        {
          name: 'Winston',
          entityType: 'dog',
          observations: ['is a golden retriever', 'belongs to the user'],
        },
      ],
    });
  });
  
  // Test 2: Create entity with minimal data
  await test('create_entities - minimal entity', async () => {
    return mcpManager.callTool(serverId, 'create_entities', {
      entities: [
        {
          name: 'TestEntity',
          entityType: 'test',
          observations: ['test observation'],
        },
      ],
    });
  });
  
  // Test 3: Read the graph
  await test('read_graph', async () => {
    return mcpManager.callTool(serverId, 'read_graph', {});
  });
  
  // Test 4: Search nodes
  await test('search_nodes - query "dog"', async () => {
    return mcpManager.callTool(serverId, 'search_nodes', {
      query: 'dog',
    });
  });
  
  // Test 5: Search nodes with different query
  await test('search_nodes - query "Winston"', async () => {
    return mcpManager.callTool(serverId, 'search_nodes', {
      query: 'Winston',
    });
  });
  
  // Test 6: Open nodes
  await test('open_nodes - Winston', async () => {
    return mcpManager.callTool(serverId, 'open_nodes', {
      names: ['Winston'],
    });
  });
  
  // Test 7: Add observations to existing entity
  await test('add_observations - to Winston', async () => {
    return mcpManager.callTool(serverId, 'add_observations', {
      observations: [
        {
          entityName: 'Winston',
          contents: ['loves to play fetch'],
        },
      ],
    });
  });
  
  // Test 8: Create relation
  await test('create_relations - user owns Winston', async () => {
    // First create user entity
    await mcpManager.callTool(serverId, 'create_entities', {
      entities: [{ name: 'User', entityType: 'person', observations: ['the human'] }],
    });
    
    return mcpManager.callTool(serverId, 'create_relations', {
      relations: [
        {
          from: 'User',
          to: 'Winston',
          relationType: 'owns',
        },
      ],
    });
  });
  
  // Test 9: Read graph after all operations
  await test('read_graph - final state', async () => {
    return mcpManager.callTool(serverId, 'read_graph', {});
  });
  
  // Print summary
  console.log('\n\n📊 TEST SUMMARY');
  console.log('='.repeat(50));
  
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log();
  
  for (const result of results) {
    const icon = result.success ? '✅' : '❌';
    console.log(`${icon} ${result.name}`);
    if (!result.success && result.error) {
      console.log(`   Error: ${result.error.slice(0, 100)}`);
    }
  }
  
  // Cleanup
  console.log('\n🧹 Disconnecting...');
  await mcpManager.disconnect(serverId);
  console.log('Done!');
  
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);


