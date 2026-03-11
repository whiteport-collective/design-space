#!/bin/bash
# Design Space Infrastructure — One-command Supabase deployment
# Usage: ./setup.sh
#
# Prerequisites:
#   - Supabase CLI installed (npm i -g supabase)
#   - Supabase project created at https://supabase.com
#   - Logged in: supabase login

set -e

# Check for Supabase CLI
if ! command -v supabase &> /dev/null; then
  echo "Supabase CLI not found. Install with: npm i -g supabase"
  exit 1
fi

# Get project ref
if [ -z "$1" ]; then
  echo "Usage: ./setup.sh <project-ref>"
  echo ""
  echo "Your project ref is in your Supabase dashboard URL:"
  echo "  https://supabase.com/dashboard/project/<project-ref>"
  exit 1
fi

PROJECT_REF=$1

echo "=== Design Space Infrastructure Setup ==="
echo "Project: $PROJECT_REF"
echo ""

# Link to project
echo "1/3 Linking to Supabase project..."
supabase link --project-ref "$PROJECT_REF"

# Run migrations
echo "2/3 Running database migrations..."
for migration in supabase/migrations/*.sql; do
  echo "  Applying: $(basename "$migration")"
  supabase db push --file "$migration"
done

# Deploy edge functions
echo "3/3 Deploying edge functions..."
for func_dir in supabase/functions/*/; do
  func_name=$(basename "$func_dir")
  echo "  Deploying: $func_name"
  supabase functions deploy "$func_name" --project-ref "$PROJECT_REF"
done

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Your Design Space is ready at:"
echo "  https://$PROJECT_REF.supabase.co"
echo ""
echo "Next steps:"
echo "  1. Set Edge Function secrets in the Supabase dashboard:"
echo "     - OPENROUTER_API_KEY (for semantic embeddings)"
echo "     - VOYAGE_API_KEY (for visual embeddings, optional)"
echo ""
echo "  2. Get your anon key from:"
echo "     https://supabase.com/dashboard/project/$PROJECT_REF/settings/api"
echo ""
echo "  3. Configure your MCP server or HTTP client with:"
echo "     DESIGN_SPACE_URL=https://$PROJECT_REF.supabase.co"
echo "     DESIGN_SPACE_ANON_KEY=<your-anon-key>"
