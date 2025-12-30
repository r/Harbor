#!/usr/bin/env npx tsx
/**
 * Test 1: Basic bridge functionality
 * 
 * Tests:
 * - LLM provider detection
 * - MCP server connection via stdio
 * - Tool listing
 * 
 * Prerequisites:
 * - llamafile running on localhost:8080 (optional, will skip LLM tests if not)
 * - Node.js with npx available
 */

import { getLLMManager } from '../src/llm/manager.js';
import { getMcpClientManager } from '../src/mcp/manager.js';
import { InstalledServer } from '../src/types.js';

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  skipped?: boolean;
}

const results: TestResult[] = [];

function log(msg: string) {
  console.log(msg);
}

function pass(name: string, message: string) {
  results.push({ name, passed: true, message });
  log(`  ✓ ${name}: ${message}`);
}

function fail(name: string, message: string) {
  results.push({ name, passed: false, message });
  log(`  ✗ ${name}: ${message}`);
}

function skip(name: string, message: string) {
  results.push({ name, passed: true, message, skipped: true });
  log(`  ○ ${name}: ${message} (skipped)`);
}

async function testLLMDetection(): Promise<boolean> {
  log('\n═══ Test 1: LLM Provider Detection ═══');
  
  const llmManager = getLLMManager();
  const providers = await llmManager.detectAll();
  
  if (providers.length === 0) {
    fail('Provider list', 'No providers registered');
    return false;
  }
  pass('Provider list', `${providers.length} provider(s) registered`);
  
  // Check for any available provider
  const available = providers.find(p => p.available);
  
  if (available) {
    pass('LLM available', `${available.name} at ${available.baseUrl}`);
    if (available.models?.length) {
      pass('LLM models', `Model: ${available.models[0].name}`);
    }
    return true;
  } else {
    skip('LLM available', 'No LLM running - start llamafile or ollama');
    return false;
  }
}

async function testMcpConnection(): Promise<boolean> {
  log('\n═══ Test 2: MCP Server Connection ═══');
  
  const mcpManager = getMcpClientManager();
  
  // Create a mock installed server config
  const testServer: InstalledServer = {
    id: 'test-memory',
    name: 'Test Memory Server',
    packageType: 'npm',
    packageId: '@modelcontextprotocol/server-memory',
    autoStart: false,
    args: [],
    requiredEnvVars: [],
    installedAt: Date.now(),
    catalogSource: null,
    homepageUrl: null,
    description: 'Test server',
  };
  
  log('  Attempting to connect to @modelcontextprotocol/server-memory...');
  
  try {
    const result = await mcpManager.connect(testServer, {});
    
    if (!result.success) {
      fail('MCP connect', result.error || 'Unknown error');
      log('  Hint: npm install -g @modelcontextprotocol/server-memory');
      return false;
    }
    
    pass('MCP connect', `Connected to ${result.connectionInfo?.serverName} v${result.connectionInfo?.serverVersion}`);
    
    // Check capabilities
    const caps = result.connectionInfo?.capabilities;
    pass('Capabilities', `tools=${caps?.tools}, resources=${caps?.resources}, prompts=${caps?.prompts}`);
    
    // List tools
    const tools = result.tools || [];
    if (tools.length > 0) {
      pass('Tools', `${tools.length} tool(s): ${tools.map(t => t.name).join(', ')}`);
    } else {
      pass('Tools', 'No tools (this is fine for memory server)');
    }
    
    // Test tool call if we have tools
    if (tools.length > 0) {
      log('\n  Testing tool call...');
      try {
        // Memory server has create_entities, read_graph, etc.
        const createTool = tools.find(t => t.name === 'create_entities');
        if (createTool) {
          const callResult = await mcpManager.callTool(testServer.id, 'create_entities', {
            entities: [{ name: 'TestEntity', entityType: 'test', observations: ['This is a test'] }]
          });
          
          if (callResult.isError) {
            fail('Tool call', `Error: ${callResult.content?.[0]?.text}`);
          } else {
            pass('Tool call', 'create_entities succeeded');
          }
        } else {
          skip('Tool call', 'create_entities not found');
        }
      } catch (e) {
        fail('Tool call', String(e));
      }
    }
    
    // Disconnect
    await mcpManager.disconnect(testServer.id);
    pass('MCP disconnect', 'Disconnected cleanly');
    
    return true;
  } catch (e) {
    fail('MCP connect', String(e));
    log('  Hint: npm install -g @modelcontextprotocol/server-memory');
    return false;
  }
}

