#!/usr/bin/env npx tsx
/**
 * Test filesystem server - should be more reliable
 */

import { getMcpClientManager } from '../src/mcp/manager.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

async function main() {
  const mcpManager = getMcpClientManager();
  
  // Create a temp directory for testing
  const testDir = path.join(os.tmpdir(), 'harbor-fs-test');
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(path.join(testDir, 'test.txt'), 'Hello from Harbor!');
  fs.writeFileSync(path.join(testDir, 'notes.md'), '# My Notes\n\nThis is a test file.');
  
  console.log('Test directory:', testDir);
  console.log('Testing filesystem server...\n');
  
  const result = await mcpManager.connect(
    {
      id: 'fs-test',
      name: 'Filesystem Server',
      packageType: 'npm',
      packageId: '@modelcontextprotocol/server-filesystem',
      autoStart: false,
      args: [testDir],
      requiredEnvVars: [],
      installedAt: Date.now(),
      catalogSource: null,
      homepageUrl: null,
      description: 'Test filesystem server',
    },
    {}
  );
  
  if (!result.success) {
    console.error('Failed:', result.error);
    process.exit(1);
  }
  
  console.log('✅ Connected!');
  console.log('Tools:', result.tools?.map(t => t.name).join(', '));
  console.log('Resources:', result.resources?.map(r => r.uri).join(', '));
  
  // Test list_directory
  console.log('\n1. Listing directory...');
  try {
    const listRes = await mcpManager.callTool('fs-test', 'list_directory', { path: testDir });
    console.log('✅ list_directory result:', JSON.stringify(listRes, null, 2));
  } catch (e) {
    console.log('❌ list_directory failed:', e);
  }
  
  // Test read_file
  console.log('\n2. Reading file...');
  try {
    const readRes = await mcpManager.callTool('fs-test', 'read_file', { path: path.join(testDir, 'test.txt') });
    console.log('✅ read_file result:', JSON.stringify(readRes, null, 2));
  } catch (e) {
    console.log('❌ read_file failed:', e);
  }
  
  // Test write_file
  console.log('\n3. Writing file...');
  try {
    const writeRes = await mcpManager.callTool('fs-test', 'write_file', { 
      path: path.join(testDir, 'created.txt'),
      content: 'This file was created by Harbor!'
    });
    console.log('✅ write_file result:', JSON.stringify(writeRes, null, 2));
  } catch (e) {
    console.log('❌ write_file failed:', e);
  }
  
  // Test search_files
  console.log('\n4. Searching files...');
  try {
    const searchRes = await mcpManager.callTool('fs-test', 'search_files', { 
      path: testDir,
      pattern: '*.txt'
    });
    console.log('✅ search_files result:', JSON.stringify(searchRes, null, 2));
  } catch (e) {
    console.log('❌ search_files failed:', e);
  }
  
  await mcpManager.disconnect('fs-test');
  
  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
  
  console.log('\n✅ All tests completed!');
}

main().catch(console.error);


