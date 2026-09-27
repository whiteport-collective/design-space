-- Migration 024: Seed tool launcher records into design_space
-- Agents fetch these via search-design-space to get on-demand MCP activation instructions.
-- category: "tool_launcher" — one row per local MCP tool.
-- source: tool slug. content: markdown activation instructions.

INSERT INTO public.design_space (category, source, content, metadata)
VALUES
  (
    'tool_launcher',
    'tool-figma',
    E'# Figma MCP Launcher\n\nActivate the Figma local MCP for design file inspection.\n\n## Prerequisites\n- Figma Desktop app must be running\n- Dev Mode MCP plugin must be active in Figma\n\n## Activate\n```powershell\ncd C:\\dev\\WDS\\whiteport-agent-space\\tools\\launchers\n.\\activate.ps1 figma\n```\nThen restart Claude Code.\n\n## Deactivate\n```powershell\n.\\activate.ps1 deactivate figma\n```\n\n## MCP key: `figma`\n## Transport: SSE at http://127.0.0.1:3845/mcp',
    ''{"tool_slug": "tool-figma", "mcp_key": "figma", "type": "local_mcp", "transport": "sse"}''::jsonb
  ),
  (
    'tool_launcher',
    'tool-discord',
    E'# Discord MCP Launcher\n\nActivate the Discord local MCP for messaging.\n\n## Prerequisites\n- Unlock Bitwarden: `bw unlock` then set `$env:BW_SESSION`\n\n## Activate\n```powershell\nbw unlock  # copy the session key\n$env:BW_SESSION = "<session-key>"\ncd C:\\dev\\WDS\\whiteport-agent-space\\tools\\launchers\n.\\activate.ps1 discord\n```\nThen restart Claude Code.\n\n## Deactivate\n```powershell\n.\\activate.ps1 deactivate discord\n```\n\n## MCP key: `discord`',
    '{"tool_slug": "tool-discord", "mcp_key": "discord", "type": "local_mcp"}'::jsonb
  ),
  (
    'tool_launcher',
    'tool-photoshop',
    E'# Photoshop MCP Launcher\n\nActivate the Adobe Photoshop 2025 MCP server.\n\n## Prerequisites\n- Adobe Photoshop 2025 must be running\n\n## Activate\n```powershell\ncd C:\\dev\\WDS\\whiteport-agent-space\\tools\\launchers\n.\\activate.ps1 photoshop\n```\nThen restart Claude Code.\n\n## Deactivate\n```powershell\n.\\activate.ps1 deactivate photoshop\n```\n\n## MCP key: `photoshop`',
    '{"tool_slug": "tool-photoshop", "mcp_key": "photoshop", "type": "local_mcp"}'::jsonb
  ),
  (
    'tool_launcher',
    'tool-illustrator',
    E'# Illustrator MCP Launcher\n\nActivate the Adobe Illustrator MCP server.\n\n## Prerequisites\n- Adobe Illustrator must be running\n- Python installed\n\n## Activate\n```powershell\ncd C:\\dev\\WDS\\whiteport-agent-space\\tools\\launchers\n.\\activate.ps1 illustrator\n```\nThen restart Claude Code.\n\n## Deactivate\n```powershell\n.\\activate.ps1 deactivate illustrator\n```\n\n## MCP key: `illustrator`',
    '{"tool_slug": "tool-illustrator", "mcp_key": "illustrator", "type": "local_mcp"}'::jsonb
  ),
  (
    'tool_launcher',
    'tool-premiere',
    E'# Premiere Pro MCP Launcher\n\nActivate the Adobe Premiere Pro MCP server.\n\n## Prerequisites\n- Adobe Premiere Pro must be running\n\n## Activate\n```powershell\ncd C:\\dev\\WDS\\whiteport-agent-space\\tools\\launchers\n.\\activate.ps1 premiere\n```\nThen restart Claude Code.\n\n## Deactivate\n```powershell\n.\\activate.ps1 deactivate premiere\n```\n\n## MCP key: `premiere`',
    '{"tool_slug": "tool-premiere", "mcp_key": "premiere", "type": "local_mcp"}'::jsonb
  ),
  (
    'tool_launcher',
    'tool-stitch',
    E'# Stitch MCP Launcher\n\nActivate Stitch — takes WDS specs + design system and generates designed views.\n\n## Prerequisites\n- STITCH_API_KEY from Bitwarden\n\n## Activate\n```powershell\n$env:STITCH_API_KEY = (bw get password "Stitch API Key")\ncd C:\\dev\\WDS\\whiteport-agent-space\\tools\\launchers\n.\\activate.ps1 stitch\n```\nThen restart Claude Code.\n\n## Deactivate\n```powershell\n.\\activate.ps1 deactivate stitch\n```\n\n## MCP key: `stitch`',
    '{"tool_slug": "tool-stitch", "mcp_key": "stitch", "type": "local_mcp"}'::jsonb
  ),
  (
    'tool_launcher',
    'tool-bitwarden',
    E'# Bitwarden MCP Launcher\n\nActivate the Bitwarden password manager MCP.\n\n## Prerequisites\n- Run `bw unlock` to get BW_SESSION\n\n## Activate\n```powershell\nbw unlock  # copy the session key\n$env:BW_SESSION = "<session-key>"\ncd C:\\dev\\WDS\\whiteport-agent-space\\tools\\launchers\n.\\activate.ps1 bitwarden\n```\nThen restart Claude Code.\n\n## Deactivate\n```powershell\n.\\activate.ps1 deactivate bitwarden\n```\n\n## MCP key: `bitwarden`',
    '{"tool_slug": "tool-bitwarden", "mcp_key": "bitwarden", "type": "local_mcp"}'::jsonb
  ),
  (
    'tool_launcher',
    'tool-google-workspace',
    E'# Google Workspace MCP Launcher\n\nActivate the Google Workspace MCP (Docs, Drive, Sheets, Gmail, Calendar).\n\n## Prerequisites\n- OAuth tokens must be configured (first run completes OAuth flow)\n\n## Activate\n```powershell\ncd C:\\dev\\WDS\\whiteport-agent-space\\tools\\launchers\n.\\activate.ps1 google-workspace\n```\nThen restart Claude Code.\n\n## Deactivate\n```powershell\n.\\activate.ps1 deactivate google-workspace\n```\n\n## MCP key: `google-workspace`',
    '{"tool_slug": "tool-google-workspace", "mcp_key": "google-workspace", "type": "local_mcp"}'::jsonb
  )
ON CONFLICT DO NOTHING;
