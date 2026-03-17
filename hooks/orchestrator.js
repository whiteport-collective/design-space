#!/usr/bin/env node
/**
 * Design Space Orchestrator
 *
 * Always-on listener that:
 * 1. Watches Design Space for agent messages via Supabase Realtime
 * 2. Shows Windows toast notification when a message needs attention
 * 3. Can auto-launch agents via Claude Code SDK when feedback arrives
 *
 * Cost: Zero Claude API credits while listening.
 * Credits only used when an agent is actually launched.
 *
 * Usage: node orchestrator.js [--auto-launch]
 */

import { createClient } from '@supabase/supabase-js';
import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const SUPABASE_URL = process.env.DESIGN_SPACE_URL;
const SUPABASE_KEY = process.env.DESIGN_SPACE_ANON_KEY;

const AUTO_LAUNCH = process.argv.includes('--auto-launch');
const SESSIONS_FILE = join(import.meta.dirname, 'sessions.json');

// Track active agent sessions
let sessions = {};
if (existsSync(SESSIONS_FILE)) {
  try { sessions = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')); } catch (_) {}
}

function saveSessions() {
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// Windows toast notification
function showToast(title, message) {
  try {
    const escaped = message.replace(/'/g, "''").replace(/`/g, '``');
    execSync(
      `powershell -Command "New-BurntToastNotification -Text '${title}', '${escaped}'"`,
      { timeout: 5000, stdio: 'ignore' }
    );
  } catch (_) {
    // Fallback: just log to console
    console.log(`\n🔔 ${title}: ${message}\n`);
  }
}

// Launch agent via Claude Code SDK (CLI mode)
function launchAgent(agentId, message, fromAgent) {
  console.log(`Launching ${agentId} to handle message from ${fromAgent}...`);

  const sessionId = sessions[agentId];
  const args = ['--print'];

  // Resume existing session if available
  if (sessionId) {
    args.push('--resume', sessionId);
  }

  args.push('--prompt', `Design Space message from ${fromAgent}: ${message}`);

  const proc = spawn('claude', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true
  });

  let output = '';
  proc.stdout.on('data', (data) => {
    output += data.toString();
    process.stdout.write(data);
  });
  proc.stderr.on('data', (data) => process.stderr.write(data));

  proc.on('close', (code) => {
    console.log(`\n${agentId} finished (exit ${code})`);
    // Extract session ID from output if available
    const sessionMatch = output.match(/session[:\s]+([a-f0-9-]+)/i);
    if (sessionMatch) {
      sessions[agentId] = sessionMatch[1];
      saveSessions();
    }
  });
}

// Main: connect to Supabase Realtime
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log('Design Space Orchestrator starting...');
console.log(`Mode: ${AUTO_LAUNCH ? 'auto-launch agents' : 'notifications only'}`);
console.log('Listening for agent messages...\n');

const channel = supabase
  .channel('orchestrator')
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'design_space',
    filter: 'category=eq.agent_message'
  }, (payload) => {
    const msg = payload.new;
    const meta = msg.metadata || {};
    const fromAgent = meta.from_agent || 'unknown';
    const toAgent = meta.to_agent;
    const priority = meta.priority || 'normal';
    const messageType = meta.message_type || 'message';
    const content = msg.content || '';

    const timestamp = new Date().toLocaleTimeString('sv-SE');
    console.log(`[${timestamp}] ${fromAgent} → ${toAgent || 'broadcast'}: ${content.substring(0, 100)}`);

    // Always show notification
    showToast(
      `${fromAgent} → ${toAgent || 'all'}`,
      content.substring(0, 120)
    );

    // Auto-launch target agent if enabled and message has a specific recipient
    if (AUTO_LAUNCH && toAgent && messageType === 'feedback') {
      launchAgent(toAgent, content, fromAgent);
    }
  })
  .subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log('Connected to Design Space Realtime');
    } else {
      console.log(`Realtime status: ${status}`);
    }
  });

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down orchestrator...');
  channel.unsubscribe();
  supabase.removeAllChannels();
  process.exit(0);
});

// Keep alive
setInterval(() => {}, 60000);