async function testLLMChat(available: boolean): Promise<void> {
  log('\n═══ Test 3: LLM Chat ═══');
  
  if (!available) {
    skip('LLM chat', 'No LLM available');
    return;
  }
  
  const llmManager = getLLMManager();
  const activeId = llmManager.getActiveId();
  
  log(`  Using provider: ${activeId}`);
  
  try {
    const response = await llmManager.chat({
      messages: [
        { role: 'user', content: 'Say "test passed" and nothing else.' }
      ],
      maxTokens: 50,
    });
    
    if (response.finishReason === 'error') {
      fail('LLM chat', response.error || 'Unknown error');
      return;
    }
    
    const content = response.message.content;
    if (content.toLowerCase().includes('test') || content.toLowerCase().includes('pass')) {
      pass('LLM chat', `Response: "${content.slice(0, 50)}"`);
    } else {
      pass('LLM chat', `Got response (${content.length} chars): "${content.slice(0, 30)}..."`);
    }
    
  } catch (e) {
    fail('LLM chat', String(e));
  }
}

async function testLLMWithTools(llmAvailable: boolean, mcpAvailable: boolean): Promise<void> {
  log('\n═══ Test 4: LLM with Tools ═══');
  
  if (!llmAvailable) {
    skip('LLM with tools', 'No LLM available');
    return;
  }
  
  if (!mcpAvailable) {
    skip('LLM with tools', 'MCP server not available');
    return;
  }
  
  const llmManager = getLLMManager();
  const mcpManager = getMcpClientManager();
  const activeId = llmManager.getActiveId();
  
  log(`  Using provider: ${activeId}`);
  
  // Connect to memory server
  const testServer: InstalledServer = {
    id: 'test-memory-2',
    name: 'Test Memory Server',
    packageType: 'npm',
    packageId: '@modelcontextprotocol/server-memory',
    autoStart: false,
    args: [],
    requiredEnvVars: [],
    installedAt: Date.now(),
    catalogSource: null,
    homepageUrl: null,
    description: 'Test server',
  };
  
  try {
    const connectResult = await mcpManager.connect(testServer, {});
    if (!connectResult.success) {
      fail('Connect for tool test', connectResult.error || 'Failed');
      return;
    }
    
    // Get tools and convert to LLM format
    const mcpTools = connectResult.tools || [];
    const tools = mcpTools.map(t => ({
      name: t.name,
      description: t.description || 'No description',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));
    
    if (tools.length === 0) {
      skip('LLM with tools', 'No tools available from MCP server');
      await mcpManager.disconnect(testServer.id);
      return;
    }
    
    pass('Tools available', tools.map(t => t.name).join(', '));
    
    // Ask LLM to use a tool
    const response = await llmManager.chat({
      messages: [
        { role: 'system', content: 'You have access to a memory knowledge graph. Use the tools to help the user.' },
        { role: 'user', content: 'Please create an entity named "TestFromLLM" of type "test_entity" with observation "Created by LLM test"' }
      ],
      tools,
      maxTokens: 500,
    });
    
    if (response.finishReason === 'tool_calls' && response.message.toolCalls?.length) {
      pass('LLM tool call', `LLM requested: ${response.message.toolCalls.map(tc => tc.name).join(', ')}`);
      
      // Execute the tool call
      for (const tc of response.message.toolCalls) {
        const result = await mcpManager.callTool(testServer.id, tc.name, tc.arguments);
        if (result.isError) {
          fail('Execute tool', `${tc.name} failed: ${result.content?.[0]?.text}`);
        } else {
          pass('Execute tool', `${tc.name} succeeded`);
        }
      }
    } else if (response.finishReason === 'stop') {
      // LLM didn't call a tool - might just respond directly
      skip('LLM tool call', `LLM responded without tools: "${response.message.content.slice(0, 50)}..."`);
    } else {
      fail('LLM tool call', `Unexpected finish reason: ${response.finishReason}`);
    }
    
    await mcpManager.disconnect(testServer.id);
    
  } catch (e) {
    fail('LLM with tools', String(e));
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║              Harbor Bridge Test Suite                       ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  
  // Run tests
  const llmAvailable = await testLLMDetection();
  const mcpAvailable = await testMcpConnection();
  await testLLMChat(llmAvailable);
  await testLLMWithTools(llmAvailable, mcpAvailable);
  
  // Summary
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('════════════════════════════════════════════════════════════════');
  
  const passed = results.filter(r => r.passed && !r.skipped).length;
  const failed = results.filter(r => !r.passed).length;
  const skipped = results.filter(r => r.skipped).length;
  
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Skipped: ${skipped}`);
  
  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  ✗ ${r.name}: ${r.message}`);
    }
  }
  
  console.log('\n════════════════════════════════════════════════════════════════');
  
  if (failed > 0) {
    console.log('Some tests failed. See above for details.');
    process.exit(1);
  } else if (skipped > 0) {
    console.log('All tests passed! (some skipped due to missing prerequisites)');
    console.log('\nTo run all tests:');
    console.log('  1. Start llamafile: ./your-model.llamafile --server');
    console.log('  2. Install memory server: npm install -g @modelcontextprotocol/server-memory');
  } else {
    console.log('All tests passed! ✓');
  }
}

main().catch(e => {
  console.error('Test suite crashed:', e);
  process.exit(1);
});

