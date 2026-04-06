# MCP Proxy For Agent Space

This folder now contains the Phase 1 MCP proxy pattern for Agent Space. It replaces the old habit of booting several MCP servers and paying the manifest cost up front on every session.

## What This Replaces

The old setup loaded every manifest at boot: Google Workspace, browser tools, Supabase, Fireflies, and other integrations. That burns roughly 27k tokens before the agent does useful work.

The proxy split keeps the boot manifest small and only loads capability code when the agent actually needs it.

## Two-MCP Split

- `agent-space-mcp/`
  Cloud-side MCP with a minimal manifest:
  `agent_space_list_plugins`, `agent_space_get_plugin`, `agent_space_check_messages`, `agent_space_post_message`, `agent_space_update_status`
- `local-mcp/`
  Machine-side MCP with one meta-tool:
  `load_plugin`

Cloud integrations stay in Agent Space. Machine-bound integrations stay local.

## Lazy Loading Flow

1. Call `agent_space_list_plugins` to see what the org is authorized to use.
2. Call `agent_space_get_plugin` for a specific plugin.
3. Pass the returned `code` into `local-mcp.load_plugin`.
4. `local-mcp` writes the module into `local-mcp/tools/_loaded_<name>.js`, imports it, and registers its exported tools at runtime.

If a tool is never needed, it is never loaded and never appears in the session manifest.

## Files

```text
mcp-server/
  agent-space-mcp/
    index.js
    package.json
  local-mcp/
    index.js
    tools/.gitkeep
  plugins/
    fireflies-stub.js
    google-workspace-stub.js
    github-stub.js
  settings-template.json
```

`index.js` at the root is left intact for the legacy single-server flow.

## Install

1. Copy `agent-space-mcp/`, `local-mcp/`, `plugins/`, and `settings-template.json` into `~/.claude/`.
2. Replace the placeholder URL/key values in your settings.
3. Make sure the copied location can resolve these Node dependencies:
   `@modelcontextprotocol/sdk`, `@supabase/supabase-js`, `zod`

Example layout:

```text
~/.claude/
  agent-space-mcp/
    index.js
    package.json
  local-mcp/
    index.js
    tools/
  plugins/
    fireflies-stub.js
    google-workspace-stub.js
    github-stub.js
  settings.json
```

## Settings

`settings-template.json` shows the intended shape. The pattern is always two entries:

- `agent-space` for cloud services and Agent Space state
- `local-mcp` for localhost-only tools and runtime plugin injection

## Plugin Stubs

Phase 1 ships three stub plugins:

- `fireflies`
  Returns recent meeting transcripts from cached `agent_space` rows
- `google_workspace`
  Returns cached calendar/email rows when sync exists, otherwise tells the agent to ask Idun
- `github`
  Returns cached pull request rows when sync exists, otherwise tells the agent to ask Idun

These stubs are what `agent_space_get_plugin` returns today. Later phases can replace them with full capability modules without changing the two-MCP contract.
