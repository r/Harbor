# Multi Web Agent Demos (Extension 3)

Demos for multi-agent coordination and A2A communication.

## APIs Covered

### Agent Registration
- `agent.agents.register(options)` - Register as an agent
- `agent.agents.unregister()` - Unregister
- `agent.agents.getInfo(agentId)` - Get agent info

### Discovery
- `agent.agents.discover(query)` - Find agents by capability
- `agent.agents.list()` - List identity and status of agents registered on this origin

### Communication
- `agent.agents.invoke(agentId, request)` - Invoke another agent
- `agent.agents.send(agentId, payload)` - Send a message
- `agent.agents.onMessage(handler)` - Receive messages
- `agent.agents.onInvoke(handler)` - Handle invocations

### Events
- `agent.agents.subscribe(eventType)` - Subscribe to events
- `agent.agents.unsubscribe(eventType)` - Unsubscribe

### Orchestration
- `agent.agents.orchestrate.pipeline(config)` - Sequential execution
- `agent.agents.orchestrate.parallel(config)` - Concurrent execution
- `agent.agents.orchestrate.route(router, input, task)` - Conditional routing

### Remote Agents
- `agent.agents.remote.connect(endpoint)` - Connect to remote agent
- `agent.agents.remote.disconnect(agentId)` - Disconnect
- `agent.agents.remote.list()` - List connected remotes
- `agent.agents.remote.ping(agentId)` - Check reachability
- `agent.agents.remote.discover(baseUrl)` - Discover remote agents

## Permissions Required

- `agents:register` - Register as agent
- `agents:discover` - Discover agents
- `agents:invoke` - Invoke agents
- `agents:message` - Send messages
- `agents:crossOrigin` - Reach agents on named other sites (pass `agentOrigins`)
- `agents:remote` - Connect to remote agents

## Coming Soon

Demos will be added here as Extension 3 features are tested.
