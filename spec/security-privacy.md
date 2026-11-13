# Security and Privacy Considerations

This document describes the security and privacy aspects of the Web Agent API specification.

---

## Table of Contents

1. [Threat Model](#threat-model)
2. [Permission System](#permission-system)
3. [Origin Isolation](#origin-isolation)
4. [Tool Security](#tool-security)
5. [Data Flow](#data-flow)
6. [Privacy Considerations](#privacy-considerations)
7. [Mitigations](#mitigations)

---

## Threat Model

### Adversaries

| Adversary | Goal | Capability |
|-----------|------|------------|
| **Malicious Website** | Abuse AI resources, exfiltrate data | JavaScript execution in browser |
| **Compromised MCP Server** | Execute unauthorized actions | Process execution on user machine |
| **Man-in-the-Middle** | Intercept AI responses | Network access (if using cloud providers) |

### Assets Protected

| Asset | Protection Mechanism |
|-------|---------------------|
| User consent | Explicit permission prompts |
| User data (browsing) | Origin isolation, permission gates |
| AI resources | Rate limiting, budget controls |
| Tool access | Allowlisting, per-call validation |
| Credentials | Encrypted storage, restricted file permissions |

---

## Permission System

### Principle of Least Privilege

Each permission scope grants the minimum access needed:

| Scope | Access Level | Justification |
|-------|-------------|---------------|
| `model:prompt` | Text generation only | No tool execution, no browser access |
| `model:tools` | AI decides tool usage | User controls which tools via `mcp:tools.call` |
| `model:list` | Read-only metadata | No execution capability |
| `mcp:tools.list` | Read-only metadata | Discovery without execution |
| `mcp:tools.call` | Execute specific tools | Subject to allowlist |
| `browser:activeTab.read` | Read current tab | No modification, no other tabs |

### Permission Persistence

| Grant Type | Storage | Duration | Use Case |
|------------|---------|----------|----------|
| `granted-always` | Persistent | Until revoked | Trusted apps |
| `granted-once` | Memory | 10 min or tab close | One-time use |
| `denied` | Persistent | Until cleared | Block unwanted access |

### Denial Behavior

When a user denies a permission:
- The decision is persisted
- The origin will NOT be re-prompted automatically
- User must manually clear the denial to re-request

This prevents permission fatigue attacks where malicious sites repeatedly prompt users.

---

## Origin Isolation

### Per-Origin State

Each origin has completely isolated:
- Permission grants
- Tool allowlists
- Session state
- Rate limit budgets

```
https://trusted-app.com     https://untrusted-site.com
        │                            │
        ▼                            ▼
┌─────────────────┐          ┌─────────────────┐
│ Permissions:    │          │ Permissions:    │
│  model:prompt ✓ │          │  (none)         │
│  mcp:tools.call ✓│         │                 │
│                 │          │                 │
│ Allowed Tools:  │          │ Allowed Tools:  │
│  memory/*       │          │  (none)         │
│  github/*       │          │                 │
└─────────────────┘          └─────────────────┘
        │                            │
        │ Can use AI + tools         │ Cannot access any APIs
        ▼                            ▼
```

### Session Isolation

Text sessions are bound to their creating origin:
- Session IDs are opaque tokens
- Requests include origin verification
- Cross-origin session access returns `ERR_PERMISSION_DENIED`

---

## Tool Security

### Tool Namespacing

All tools are namespaced by server ID to prevent collisions and enable fine-grained control:

```
{serverId}/{toolName}

Examples:
  filesystem/read_file
  github/create_issue
  memory-server/save_memory
```

### Tool Allowlisting

Users can restrict which tools each origin may call:

```
┌─────────────────────────────────────────────────────────┐
│  Permission Request: mcp:tools.call                      │
│                                                          │
│  https://example.com wants to execute tools:             │
│                                                          │
│  ☑ memory-server/save_memory                            │
│  ☑ memory-server/search_memories                        │
│  ☐ filesystem/read_file                                 │
│  ☐ filesystem/write_file                                │
│  ☐ github/create_issue                                  │
│                                                          │
│  [Select All] [Select None]                              │
│                                                          │
│  [Allow Always] [Allow Once] [Deny]                      │
└─────────────────────────────────────────────────────────┘
```

### Per-Call Validation

Every tool call is validated:

```
tool.call("filesystem/read_file", {...})
        │
        ▼
┌─────────────────────────────┐
│ 1. Check mcp:tools.call     │──▶ ERR_SCOPE_REQUIRED
│    permission               │
└─────────────────────────────┘
        │ ✓
        ▼
┌─────────────────────────────┐
│ 2. Check tool in allowlist  │──▶ ERR_TOOL_NOT_ALLOWED
└─────────────────────────────┘
        │ ✓
        ▼
┌─────────────────────────────┐
│ 3. Check rate limits        │──▶ ERR_RATE_LIMITED
└─────────────────────────────┘
        │ ✓
        ▼
    Execute tool
```

---

## Data Flow

### Local-First Architecture

Implementations SHOULD support local AI backends:

```
┌──────────────┐                    ┌──────────────┐
│   Web Page   │                    │   Ollama     │
│              │   All data stays   │   (local)    │
│  prompt()    │─────────────────▶  │              │
│              │   on the machine   │   LLM        │
└──────────────┘                    └──────────────┘
```

### Cloud Provider Path

When using cloud providers (OpenAI, Anthropic), data leaves the machine:

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│   Web Page   │───▶│    Bridge    │───▶│   OpenAI     │
│              │    │              │    │   (cloud)    │
└──────────────┘    └──────────────┘    └──────────────┘
                           │
                           │ User-configured
                           │ API keys
                           ▼
                    User is responsible
                    for provider's privacy policy
```

### Logging Policy

Implementations SHOULD NOT log:
- Prompt content
- AI responses
- Tool arguments
- Tool results
- Page content from `activeTab.readability()`

Implementations MAY log metadata for debugging:
- Tool names (not arguments)
- Error codes (not details)
- Timing information

---

## Privacy Considerations

### Data Retained

| Data | Location | Duration | Purpose |
|------|----------|----------|---------|
| Permission grants | Extension storage | Until revoked | Remember user choices |
| Tool allowlists | Extension storage | Until revoked | Access control |
| Server configs | Local filesystem | Until removed | MCP server management |

### Data NOT Retained

| Data | Reason |
|------|--------|
| Prompts | Privacy - user content |
| AI responses | Privacy - could contain sensitive info |
| Tool call arguments | Privacy - could contain credentials |
| Tool results | Privacy - could contain private data |
| Active tab content | Privacy - user browsing data |
| Conversation history | Privacy - destroyed with session |

### Third-Party Data Sharing

Data is shared with third parties only when:
1. User explicitly chooses a cloud AI provider (OpenAI, Anthropic, etc.)
2. User executes an MCP tool that makes external requests

Users control both of these through:
- Provider selection in settings
- Tool allowlisting per-origin

---

## Mitigations

### Against Prompt Injection

| Attack | Mitigation |
|--------|------------|
| Webpage injects malicious prompts | System prompts are controlled by the app, not the page content |
| Tool results contain instructions | LLM instructed to treat tool results as data, not instructions |
| Cross-session contamination | Sessions are isolated; one session cannot read another's history |

**Recommendation for developers:** Always sanitize user input before including in prompts.

### Against Resource Abuse

| Attack | Mitigation |
|--------|------------|
| Infinite tool loops | `maxToolCalls` limit (default: 5) |
| Denial of service | Rate limiting per origin |
| Concurrent abuse | Max 2 concurrent requests per origin |
| Slow tool calls | 30-second timeout per tool call |

### Against Data Exfiltration

| Attack | Mitigation |
|--------|------------|
| Read arbitrary tabs | `browser:activeTab.read` only reads current tab |
| Read privileged pages | Cannot read `about:`, `chrome:`, extension pages |
| Exfil via tools | Tool allowlisting restricts available exfil channels |
| Exfil via AI response | User sees responses; suspicious activity visible |

### Against Privilege Escalation

| Attack | Mitigation |
|--------|------------|
| Forge origin | Origin attached by extension, not page |
| Forge session ID | Sessions bound to origin, validated on each request |
| Escape allowlist | Tool name validated before every call |
| Bypass permission | Permissions checked at every API boundary |

---

## Security Checklist for Web Developers

When building applications with Harbor APIs:

### ✅ Do

- Request only the permissions you need
- Provide a clear `reason` in permission requests
- Handle permission denials gracefully
- Sanitize user input before including in prompts
- Destroy sessions when done
- Use `AbortSignal` for cancellable operations

### ❌ Don't

- Request all permissions upfront "just in case"
- Include sensitive data in prompts without user awareness
- Store AI responses containing user data
- Assume tool calls will always succeed
- Ignore rate limit errors

---

## Reporting Security Issues

### For the Specification

Report suspected security vulnerabilities in the Web Agent API specification privately to [harbor-sec@mozilla.org](mailto:harbor-sec@mozilla.org). Follow the [security reporting policy](../SECURITY.md) for what to include in your report.

**Do not** open a public GitHub issue for a security vulnerability. Please allow reasonable time for a fix before public disclosure.

### For Implementations

Report implementation-specific vulnerabilities to the relevant implementation maintainers. For Harbor, report privately to [harbor-sec@mozilla.org](mailto:harbor-sec@mozilla.org) using the [security reporting policy](../SECURITY.md).

---

**Author**: Raffi Krikorian

*Last updated: January 2026*

