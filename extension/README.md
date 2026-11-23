# Harbor WASM MCP Extension

This is the new extension skeleton for the WASM-based MCP architecture.

## Notes
- The extension is TypeScript-first, build tooling TBD.
- WASM MCP servers are loaded via WASI + wasmtime (planned).
- Local LLMs and filesystem access are routed through the Rust bridge.
- UI uses `src/design-tokens.css`, which takes its palette and type from the public site (`whitepaper/styles.css`). Change the two together.

## Next Steps
- Add build tooling (Vite or esbuild).
- Implement the Web Agent API's content script injection.
- Implement WASM MCP runtime and server registry.
