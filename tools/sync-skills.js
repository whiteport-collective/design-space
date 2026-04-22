#!/usr/bin/env node
/**
 * sync-skills — Push/pull/status for Agent Space skill versioning.
 *
 * Usage:
 *   node sync-skills.js status [--dir <skills-dir>]
 *   node sync-skills.js push [--dir <skills-dir>] [--slug <skill-slug>]
 *   node sync-skills.js pull [--dir <skills-dir>] [--slug <skill-slug>]
 *
 * Reads skill.md files from a local skills directory, computes content hashes,
 * and compares against Agent Space. Supports push (upload) and pull (download).
 *
 * Hash: SHA256(content).hex().substring(0, 12) — same as sync-instructions.js
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, basename, relative } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { readdirSync, statSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DS_URL = process.env.DESIGN_SPACE_URL || 'https://uztngidbpduyodrabokm.supabase.co';
const DS_KEY = process.env.DESIGN_SPACE_ANON_KEY || '';
const DEFAULT_SKILLS_DIR = process.env.SKILLS_DIR || join(__dirname, '../../Web247/web247-agent-space/skills');

// ── CLI parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0] || 'status';
const flagDir = args.indexOf('--dir') !== -1 ? args[args.indexOf('--dir') + 1] : DEFAULT_SKILLS_DIR;
const flagSlug = args.indexOf('--slug') !== -1 ? args[args.indexOf('--slug') + 1] : null;
const flagAgent = args.indexOf('--agent') !== -1 ? args[args.indexOf('--agent') + 1] : null;

if (!DS_KEY) {
  // Try to load from .env
  const envPath = join(__dirname, '../.env');
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf-8');
    const match = envContent.match(/DESIGN_SPACE_ANON_KEY=(.+)/);
    if (match) process.env.DESIGN_SPACE_ANON_KEY = match[1].trim();
  }
}

const ANON_KEY = process.env.DESIGN_SPACE_ANON_KEY;
if (!ANON_KEY) {
  console.error('ERROR: DESIGN_SPACE_ANON_KEY env var is required');
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hash(content) {
  return createHash('sha256').update(content).digest('hex').substring(0, 12);
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  match[1].split('\n').forEach(line => {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) fm[key.trim()] = rest.join(':').trim();
  });
  return fm;
}

async function apiCall(action, body = {}) {
  const res = await fetch(`${DS_URL}/functions/v1/agent-instructions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action, ...body }),
  });
  return res.json();
}

// ── Discover local skills ───────────────────────────────────────────────────

function findSkills(dir) {
  const skills = [];
  if (!existsSync(dir)) {
    console.error(`Skills directory not found: ${dir}`);
    process.exit(1);
  }

  function walk(current, pathParts = []) {
    const entries = readdirSync(current);
    const skillFile = entries.find(e => e.toLowerCase() === 'skill.md' || e.toLowerCase() === 'tool.md');
    if (skillFile) {
      const skillPath = join(current, skillFile);
      const content = readFileSync(skillPath, 'utf-8');
      const fm = parseFrontmatter(content);
      const slug = pathParts.join('/') || basename(current);
      skills.push({
        slug: fm.name || slug,
        domain: fm.domain || pathParts[0] || null,
        agent: fm.agent || null,
        owner: fm.owner || null,
        name: fm.name || slug,
        fmVersion: fm.version || null,  // human-readable version from frontmatter
        content,
        localHash: hash(content),
        path: skillPath,
      });
    }
    for (const entry of entries) {
      const full = join(current, entry);
      if (statSync(full).isDirectory() && entry !== 'node_modules' && entry !== '.git') {
        walk(full, [...pathParts, entry]);
      }
    }
  }

  walk(dir);
  return skills;
}

// ── Commands ────────────────────────────────────────────────────────────────

async function status() {
  const local = findSkills(flagDir);
  const { skills: remote } = await apiCall('list-skills');

  console.log(`\n  Skill Sync Status`);
  console.log(`  Local: ${flagDir}`);
  console.log(`  Remote: ${DS_URL}\n`);
  console.log(`  ${'Skill'.padEnd(35)} ${'Local'.padEnd(14)} ${'Remote'.padEnd(14)} Status`);
  console.log(`  ${'─'.repeat(35)} ${'─'.repeat(14)} ${'─'.repeat(14)} ${'─'.repeat(10)}`);

  const remoteMap = new Map();
  for (const r of (remote || [])) {
    remoteMap.set(r.skill_slug, r);
  }

  for (const skill of local) {
    const r = remoteMap.get(skill.slug);
    const remoteVersion = r?.version || '(none)';
    const localVersion = skill.fmVersion || `sha:${skill.localHash.substring(0, 8)}`;
    let status;
    if (!r) {
      status = 'NEW';
    } else if (!r.version) {
      status = 'UNVERSIONED';
    } else if (r.version === localVersion) {
      status = 'OK';
    } else {
      status = 'CHANGED';
    }
    console.log(`  ${skill.slug.padEnd(35)} ${localVersion.padEnd(14)} ${String(remoteVersion).padEnd(14)} ${status}`);
  }

  // Remote-only skills
  for (const [slug, r] of remoteMap) {
    if (!local.find(s => s.slug === slug)) {
      console.log(`  ${slug.padEnd(35)} ${'(missing)'.padEnd(14)} ${(r.version || '(none)').padEnd(14)} REMOTE-ONLY`);
    }
  }

  console.log('');
}

async function push() {
  const local = findSkills(flagDir);
  const toPush = flagSlug ? local.filter(s => s.slug === flagSlug) : local;

  if (toPush.length === 0) {
    console.log(flagSlug ? `Skill not found locally: ${flagSlug}` : 'No local skills found.');
    return;
  }

  console.log(`\nPushing ${toPush.length} skill(s) to Agent Space...\n`);

  for (const skill of toPush) {
    // Detect skill level: wds_default for WDS source skills, org for org-level
    const isWdsDefault = skill.path.includes('whiteport-design-studio') && !skill.path.includes('agent-space');
    const skillLevel = isWdsDefault ? 'wds_default' : 'org';

    const result = await apiCall('upsert-skill', {
      agent_id: skill.agent || '*',
      skill_slug: skill.slug,
      skill_name: skill.name,
      skill_level: skillLevel,
      org_id: 'whiteport',
      content: skill.content,
      version: skill.fmVersion || null,  // pass frontmatter version; edge fn falls back to hash
      description: skill.content.split('\n').find(l => l && !l.startsWith('#') && !l.startsWith('---'))?.trim() || skill.name,
    });

    const icon = result.success ? '+' : 'x';
    console.log(`  [${icon}] ${skill.slug} → ${result.version || '?'} (${result.action || 'error'})`);
  }

  console.log('');
}

async function pull() {
  if (!flagSlug) {
    console.log('Pull requires --slug <skill-slug>');
    return;
  }

  const result = await apiCall('get-skill', { skill_slug: flagSlug });
  if (!result.skill) {
    console.log(`Skill not found in Agent Space: ${flagSlug}`);
    return;
  }

  const skill = result.skill;
  if (!skill.content) {
    console.log(`Skill ${flagSlug} has no content stored in Agent Space.`);
    return;
  }

  // Determine local path
  const parts = flagSlug.split('/');
  const localDir = join(flagDir, ...parts);
  const localPath = join(localDir, 'skill.md');

  if (!existsSync(localDir)) {
    mkdirSync(localDir, { recursive: true });
  }

  writeFileSync(localPath, skill.content, 'utf-8');
  console.log(`\nPulled ${flagSlug} → ${localPath}`);
  console.log(`Version: ${skill.version || '(none)'}\n`);
}

// ── Main ────────────────────────────────────────────────────────────────────

switch (command) {
  case 'status': await status(); break;
  case 'push':   await push();   break;
  case 'pull':   await pull();   break;
  default:
    console.log(`Unknown command: ${command}`);
    console.log('Usage: sync-skills.js [status|push|pull] [--dir <path>] [--slug <slug>] [--agent <agent>]');
}
