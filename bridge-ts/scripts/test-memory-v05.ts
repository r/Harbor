#!/usr/bin/env npx tsx
/**
 * Test with older server-memory version
 */

import { getMcpClientManager } from '../src/mcp/manager.js';

async function main() {
  const mcpManager = getMcpClientManager();
  
  console.log('Testing with server-memory@0.5.0...\n');
  
  const result = await mcpManager.connect(
    {
      id: 'memory-v05',
      name: 'Memory Server v0.5',
      packageType: 'npm',
      packageId: '@modelcontextprotocol/server-memory@0.5.0',
      autoStart: false,
      args: [],
      requiredEnvVars: [],
      installedAt: Date.now(),
      catalogSource: null,
      homepageUrl: null,
      description: 'Test v0.5.0',
    },
    {}
  );
  
  if (!result.success) {
    console.error('Failed:', result.error);
    process.exit(1);
  }
  
  console.log('Connected! Tools:', result.tools?.map(t => t.name).join(', '));
  
  // Test create
  console.log('\n1. Creating entity...');
  const createRes = await mcpManager.callTool('memory-v05', 'create_entities', {
    entities: [{ name: 'TestDog', entityType: 'pet', observations: ['is fluffy'] }]
  });
  console.log('Create result:', JSON.stringify(createRes, null, 2));
  
  // Test read
  console.log('\n2. Reading graph...');
  try {
    const readRes = await mcpManager.callTool('memory-v05', 'read_graph', {});
    console.log('Read result:', JSON.stringify(readRes, null, 2));
  } catch (e) {
    console.log('Read failed:', e);
  }
  
  // Test search
  console.log('\n3. Searching...');
  try {
    const searchRes = await mcpManager.callTool('memory-v05', 'search_nodes', { query: 'dog' });
    console.log('Search result:', JSON.stringify(searchRes, null, 2));
  } catch (e) {
    console.log('Search failed:', e);
  }
  
  await mcpManager.disconnect('memory-v05');
  console.log('\nDone!');
}

main().catch(console.error);


