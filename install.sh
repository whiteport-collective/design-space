#!/bin/bash
# Design Space — Alpha Installer
# Installs Design Space + WDS agent instructions in one command.
#
# Usage:
#   ./install.sh                 Install into current directory
#   ./install.sh /path/to/dir    Install into specified directory

set -e

DESIGN_SPACE_REPO="https://github.com/whiteport-collective/design-space.git"
WDS_REPO="https://github.com/whiteport-collective/whiteport-design-studio.git"
WDS_BRANCH="feature/design-space-agent-messaging"

TARGET="${1:-.}"

echo ""
echo "=== Design Space Alpha Installer ==="
echo ""

# ── 1. Clone design-space ──────────────────────────────────────────────────
if [ -d "$TARGET/design-space/.git" ]; then
  echo "✓ design-space already cloned — pulling latest..."
  git -C "$TARGET/design-space" pull --ff-only
else
  echo "→ Cloning design-space..."
  git clone "$DESIGN_SPACE_REPO" "$TARGET/design-space"
fi

# ── 2. Clone WDS design-space branch ──────────────────────────────────────
if [ -d "$TARGET/whiteport-design-studio/.git" ]; then
  echo "✓ whiteport-design-studio already cloned — pulling latest..."
  git -C "$TARGET/whiteport-design-studio" pull --ff-only
else
  echo "→ Cloning WDS ($WDS_BRANCH branch)..."
  git clone -b "$WDS_BRANCH" "$WDS_REPO" "$TARGET/whiteport-design-studio"
fi

# ── 3. Install MCP server ──────────────────────────────────────────────────
if command -v node &> /dev/null; then
  echo "→ Installing MCP server dependencies..."
  npm install --prefix "$TARGET/design-space/mcp-server" --silent
  echo "✓ MCP server ready"
else
  echo "⚠ Node.js not found — skipping MCP server install."
  echo "  Install Node.js and run: npm install --prefix design-space/mcp-server"
fi

# ── 4. Copy .env template ──────────────────────────────────────────────────
if [ ! -f "$TARGET/design-space/.env" ]; then
  cp "$TARGET/design-space/mcp-server/.env.example" "$TARGET/design-space/.env" 2>/dev/null || \
  cat > "$TARGET/design-space/.env" <<'EOF'
DESIGN_SPACE_URL=https://YOUR-PROJECT-REF.supabase.co
DESIGN_SPACE_ANON_KEY=your-anon-key-here
EOF
  echo "✓ .env template created at design-space/.env"
fi

# ── Done ───────────────────────────────────────────────────────────────────
echo ""
echo "=== Installation complete ==="
echo ""
echo "Installed:"
echo "  design-space/              Backend, MCP server, hooks"
echo "  whiteport-design-studio/   Agent instructions, guides, WDS methodology"
echo ""
echo "Next: Set up your database"
echo ""
echo "  Open Claude Code (or any AI agent with Supabase MCP) and paste:"
echo "  design-space/setup/database-agent-prompt.md"
echo ""
echo "  Then fill in design-space/.env with your credentials."
echo ""
