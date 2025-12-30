#!/usr/bin/env npx tsx
/**
 * Test filesystem server with real directory
 */

import { getMcpClientManager } from '../src/mcp/manager.js';

const TEST_DIR = '/Users/raffi/harbor-test-files';

async function main() {
  const mcpManager = getMcpClientManager();
  
  console.log('🗂️  Testing Filesystem Server');
  console.log('Directory:', TEST_DIR);
  console.log('='.repeat(50));
  
  const result = await mcpManager.connect(
    {
      id: 'filesystem',
      name: 'Filesystem Server',
      packageType: 'npm',
      packageId: '@modelcontextprotocol/server-filesystem',
      autoStart: false,
      args: [TEST_DIR],
      requiredEnvVars: [],
      installedAt: Date.now(),
      catalogSource: null,
      homepageUrl: null,
      description: 'Access to test files',
    },
    {}
  );
  
  if (!result.success) {
    console.error('❌ Failed to connect:', result.error);
    process.exit(1);
  }
  
  console.log('✅ Connected!');
  console.log('Tools:', result.tools?.map(t => t.name).join(', '));
  
  // Test 1: List allowed directories
  console.log('\n📋 Test 1: List allowed directories');
  try {
    const res = await mcpManager.callTool('filesystem', 'list_allowed_directories', {});
    console.log('✅ Result:', JSON.stringify(res, null, 2));
  } catch (e) {
    console.log('❌ Failed:', e);
  }
  
  // Test 2: List directory
  console.log('\n📋 Test 2: List directory');
  try {
    const res = await mcpManager.callTool('filesystem', 'list_directory', { path: TEST_DIR });
    console.log('✅ Result:', JSON.stringify(res, null, 2));
  } catch (e) {
    console.log('❌ Failed:', e);
  }
  
  // Test 3: Read a file
  console.log('\n📋 Test 3: Read greeting.txt');
  try {
    const res = await mcpManager.callTool('filesystem', 'read_file', { path: `${TEST_DIR}/greeting.txt` });
    console.log('✅ Result:', JSON.stringify(res, null, 2));
  } catch (e) {
    console.log('❌ Failed:', e);
  }
  
  // Test 4: Read notes.md
  console.log('\n📋 Test 4: Read notes.md');
  try {
    const res = await mcpManager.callTool('filesystem', 'read_file', { path: `${TEST_DIR}/notes.md` });
    console.log('✅ Result:', JSON.stringify(res, null, 2));
  } catch (e) {
    console.log('❌ Failed:', e);
  }
  
  // Test 5: Search files
  console.log('\n📋 Test 5: Search for .txt files');
  try {
    const res = await mcpManager.callTool('filesystem', 'search_files', { 
      path: TEST_DIR, 
      pattern: '*.txt' 
    });
    console.log('✅ Result:', JSON.stringify(res, null, 2));
  } catch (e) {
    console.log('❌ Failed:', e);
  }
  
  // Test 6: Write a new file
  console.log('\n📋 Test 6: Write a new file');
  try {
    const res = await mcpManager.callTool('filesystem', 'write_file', { 
      path: `${TEST_DIR}/created-by-harbor.txt`,
      content: 'This file was created by Harbor MCP!\n\nTimestamp: ' + new Date().toISOString()
    });
    console.log('✅ Result:', JSON.stringify(res, null, 2));
  } catch (e) {
    console.log('❌ Failed:', e);
  }
  
  // Test 7: Get file info
  console.log('\n📋 Test 7: Get file info');
  try {
    const res = await mcpManager.callTool('filesystem', 'get_file_info', { 
      path: `${TEST_DIR}/greeting.txt`
    });
    console.log('✅ Result:', JSON.stringify(res, null, 2));
  } catch (e) {
    console.log('❌ Failed:', e);
  }
  
  await mcpManager.disconnect('filesystem');
  console.log('\n✅ All tests completed!');
}

main().catch(console.error);


