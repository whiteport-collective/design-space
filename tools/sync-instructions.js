#!/usr/bin/env node
/**
 * Sync agent instructions from WDS repo to Design Space.
 *
 * Reads agent definitions, activation files, and skill files
 * and stores them in Design Space as category: "agent_instruction".
 *
 * Usage:
 *   node sync-instructions.js                    # sync all
 *   node sync-instructions.js --agent saga       # sync one agent
 *   node sync-instructions.js --dry-run          # preview only
 *
 * Run this after pushing changes to the WDS repo.
 * In the future: GitHub webhook triggers this automatically.
 */

import { readFileSync, existsSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config ---
const WDS_ROOT = process.env.WDS_ROOT || 'c:/dev/WDS/whiteport-design-studio';
const DS_URL = process.env.DESIGN_SPACE_URL || 'https://uztngidbpduyodrabokm.supabase.co';
const DS_KEY = process.env.DESIGN_SPACE_ANON_KEY || '';

// Load .env from design-space repo
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.replace(/\r/g, '').split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      if (!process.env[key]) process.env[key] = match[2].trim();
    }
  }
}

const SUPABASE_URL = process.env.DESIGN_SPACE_URL || DS_URL;
const SUPABASE_KEY = process.env.DESIGN_SPACE_ANON_KEY || DS_KEY;

