import { getMcpClientManager } from '../src/mcp/manager.js';
import { InstalledServer } from '../src/types.js';

async function test() {
    console.log('Testing orchestrator flow...\n');
    
    const mcpManager = getMcpClientManager();
    const serverId = 'filesystem_server';
    
    // Connect to filesystem server
    const server: InstalledServer = {
        id: serverId,
        name: '@modelcontextprotocol/server-filesystem',
        packageType: 'npm',
        packageId: '@modelcontextprotocol/server-filesystem',
        autoStart: false,
        args: ['/Users/raffi/harbor-test-files'],
        requiredEnvVars: [],
        installedAt: Date.now(),
        catalogSource: null,
        homepageUrl: null,
        description: 'Test'
    };
    
    console.log('Connecting to filesystem server...');
    const result = await mcpManager.connect(server);
    
    if (!result.success) {
        console.error('Failed to connect:', result.error);
        return;
    }
    
    console.log('Connected! Tools:', result.tools?.map(t => t.name).join(', '));
    
    // Simulate what the orchestrator does
    const tools = result.tools || [];
    const toolMapping: Record<string, any> = {};
    
    for (const tool of tools) {
        const prefixedName = `${serverId}__${tool.name}`;
        toolMapping[prefixedName] = {
            serverId,
            originalName: tool.name,
            tool,
        };
    }
    
    console.log('\nTool mapping keys:', Object.keys(toolMapping).join(', '));
    
    // Now simulate text parsing
    const content = '{"name": "filesystem_server__list_allowed_directories"}';
    console.log('\nParsing content:', content);
    
    const startIdx = content.indexOf('{"name"');
    let braceCount = 0;
    let endIdx = startIdx;
    for (let i = startIdx; i < content.length; i++) {
        if (content[i] === '{') braceCount++;
        else if (content[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
                endIdx = i + 1;
                break;
            }
        }
    }
    const jsonStr = content.slice(startIdx, endIdx);
    const parsed = JSON.parse(jsonStr);
    
    console.log('Parsed name:', parsed.name);
    console.log('Is in toolMapping?', parsed.name in toolMapping);
    console.log('toolMapping[parsed.name]:', toolMapping[parsed.name] ? 'EXISTS' : 'UNDEFINED');
    
    await mcpManager.disconnect(serverId);
    console.log('\nDone!');
}

test().catch(console.error);
