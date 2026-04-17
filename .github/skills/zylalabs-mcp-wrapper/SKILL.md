---
name: zylalabs-mcp-wrapper
description: Wrap and use the ZylaLabs MCP server for external tool calls.
---

# ZylaLabs MCP wrapper skill

Use this skill when a task requires tools exposed by the configured ZylaLabs MCP server.

Wrapped MCP endpoint:

- `https://mcp.zylalabs.com/mcp?apikey=${COPILOT_MCP_ZYLALABS_API_KEY}`

This wraps the same server URL provided by the user, but keeps the API key in a secret instead of hardcoding it.

## Behavior

1. Prefer tools from the MCP server named `zylalabs`.
2. Use only the minimum required tools for the current request.
3. Return concise results and include relevant MCP errors.
4. If the MCP server is unavailable, report configuration is required.

## Required MCP server name

This skill expects an MCP server named:

- `zylalabs`

## Expected setup

Configure MCP with [zylalabs-mcp-config.json](../../../zylalabs-mcp-config.json) and set the API key as a secret/environment variable:

- `COPILOT_MCP_ZYLALABS_API_KEY`

If the API key contains special URL characters (for example `|`), store it URL-encoded in the secret value.
