#!/usr/bin/env npx tsx
/**
 * Script to start the Memory MCP server for testing
 * Run: npx tsx scripts/start-memory-server.ts
 */

import { getMcpClientManager } from '../src/mcp/manager.js';

async function main() {
  console.log('🚀 Starting Memory MCP Server...\n');

  const mcpManager = getMcpClientManager();

  try {
    const result = await mcpManager.connect(
      {
        id: 'memory-server',
        name: 'Memory Server',
        packageType: 'npm',
        packageId: '@modelcontextprotocol/server-memory',
        autoStart: false,
        args: [],
        requiredEnvVars: [],
        installedAt: Date.now(),
        catalogSource: null,
        homepageUrl: null,
        description: 'Knowledge graph memory for AI',
      },
      {}
    );

    if (result.success) {
      console.log('✅ Memory server connected!');
      console.log(`📦 Server ID: memory-server`);
      console.log(`🔧 Tools available: ${result.tools?.map((t) => t.name).join(', ')}`);
      console.log('\n🔌 Server is running. Press Ctrl+C to stop.\n');

      // Keep process alive
      process.on('SIGINT', async () => {
        console.log('\n\n🛑 Stopping server...');
        await mcpManager.disconnect('memory-server');
        console.log('👋 Goodbye!');
        process.exit(0);
      });

      // Keep alive
      await new Promise(() => {});
    } else {
      console.error('❌ Failed to connect:', result.error);
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();


