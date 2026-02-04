# Harbor MCP Host Testing Plan

This document provides comprehensive testing guidance for the MCP Host implementation, including automated tests and manual QA procedures.

---

## Table of Contents

1. [Automated Tests](#automated-tests)
2. [Manual QA Plan](#manual-qa-plan)
3. [Test Data & Fixtures](#test-data--fixtures)
4. [Test Environment Setup](#test-environment-setup)

---

## Automated Tests

### Running Tests

```bash
# Run Rust bridge tests
cd bridge-rs
cargo test

# Run extension tests  
cd extension
npm test
```

### Test Suite Overview

| Test File | Description | Coverage |
|-----------|-------------|----------|
| `permissions.test.ts` | Permission system unit tests | Grant/revoke, expiry, allowlists |
| `tool-registry.test.ts` | Tool registry unit tests | Namespacing, registration, filtering |
| `rate-limiter.test.ts` | Rate limiting unit tests | Budgets, concurrency, timeouts |
| `observability.test.ts` | Observability unit tests | Metrics recording, aggregation |
| `host.integration.test.ts` | Host integration tests | End-to-end flows |

### Test Categories

#### 1. Permission Tests (`permissions.test.ts`)

| Test Case | Expected Behavior |
|-----------|-------------------|
| Grant ALLOW_ONCE | Permission granted, has expiry |
| Grant ALLOW_ALWAYS | Permission granted, persisted |
| Grant DENY | Permission explicitly denied |
| Check missing permission | Returns ERR_SCOPE_REQUIRED |
| ALLOW_ONCE expiry | Permission expires after TTL |
| Tab-scoped expiry | Permission expires when tab closes |
| Tool allowlist | Only allowed tools permitted |

#### 2. Tool Registry Tests (`tool-registry.test.ts`)

| Test Case | Expected Behavior |
|-----------|-------------------|
| Namespace creation | `serverId/toolName` format |
| Register tools | Tools added with correct metadata |
| Replace tools | Existing tools replaced on re-register |
| Unregister tools | All tools removed for server |
| Filter by serverIds | Only matching servers returned |
| Filter by pattern | Only matching names returned |
| Permission-aware listing | Respects TOOLS_LIST permission |

#### 3. Rate Limiter Tests (`rate-limiter.test.ts`)

| Test Case | Expected Behavior |
|-----------|-------------------|
| Create run with budget | Budget initialized correctly |
| Budget enforcement | ERR_BUDGET_EXCEEDED when exceeded |
| Concurrent limit | ERR_RATE_LIMITED at limit |
| Slot acquire/release | Counters updated correctly |
| Timeout promise | ERR_TOOL_TIMEOUT on timeout |
| Stale run cleanup | Old runs removed |

#### 4. Integration Tests (`host.integration.test.ts`)

| Test Case | Expected Behavior |
|-----------|-------------------|
| List tools without permission | ERR_SCOPE_REQUIRED |
| List tools with permission | All tools returned |
| Call unknown tool | ERR_TOOL_NOT_FOUND |
| Call disconnected server | ERR_SERVER_UNAVAILABLE |
| Call blocked by allowlist | ERR_TOOL_NOT_ALLOWED |
| Call blocked by rate limit | ERR_RATE_LIMITED |
| Agent run events | Status and final events emitted |

---

## Manual QA Plan

### Prerequisites

1. Firefox Developer Edition (for extension testing)
2. Rust (latest stable) installed
3. Node.js 18+ installed
4. Python 3.9+ with uv/uvx installed
5. Docker installed (optional, for isolation tests)
6. Test MCP servers installed (see Test Data section)

### Test Environment Setup

```bash
# 1. Build the Rust bridge
cd bridge-rs
cargo build --release

# 2. Build the extension
cd ../extension
npm install
npm run build

# 3. Install the native messaging manifest
cd ../bridge-rs
./install.sh

# 4. Load extension in Firefox
# about:debugging -> Load Temporary Add-on -> extension/dist/manifest.json
```

---

### QA Test Scenarios

#### A. Server Installation & Connection

**A1. Install npm server from curated list**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open Harbor sidebar | Sidebar shows curated servers |
| 2 | Click "Install" on Filesystem server | Install progress shown |
| 3 | Wait for installation | Success message, server appears in "My Servers" |
| 4 | Click "Start" on installed server | Server starts, status shows "Running" |
| 5 | Click "Tools" button | Tool list displayed (read_file, write_file, etc.) |

**A2. Install Python server from curated list**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Click "Install" on Time server | uvx/pipx install initiated |
| 2 | Wait for installation | Success message |
| 3 | Start the server | Server connects successfully |
| 4 | View tools | Time-related tools listed |

**A3. Install from GitHub URL**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Paste GitHub MCP repo URL | URL validated |
| 2 | Click "Install" | Package type detected (npm/pypi/binary) |
| 3 | Wait for installation | Server installed correctly |

**A4. Server crash and restart**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start a server | Server running |
| 2 | Kill the server process manually | Crash detected |
| 3 | Wait | Automatic restart attempted |
| 4 | Repeat 3x | After 3 failures, server marked as failed |

---

#### B. Permission System

**B1. First-time permission prompt**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Visit a web page (e.g., example.com) | Page loads normally |
| 2 | Page calls `window.ai.tools.list()` | Permission prompt appears |
| 3 | Click "Allow Once" | Tools list returned, permission granted |
| 4 | Page calls again | No prompt (already granted) |
| 5 | Close tab | Permission expired |
| 6 | Reopen page, call again | Permission prompt appears again |

**B2. Persistent permission**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Page calls `window.ai.tools.list()` | Permission prompt appears |
| 2 | Click "Always Allow" | Permission granted |
| 3 | Restart Firefox | Extension reloads |
| 4 | Revisit page, call again | No prompt, tools returned |

**B3. Permission denial**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Page calls `window.ai.tools.list()` | Permission prompt appears |
| 2 | Click "Deny" | ERR_PERMISSION_DENIED returned |
| 3 | Page calls again | Same error (no repeated prompts) |

**B4. Tool allowlist**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Grant permission with allowlist | Only specific tools allowed |
| 2 | Page calls allowed tool | Success |
| 3 | Page calls non-allowed tool | ERR_TOOL_NOT_ALLOWED |

---

#### C. Tool Invocation

**C1. Successful tool call**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start filesystem server | Server running |
| 2 | Grant permissions | TOOLS_CALL granted |
| 3 | Call `filesystem/read_file` with valid path | File contents returned |
| 4 | Check provenance | Contains serverId and toolName |

**C2. Tool not found**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Call `nonexistent/tool` | ERR_TOOL_NOT_FOUND |

**C3. Server unavailable**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Stop filesystem server | Server stopped |
| 2 | Call `filesystem/read_file` | ERR_SERVER_UNAVAILABLE |

**C4. Tool timeout**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Call a slow/hanging tool | Timeout after 30s |
| 2 | Check error | ERR_TOOL_TIMEOUT |

---

#### D. Rate Limiting

**D1. Concurrent limit**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start 3 tool calls simultaneously | First 2 proceed |
| 2 | Check 3rd call | ERR_RATE_LIMITED |
| 3 | Wait for 1st to complete | 3rd call proceeds |

**D2. Budget limit**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Create agent run with budget 3 | Run created |
| 2 | Make 3 tool calls | All succeed |
| 3 | Make 4th call | ERR_BUDGET_EXCEEDED |

---

#### E. Observability

**E1. Metrics not exposing payloads**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Make tool call with sensitive args | Call succeeds |
| 2 | Check bridge logs | No args or results in logs |
| 3 | Check metrics | Only tool name, duration, success/fail |

**E2. Server health tracking**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start server | Health shows "running" |
| 2 | Stop server | Health shows "stopped" |
| 3 | Crash server | Health shows "crashed" |
| 4 | Restart succeeds | Health shows "running", restartCount=1 |

---

#### F. VS Code Button Detection

**F1. Detect install button on MCP server page**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Visit MCP server documentation | Page loads |
| 2 | Find "Install in VS Code" button | Harbor button appears next to it |
| 3 | Click Harbor button | Installation initiated |

---

#### G. JSON Configuration Import

**G1. Import Claude Desktop config**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Click "Import JSON" | Modal/dialog appears |
| 2 | Paste Claude Desktop config | Config parsed |
| 3 | Click Import | Servers added to "My Servers" |

**G2. Import with environment variables**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Import config with env vars | Config parsed |
| 2 | Check server config | Env vars stored (values hidden) |
| 3 | Start server | Env vars injected correctly |

---

### Bug Report Template

When filing bugs, include:

```markdown
## Environment
- Firefox version: 
- Extension version:
- OS: macOS/Linux/Windows
- Node.js version:

## Steps to Reproduce
1. 
2. 
3. 

## Expected Behavior


## Actual Behavior


## Logs
<!-- Include relevant console/bridge logs -->

## Screenshots
<!-- If applicable -->
```

---

## Test Data & Fixtures

### Test MCP Servers

Install these for testing:

```bash
# npm servers
npm install -g @modelcontextprotocol/server-filesystem
npm install -g @modelcontextprotocol/server-memory

# Python servers (via uvx)
uvx mcp-server-time
```

### Test Configurations

**Claude Desktop Format:**
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

**Cursor Format:**
```json
{
  "mcp": {
    "servers": {
      "memory": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-memory"]
      }
    }
  }
}
```

---

## Test Environment Setup

### Developer Setup

```bash
# Clone and setup
git clone --recurse-submodules https://github.com/r/Harbor.git
cd harbor

# Build the Rust bridge
cd bridge-rs && cargo build --release && cd ..

# Build the extension
cd extension && npm install && npm run build && cd ..

# Install native messaging manifest
cd bridge-rs && ./install.sh && cd ..
```

### CI/CD Setup

```yaml
# Example GitHub Actions workflow
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
      
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - uses: dtolnay/rust-toolchain@stable
      
      - name: Run Rust tests
        run: |
          cd bridge-rs
          cargo test
      
      - name: Run extension tests
        run: |
          cd extension
          npm install
          npm test
```

---

## Acceptance Criteria Checklist

Before release, verify:

### Server Lifecycle
- [ ] Starting Host spawns configured servers
- [ ] Server crash triggers restart (up to 3 attempts)
- [ ] Server stop cleans up processes
- [ ] Server status accurately reported

### Tool Discovery
- [ ] Tools listed from all connected servers
- [ ] Tool names namespaced as serverId/toolName
- [ ] Tool metadata (description, schema) preserved

### Permission Gating
- [ ] No permission → ERR_SCOPE_REQUIRED
- [ ] DENY → ERR_PERMISSION_DENIED
- [ ] ALLOW_ONCE expires on TTL/tab close
- [ ] ALLOW_ALWAYS persists across restarts

### Tool Call Correctness
- [ ] Known tool call succeeds
- [ ] Unknown tool → ERR_TOOL_NOT_FOUND
- [ ] Timeout → ERR_TOOL_TIMEOUT
- [ ] Server down → ERR_SERVER_UNAVAILABLE
- [ ] Not in allowlist → ERR_TOOL_NOT_ALLOWED

### Rate Limiting
- [ ] Concurrent limit enforced
- [ ] Budget limit enforced
- [ ] Blocked calls return ERR_RATE_LIMITED

### Observability
- [ ] Metrics logged without payloads
- [ ] Tool call duration tracked
- [ ] Server health reported
- [ ] Debug mode toggleable

---

## Appendix: Error Codes Reference

| Code | When Returned |
|------|---------------|
| `ERR_PERMISSION_DENIED` | DENY grant or missing scope |
| `ERR_SCOPE_REQUIRED` | No grant for required scope |
| `ERR_SERVER_UNAVAILABLE` | Server not connected |
| `ERR_TOOL_NOT_FOUND` | Unknown tool name |
| `ERR_TOOL_NOT_ALLOWED` | Tool not in allowlist |
| `ERR_TOOL_TIMEOUT` | Tool call exceeded timeout |
| `ERR_TOOL_FAILED` | Tool returned error |
| `ERR_PROTOCOL_ERROR` | MCP protocol error |
| `ERR_INTERNAL` | Unexpected host error |
| `ERR_RATE_LIMITED` | Concurrent limit exceeded |
| `ERR_BUDGET_EXCEEDED` | Run budget exhausted |


