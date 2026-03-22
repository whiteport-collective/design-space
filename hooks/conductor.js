#!/usr/bin/env node
/**
 * The Conductor — Agent Session Manager
 *
 * An agent-agnostic session manager that listens to Design Space via
 * Supabase Realtime, spawns terminal sessions, pipes stdin/stdout,
 * and bridges to Telegram.
 *
 * Like a musical conductor — doesn't compose the music or play the
 * instruments, just makes sure everyone comes in at the right time.
 *
 * Usage:
 *   node conductor.js                          # notifications only
 *   node conductor.js --auto-launch            # launch agents on messages
 *   node conductor.js --auto-launch --machine stockholm
 *
 * Cost: Zero while listening. Credits only when an agent is launched.
 */

import { createClient } from '@supabase/supabase-js';
import { spawn as ptySpawn } from 'node-pty';
import { spawn, execSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Load .env from repo root
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.replace(/\r/g, '').split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

const SUPABASE_URL = process.env.DESIGN_SPACE_URL;
const SUPABASE_KEY = process.env.DESIGN_SPACE_ANON_KEY;
const MACHINE_NAME = process.env.MACHINE_NAME || 'default';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const AUTO_LAUNCH = process.argv.includes('--auto-launch');
const machineIdx = process.argv.indexOf('--machine');
const MACHINE = machineIdx !== -1 ? process.argv[machineIdx + 1] : MACHINE_NAME;

// Load agent configurations
const agentsConfigPath = join(__dirname, 'agents.json');
const agentsConfig = JSON.parse(readFileSync(agentsConfigPath, 'utf8'));

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing DESIGN_SPACE_URL or DESIGN_SPACE_ANON_KEY in .env');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Active sessions — keyed by Design Space thread ID
// ---------------------------------------------------------------------------

const activeSessions = new Map();

// ---------------------------------------------------------------------------
// Telegram bridge
// ---------------------------------------------------------------------------

async function telegram(method, body = {}) {
  if (!TELEGRAM_BOT_TOKEN) return null;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    return await res.json();
  } catch (err) {
    console.error(`Telegram ${method} failed:`, err.message);
    return null;
  }
}

function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  // Truncate to Telegram's 4096 char limit
  const msg = text.length > 4000 ? text.substring(0, 4000) + '...' : text;
  telegram('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text: msg,
    parse_mode: 'Markdown',
  });
}

// Poll for Telegram incoming messages
let telegramOffset = 0;

async function pollTelegram() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const res = await telegram('getUpdates', {
      offset: telegramOffset,
      timeout: 30,
      allowed_updates: ['message'],
    });
    if (!res || !res.ok || !res.result) return;

    for (const update of res.result) {
      telegramOffset = update.update_id + 1;
      const msg = update.message;
      if (!msg || !msg.text) continue;
      if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) continue;

      handleTelegramInput(msg.text);
    }
  } catch (err) {
    console.error('Telegram poll error:', err.message);
  }
}

function handleTelegramInput(text) {
  const trimmed = text.trim();

  // /status command
  if (trimmed === '/status') {
    const sessions = [];
    for (const [threadId, s] of activeSessions) {
      const mins = Math.round((Date.now() - s.startedAt) / 60000);
      sessions.push(`  ${s.agentName || 'agent'} — ${mins}m (thread: ${threadId.substring(0, 8)})`);
    }
    const status = sessions.length
      ? `*${MACHINE}* — ${sessions.length} active session(s):\n${sessions.join('\n')}`
      : `*${MACHINE}* — no active sessions`;
    tg(status);
    return;
  }

  // /stop command — kills most recent session
  if (trimmed === '/stop') {
    const last = Array.from(activeSessions.values()).pop();
    if (last) {
      log(`Killing session ${last.agentName} (Telegram /stop)`);
      last.process.kill();
      tg(`Stopped ${last.agentName} session on ${MACHINE}`);
    } else {
      tg(`No active sessions on ${MACHINE}`);
    }
    return;
  }

  // @machine directives: @stockholm start saga for kalla
  const machineMatch = trimmed.match(/^@(\w+)\s+(.+)$/);
  if (machineMatch) {
    const targetMachine = machineMatch[1].toLowerCase();
    const instruction = machineMatch[2];

    if (targetMachine !== MACHINE.toLowerCase()) {
      // Not for us — post to Design Space so the other machine picks it up
      postToDesignSpace({
        action: 'send',
        from_agent: 'conductor',
        content: instruction,
        message_type: 'handoff',
        metadata: { target_machine: targetMachine, source: 'telegram' },
      });
      tg(`Forwarded to ${targetMachine}: ${instruction}`);
      return;
    }
    // For us — treat as a launch instruction
    launchFromTelegram(instruction);
    return;
  }

  // Free text — pipe to most recent active session
  const last = Array.from(activeSessions.values()).pop();
  if (last && last.process.stdin.writable) {
    last.process.stdin.write(trimmed + '\n');
    log(`[Telegram → ${last.agentName}] ${trimmed.substring(0, 80)}`);
  } else {
    tg(`No active session to send to. Use \`@${MACHINE} start <agent> for <project>\` to launch one.`);
  }
}