const DRY_RUN = process.argv.includes('--dry-run');
const AGENT_FILTER = (() => {
  const idx = process.argv.indexOf('--agent');
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

// --- Instruction map ---
const instructions = [];

function addInstruction(agent, type, name, filePath, layer = 'framework') {
  if (AGENT_FILTER && agent !== AGENT_FILTER && agent !== '*') return;
  if (!existsSync(filePath)) {
    console.warn(`  SKIP (not found): ${filePath}`);
    return;
  }
  const content = readFileSync(filePath, 'utf8');
  const hash = createHash('sha256').update(content).digest('hex').substring(0, 12);

  instructions.push({
    agent,
    type,
    name,
    filePath: filePath.replace(/\\/g, '/'),
    content,
    hash,
    layer,
  });
}

// --- Collect instructions ---
console.log(`Scanning WDS repo: ${WDS_ROOT}`);
console.log();

// Agent YAML definitions
addInstruction('saga', 'persona', 'saga-analyst.agent.yaml',
  join(WDS_ROOT, 'src/agents/saga-analyst.agent.yaml'));
addInstruction('freya', 'persona', 'freya-ux.agent.yaml',
  join(WDS_ROOT, 'src/agents/freya-ux.agent.yaml'));

// Activation files
addInstruction('saga', 'activation', 'saga.activation.md',
  join(WDS_ROOT, 'src/skills/saga.activation.md'));
addInstruction('freya', 'activation', 'freya.activation.md',
  join(WDS_ROOT, 'src/skills/freya.activation.md'));

// Skill definitions
addInstruction('saga', 'skill', 'saga-skill.md',
  join(WDS_ROOT, 'src/skills/saga/SKILL.md'));
addInstruction('freya', 'skill', 'freya-skill.md',
  join(WDS_ROOT, 'src/skills/freya/SKILL.md'));
addInstruction('*', 'skill', 'design-space-skill.md',
  join(WDS_ROOT, 'src/skills/design-space/SKILL.md'));

// Saga references
const sagaRefs = [
  'discovery-conversation.md', 'trigger-mapping.md', 'dream-up-approach.md',
  'strategic-documentation.md', 'conversational-followups.md', 'seo-strategy-guide.md',
  'content-structure-principles.md', 'inspiration-analysis.md', 'working-with-existing-materials.md',
];
for (const ref of sagaRefs) {
  addInstruction('saga', 'reference', ref,
    join(WDS_ROOT, 'src/skills/saga/references', ref));
}

// Freya references
const freyaRefs = [
  'strategic-design.md', 'specification-quality.md', 'agentic-development.md',
  'content-creation.md', 'design-system.md', 'meta-content-guide.md',
];
for (const ref of freyaRefs) {
  addInstruction('freya', 'reference', ref,
    join(WDS_ROOT, 'src/skills/freya/references', ref));
}

// Workflow master files (just the workflow.md orchestrators, not all steps)
const workflows = [
  { phase: '0', name: 'alignment-signoff', file: '0-alignment-signoff/workflow.md', agent: 'saga' },
  { phase: '0', name: 'project-setup', file: '0-project-setup/workflow.md', agent: '*' },
  { phase: '1', name: 'project-brief', file: '1-project-brief/workflow.md', agent: 'saga' },
  { phase: '2', name: 'trigger-mapping', file: '2-trigger-mapping/workflow.md', agent: 'saga' },
  { phase: '3', name: 'scenarios', file: '3-scenarios/workflow.md', agent: 'freya' },
  { phase: '4', name: 'ux-design', file: '4-ux-design/workflow.md', agent: 'freya' },
  { phase: '5', name: 'agentic-development', file: '5-agentic-development/workflow.md', agent: 'mimir' },
  { phase: '6', name: 'asset-generation', file: '6-asset-generation/workflow.md', agent: 'freya' },
  { phase: '7', name: 'design-system', file: '7-design-system/workflow.md', agent: 'freya' },
  { phase: '8', name: 'product-evolution', file: '8-product-evolution/workflow.md', agent: 'idunn' },
];
for (const wf of workflows) {
  addInstruction(wf.agent, 'workflow', `workflow-${wf.name}.md`,
    join(WDS_ROOT, 'src/workflows', wf.file));
}

// --- Summary ---
console.log(`Found ${instructions.length} instruction files:`);
const byAgent = {};
for (const i of instructions) {
  byAgent[i.agent] = (byAgent[i.agent] || 0) + 1;
}
for (const [agent, count] of Object.entries(byAgent)) {
  console.log(`  ${agent}: ${count} files`);
}
console.log();

if (DRY_RUN) {
  console.log('DRY RUN — not uploading. Files:');
  for (const i of instructions) {
    console.log(`  [${i.agent}] ${i.type}/${i.name} (${i.content.length} chars, hash: ${i.hash})`);
  }
  process.exit(0);
}

// --- Upload to Design Space ---
console.log('Uploading to Design Space...');

let uploaded = 0;
let skipped = 0;
let failed = 0;

for (const instr of instructions) {
  try {
    // Check if this version already exists
    const searchRes = await fetch(`${SUPABASE_URL}/functions/v1/search-design-space`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `agent_instruction ${instr.agent} ${instr.name}`,
        category: 'agent_instruction',
        limit: 1,
      }),
    });
    const searchData = await searchRes.json();
    const existing = searchData.results?.[0];

    // Skip if same hash (content unchanged)
    if (existing?.metadata?.hash === instr.hash) {
      skipped++;
      continue;
    }

    // Delete old version if exists
    // (We can't delete via the API, so we'll just insert — duplicates get filtered by hash on read)

    // Upload
    const res = await fetch(`${SUPABASE_URL}/functions/v1/capture-design-space`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: instr.content,
        category: 'agent_instruction',
        project: 'wds',
        designer: instr.agent,
        topics: [instr.type, instr.agent, 'wds-1.0'],
        components: [instr.name],
        source: 'sync-instructions',
        source_file: instr.filePath,
        metadata: {
          agent: instr.agent,
          type: instr.type,
          name: instr.name,
          layer: instr.layer,
          hash: instr.hash,
        },
      }),
    });

    if (res.ok) {
      uploaded++;
      console.log(`  ✓ [${instr.agent}] ${instr.type}/${instr.name}`);
    } else {
      failed++;
      const err = await res.text();
      console.error(`  ✗ [${instr.agent}] ${instr.type}/${instr.name}: ${err}`);
    }
  } catch (err) {
    failed++;
    console.error(`  ✗ [${instr.agent}] ${instr.type}/${instr.name}: ${err.message}`);
  }
}

console.log();
console.log(`Done: ${uploaded} uploaded, ${skipped} unchanged, ${failed} failed`);
