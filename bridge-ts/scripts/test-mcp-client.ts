#!/usr/bin/env npx tsx
/**
 * Test script for the MCP stdio client.
 * 
 * Usage:
 *   npx tsx scripts/test-mcp-client.ts
 * 
 * This will test connecting to a simple MCP server (memory server).
 * Make sure the @modelcontextprotocol/server-memory package is available.
 */

import { StdioMcpClient } from '../src/mcp/stdio-client.js';

async function main() {
  console.log('Testing MCP stdio client...\n');

  // Test with the MCP memory server (a simple test server)
  const client = new StdioMcpClient({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  });

  try {
    console.log('1. Connecting to MCP memory server...');
    const connectionInfo = await client.connect();
    console.log('   ✓ Connected!');
    console.log(`   Server: ${connectionInfo.serverName} v${connectionInfo.serverVersion}`);
    console.log(`   Capabilities: tools=${connectionInfo.capabilities.tools}, resources=${connectionInfo.capabilities.resources}, prompts=${connectionInfo.capabilities.prompts}`);
    console.log();

    console.log('2. Listing tools...');
    const tools = await client.listTools();
    console.log(`   ✓ Found ${tools.length} tools:`);
    for (const tool of tools) {
      console.log(`   - ${tool.name}: ${tool.description || '(no description)'}`);
    }
    console.log();

    if (tools.length > 0) {
      // Try calling the store tool if it exists
      const storeTool = tools.find(t => t.name === 'store');
      if (storeTool) {
        console.log('3. Testing tool call (store)...');
        const result = await client.callTool('store', {
          key: 'test-key',
          value: 'Hello from Harbor!',
        });
        console.log('   ✓ Tool call succeeded:');
        console.log(`   ${JSON.stringify(result, null, 2)}`);
        console.log();

        // Try retrieving it
        const retrieveTool = tools.find(t => t.name === 'retrieve');
        if (retrieveTool) {
          console.log('4. Testing tool call (retrieve)...');
          const result2 = await client.callTool('retrieve', {
            key: 'test-key',
          });
          console.log('   ✓ Tool call succeeded:');
          console.log(`   ${JSON.stringify(result2, null, 2)}`);
          console.log();
        }
      }
    }

    console.log('5. Disconnecting...');
    await client.disconnect();
    console.log('   ✓ Disconnected!');
    console.log();

    console.log('All tests passed! ✓');

  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

main();