function launchFromTelegram(instruction) {
  // Parse: "start saga for kalla" or "start claude for dogweek in C:\dev\..."
  const match = instruction.match(/^start\s+(\w+)(?:\s+for\s+(\w+))?(?:\s+in\s+(.+))?$/i);
  if (!match) {
    tg(`Couldn't parse: ${instruction}\nFormat: \`start <agent> for <project> [in <path>]\``);
    return;
  }

  const agentName = match[1].toLowerCase();
  const project = match[2] || null;
  const workDir = match[3] || null;

  const prompt = project
    ? `You are ${agentName}. Work on project: ${project}. Check Design Space for context.`
    : `You are ${agentName}. Check Design Space for pending work.`;

  launchSession({
    agentName,
    agentCli: agentsConfig.default_agent,
    prompt,
    workDir,
    project,
    threadId: `telegram-${Date.now()}`,
  });
}

// ---------------------------------------------------------------------------
// Design Space HTTP client
// ---------------------------------------------------------------------------

async function postToDesignSpace(body) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/agent-messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (err) {
    console.error('Design Space POST failed:', err.message);
    return null;
  }
}

async function claimMessage(messageId) {
  return postToDesignSpace({
    action: 'update-status',
    message_id: messageId,
    agent_id: `conductor-${MACHINE}`,
    status: 'in-progress',
  });
}

async function checkUnread() {
  return postToDesignSpace({
    action: 'check',
    agent_id: `conductor-${MACHINE}`,
  });
}

// ---------------------------------------------------------------------------
// Session launcher
// ---------------------------------------------------------------------------

function launchSession({ agentName, agentCli, prompt, workDir, project, threadId, fromAgent, content }) {
  const cli = agentsConfig.agents[agentCli] || agentsConfig.agents[agentsConfig.default_agent];
  if (!cli) {
    log(`Unknown agent CLI: ${agentCli}`);
    tg(`Unknown agent CLI: ${agentCli}`);
    return;
  }

  const cwd = workDir || process.cwd();
  log(`Launching ${agentName} via ${cli.command} in ${cwd}`);
  tg(`*${MACHINE}:* Starting ${agentName} session...\n_${(prompt || '').substring(0, 120)}_`);

  // Build args
  const args = [...cli.args];
  if (prompt) {
    if (cli.prompt_flag) {
      args.push(cli.prompt_flag, prompt);
    } else {
      // Claude Code: prompt is positional
      args.push(prompt);
    }
  }

  // Strip CLAUDECODE env var so spawned sessions don't think they're nested
  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;

  // Spawn via node-pty — gives us a real PTY (full interactive UI)
  // AND stdin/stdout handles (so we can inject messages and observe output)
  const pty = ptySpawn(cli.command, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd,
    env: cleanEnv,
  });

  const session = {
    pty,
    agentName,
    agentCli,
    project,
    threadId,
    startedAt: Date.now(),
    registered: false,
    outputBuffer: '',
    lineCount: 0,
    lastOutputAt: Date.now(),
  };

  activeSessions.set(threadId, session);

  // --- PTY output → Conductor's terminal + observation ---
  pty.onData((data) => {
    // Relay to our own stdout so the user sees it
    process.stdout.write(data);

    session.outputBuffer += data;
    session.lineCount += (data.match(/\n/g) || []).length;
    session.lastOutputAt = Date.now();
  });

  // --- Keyboard input → PTY (user can type in Conductor's terminal) ---
  if (process.stdin.isTTY) {
    // Only attach stdin if we're the active session
    // (for MVP: last launched session gets keyboard input)
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data) => {
      // Ctrl+C twice = kill session
      if (data.toString() === '\x03') {
        pty.write('\x03');
      } else {
        pty.write(data.toString());
      }
    });
  }

  // --- Session end ---
  pty.onExit(({ exitCode }) => {
    const duration = Math.round((Date.now() - session.startedAt) / 60000);
    log(`\n${agentName} session ended (exit ${exitCode}, ${duration}m, ${session.lineCount} lines)`);
    tg(`*${MACHINE}:* ${agentName} session complete — ${duration}m, exit ${exitCode}`);

    // Post summary to Design Space
    const lastLines = session.outputBuffer.split('\n').slice(-20).join('\n');
    if (threadId && !threadId.startsWith('telegram-')) {
      postToDesignSpace({
        action: 'respond',
        message_id: threadId,
        from_agent: `conductor-${MACHINE}`,
        content: `Session ended (exit ${exitCode}, ${duration}m).\n\nLast output:\n${lastLines.substring(0, 1000)}`,
      });
    }

    activeSessions.delete(threadId);

    // Restore stdin
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  });

  return session;
}

