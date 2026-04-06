#!/usr/bin/env node
/**
 * Compile WDS default instructions and sync them to Agent Space.
 *
 * Output model:
 * - one row per agent/model/skill_level in `agent_instructions`
 * - skill_level is `wds_default`
 * - shared instructions use agent_id = "*"
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const WDS_ROOT = process.env.WDS_ROOT || 'c:/dev/WDS/whiteport-design-studio';
const DS_URL = process.env.DESIGN_SPACE_URL || 'https://uztngidbpduyodrabokm.supabase.co';
const DS_KEY = process.env.DESIGN_SPACE_ANON_KEY || '';
const MODEL_TARGET = process.env.AGENT_MODEL_TARGET || 'claude';

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

const collected = [];

function addInstruction(agent, type, name, filePath) {
  if (AGENT_FILTER && agent !== AGENT_FILTER && agent !== '*') return;
  if (!existsSync(filePath)) {
    console.warn(`  SKIP (not found): ${filePath}`);
    return;
  }
  collected.push({
    agent,
    type,
    name,
    filePath: filePath.replace(/\\/g, '/'),
    content: readFileSync(filePath, 'utf8').trim(),
  });
}

console.log(`Scanning WDS repo: ${WDS_ROOT}`);
console.log();

addInstruction('saga', 'persona', 'saga-analyst.agent.yaml', join(WDS_ROOT, 'src/agents/saga-analyst.agent.yaml'));
addInstruction('freya', 'persona', 'freya-ux.agent.yaml', join(WDS_ROOT, 'src/agents/freya-ux.agent.yaml'));
addInstruction('saga', 'activation', 'saga.activation.md', join(WDS_ROOT, 'src/skills/saga.activation.md'));
addInstruction('freya', 'activation', 'freya.activation.md', join(WDS_ROOT, 'src/skills/freya.activation.md'));
addInstruction('saga', 'skill', 'saga-skill.md', join(WDS_ROOT, 'src/skills/saga/SKILL.md'));
addInstruction('freya', 'skill', 'freya-skill.md', join(WDS_ROOT, 'src/skills/freya/SKILL.md'));
addInstruction('*', 'skill', 'design-space-skill.md', join(WDS_ROOT, 'src/skills/design-space/SKILL.md'));

const sagaRefs = [
  'discovery-conversation.md', 'trigger-mapping.md', 'dream-up-approach.md',
  'strategic-documentation.md', 'conversational-followups.md', 'seo-strategy-guide.md',
  'content-structure-principles.md', 'inspiration-analysis.md', 'working-with-existing-materials.md',
];
for (const ref of sagaRefs) {
  addInstruction('saga', 'reference', ref, join(WDS_ROOT, 'src/skills/saga/references', ref));
}

const freyaRefs = [
  'strategic-design.md', 'specification-quality.md', 'agentic-development.md',
  'content-creation.md', 'design-system.md', 'meta-content-guide.md',
];
for (const ref of freyaRefs) {
  addInstruction('freya', 'reference', ref, join(WDS_ROOT, 'src/skills/freya/references', ref));
}

const workflows = [
  { name: 'alignment-signoff', file: '0-alignment-signoff/workflow.md', agent: 'saga' },
  { name: 'project-setup', file: '0-project-setup/workflow.md', agent: '*' },
  { name: 'project-brief', file: '1-project-brief/workflow.md', agent: 'saga' },
  { name: 'trigger-mapping', file: '2-trigger-mapping/workflow.md', agent: 'saga' },
  { name: 'scenarios', file: '3-scenarios/workflow.md', agent: 'freya' },
  { name: 'ux-design', file: '4-ux-design/workflow.md', agent: 'freya' },
  { name: 'agentic-development', file: '5-agentic-development/workflow.md', agent: 'mimir' },
  { name: 'asset-generation', file: '6-asset-generation/workflow.md', agent: 'freya' },
  { name: 'design-system', file: '7-design-system/workflow.md', agent: 'freya' },
  { name: 'product-evolution', file: '8-product-evolution/workflow.md', agent: 'idunn' },
];
for (const wf of workflows) {
  addInstruction(wf.agent, 'workflow', `workflow-${wf.name}.md`, join(WDS_ROOT, 'src/workflows', wf.file));
}

const grouped = new Map();
for (const item of collected) {
  const existing = grouped.get(item.agent) || [];
  existing.push(item);
  grouped.set(item.agent, existing);
}

function compileContent(agent, items) {
  const sorted = [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.name.localeCompare(b.name);
  });
  const body = sorted.map((item) => `## ${item.type}: ${item.name}\nSource: ${item.filePath}\n\n${item.content}`).join('\n\n');
  return `# WDS Default Instructions\n\nAgent: ${agent}\nModel target: ${MODEL_TARGET}\n\n${body}\n`;
}

const compiledRows = [...grouped.entries()].map(([agent, items]) => {
  const content = compileContent(agent, items);
  return {
    agent_id: agent,
    model_target: MODEL_TARGET,
    skill_level: 'wds_default',
    content,
    version: createHash('sha256').update(content).digest('hex').substring(0, 12),
  };
});

console.log(`Compiled ${compiledRows.length} instruction bundle(s):`);
for (const row of compiledRows) {
  console.log(`  ${row.agent_id}: ${row.content.length} chars (${row.version})`);
}
console.log();

if (DRY_RUN) {
  console.log('DRY RUN - not uploading.');
  process.exit(0);
}

async function request(method, path, body) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

let uploaded = 0;
for (const row of compiledRows) {
  const filter = `agent_id=eq.${encodeURIComponent(row.agent_id)}&model_target=eq.${encodeURIComponent(row.model_target)}&skill_level=eq.wds_default`;
  await request('DELETE', `/rest/v1/agent_instructions?${filter}`, null);
  await request('POST', '/rest/v1/agent_instructions', row);
  uploaded += 1;
  console.log(`  uploaded ${row.agent_id} (${row.version})`);
}

console.log();
console.log(`Done: ${uploaded} instruction bundle(s) uploaded`);