// Inject a message into a running session's PTY
function injectMessage(session, fromAgent, message) {
  const banner = `\n\r\x1b[1;36m[Conductor] Message from ${fromAgent}:\x1b[0m\n\r${message}\n\r`;
  session.pty.write(banner);
}

// ---------------------------------------------------------------------------
// Watchdog — track session duration (stdout observation is post-MVP)
// ---------------------------------------------------------------------------

function watchdog() {
  for (const [threadId, session] of activeSessions) {
    const minutes = Math.round((Date.now() - session.startedAt) / 60000);
    if (minutes > 0 && minutes % 30 === 0) {
      tg(`[${session.agentName}@${MACHINE}] Session running for ${minutes}m`);
    }
  }
}

// ---------------------------------------------------------------------------
// Realtime message handler
// ---------------------------------------------------------------------------

function handleRealtimeMessage(payload) {
  const msg = payload.new;
  const meta = msg.metadata || {};
  const fromAgent = meta.from_agent || 'unknown';
  const toAgent = meta.to_agent;
  const targetMachine = meta.target_machine;
  const messageType = meta.message_type || 'message';
  const content = msg.content || '';
  const threadId = msg.thread_id || msg.id;

  const ts = new Date().toLocaleTimeString('sv-SE');
  log(`[${ts}] ${fromAgent} → ${toAgent || 'broadcast'}: ${content.substring(0, 100)}`);

  // --- Routing ---

  // If targeted at a specific machine, only that machine acts
  if (targetMachine && targetMachine.toLowerCase() !== MACHINE.toLowerCase()) {
    return;
  }

  // If from ourselves (conductor on this machine), skip
  if (fromAgent === `conductor-${MACHINE}`) {
    return;
  }

  // If from an agent we launched (active session), skip — don't react to our own children
  for (const [, session] of activeSessions) {
    if (fromAgent === session.agentName || fromAgent.startsWith(session.agentName + '-')) {
      log(`Ignoring message from own child session: ${fromAgent}`);
      return;
    }
  }

  // --- Check if we have an active session for this thread ---
  // Inject the message directly into the running PTY session
  const existingSession = activeSessions.get(threadId);
  if (existingSession && existingSession.pty) {
    injectMessage(existingSession, fromAgent, content.substring(0, 500));
    log(`Injected message into ${existingSession.agentName} session`);
    tg(`[DS → ${existingSession.agentName}@${MACHINE}] ${fromAgent}: ${content.substring(0, 100)}`);
    return;
  }

  // --- Should we launch a new session? ---
  if (!AUTO_LAUNCH) {
    // Notification only
    showToast(`${fromAgent} → ${toAgent || 'all'}`, content.substring(0, 120));
    tg(`[Design Space] ${fromAgent} → ${toAgent || 'all'}: ${content.substring(0, 200)}`);
    return;
  }

  // Only launch for directed messages (not broadcasts)
  if (!toAgent && !targetMachine) {
    tg(`[Design Space] ${fromAgent} broadcast: ${content.substring(0, 200)}`);
    return;
  }

  // Claim the message
  claimMessage(msg.id);

  // Determine agent CLI and working directory
  const agentCli = meta.agent_cli || agentsConfig.default_agent;
  const workDir = meta.working_directory || null;
  const project = msg.project || meta.project || null;

  // Keep the prompt minimal. The agent's identity comes from the repo
  // (CLAUDE.md, .codex/, activation files). The Conductor is just the alarm clock.
  const prompt = [
    `You were launched by The Conductor on ${MACHINE}.`,
    `First: read your project files to understand who you are.`,
    `Then: register with Design Space and check your messages.`,
    `You have a ${messageType || 'message'} from ${fromAgent} waiting for you.`,
  ].join(' ');

  launchSession({
    agentName: toAgent || 'agent',
    agentCli,
    prompt,
    workDir,
    project,
    threadId,
    fromAgent,
    content,
  });
}

// ---------------------------------------------------------------------------
// Windows toast notification (fallback when no Telegram)
// ---------------------------------------------------------------------------

function showToast(title, message) {
  try {
    const escaped = message.replace(/'/g, "''").replace(/`/g, '``');
    execSync(
      `powershell -Command "New-BurntToastNotification -Text '${title}', '${escaped}'"`,
      { timeout: 5000, stdio: 'ignore' }
    );
  } catch (_) {
    // Fallback: console only
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toLocaleTimeString('sv-SE');
  console.log(`[${ts}] [conductor:${MACHINE}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

log('The Conductor starting...');
log(`Machine: ${MACHINE}`);
log(`Mode: ${AUTO_LAUNCH ? 'auto-launch' : 'notifications only'}`);
log(`Telegram: ${TELEGRAM_BOT_TOKEN ? 'enabled' : 'disabled'}`);
log(`Agents: ${Object.keys(agentsConfig.agents).join(', ')}`);

// Notify on startup
tg(`*${MACHINE} online* — The Conductor is listening.`);

// Check for messages that arrived while offline — report only, don't auto-launch
// Auto-launching old messages causes a flood. Only Realtime events trigger launches.
(async () => {
  try {
    const result = await checkUnread();
    if (result && result.messages && result.messages.length > 0) {
      const directed = result.messages.filter(m => {
        const meta = m.metadata || {};
        const target = meta.target_machine;
        return (!target || target.toLowerCase() === MACHINE.toLowerCase())
          && (meta.to_agent || target);
      });
      if (directed.length > 0) {
        log(`Found ${directed.length} unread message(s) from while offline (report only — use Telegram or send a new message to trigger a session)`);
        tg(`*${MACHINE}:* ${directed.length} message(s) arrived while offline`);
        for (const msg of directed) {
          const meta = msg.metadata || {};
          log(`  → ${meta.from_agent || '?'} → ${meta.to_agent || 'broadcast'}: ${(msg.content || '').substring(0, 80)}`);
        }
      }
    }
  } catch (err) {
    log(`Startup check failed: ${err.message}`);
  }
})();

// Subscribe to Realtime
const channel = supabase
  .channel('conductor')
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'design_space',
    filter: 'category=eq.agent_message',
  }, handleRealtimeMessage)
  .subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      log('Connected to Design Space Realtime');
    } else if (status === 'CHANNEL_ERROR') {
      log('Realtime channel error — will retry...');
      tg(`*${MACHINE}:* Realtime connection error, retrying...`);
    } else {
      log(`Realtime status: ${status}`);
    }
  });

// Reconnection detection via channel status changes
let wasConnected = false;
let disconnectedAt = null;

// The Supabase JS v2 channel emits status via subscribe callback and system events.
// We track connection state through the subscribe callback above and a periodic check.
setInterval(async () => {
  // If we were connected but the channel state indicates closed, we disconnected
  const state = channel?.state;
  if (wasConnected && state === 'closed') {
    if (!disconnectedAt) {
      disconnectedAt = Date.now();
      log('Realtime disconnected');
    }
  } else if (state === 'joined' && disconnectedAt) {
    const offlineMinutes = Math.round((Date.now() - disconnectedAt) / 60000);
    log(`Reconnected after ${offlineMinutes}m offline`);
    tg(`*${MACHINE} reconnected* — was offline for ${offlineMinutes}m`);
    disconnectedAt = null;
    // Re-check for missed messages
    const result = await checkUnread();
    if (result?.messages?.length > 0) {
      tg(`*${MACHINE}:* ${result.messages.length} message(s) arrived while offline`);
    }
  }
  if (state === 'joined') wasConnected = true;
}, 30000);

// Telegram polling loop
if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
  log('Starting Telegram polling...');
  (async function telegramLoop() {
    while (true) {
      await pollTelegram();
    }
  })();
}

// Watchdog: check every 5 minutes for stuck sessions
setInterval(watchdog, 5 * 60 * 1000);

// Graceful shutdown
process.on('SIGINT', () => {
  log('Shutting down...');
  tg(`*${MACHINE} offline* — Conductor shutting down.`);
  channel.unsubscribe();
  supabase.removeAllChannels();
  // Kill any active sessions
  for (const [, session] of activeSessions) {
    session.process.kill();
  }
  setTimeout(() => process.exit(0), 1000); // Give Telegram message time to send
});

// Keep alive
setInterval(() => {}, 60000);
