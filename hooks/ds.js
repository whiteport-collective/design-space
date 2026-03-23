#!/usr/bin/env node
/**
 * Design Space — Agent Session Runner
 *
 * An agent-agnostic session manager that listens to Design Space via
 * Supabase Realtime, spawns terminal sessions, and bridges to Telegram.
 *
 * Usage:
 *   node ds.js                          # notifications only
 *   node ds.js --auto-launch            # launch agents on messages
 *   node ds.js --auto-launch --machine stockholm
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
// Output content filter — strips terminal UI chrome, keeps agent content
// ---------------------------------------------------------------------------

function isContentLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // UI indicators and spinners
  if (/^[›❯•◦✶✻✢✽·■□▪▫►▸▹▷◈◉○●]/.test(trimmed)) return false;
  // Box drawing characters
  if (/^[╭╰│╮╯─┌└├┐┘┤┬┴┼═║╔╗╚╝╠╣╦╩╬]/.test(trimmed)) return false;
  // Progress/status bars
  if (trimmed.includes('esc to interrupt')) return false;
  if (trimmed.includes('% left')) return false;
  if (trimmed.includes('MCP server')) return false;
  if (trimmed.includes('ctrl+o to expand')) return false;
  if (trimmed.includes('ctrl+g to edit')) return false;
  if (/^(Running|Ran|Searched|Read|Searching)/.test(trimmed)) return false;
  // Model labels
  if (/gpt-\d|claude-|Opus|Sonnet|Haiku|Implement \{feature\}/.test(trimmed)) return false;
  // Timestamps from the runner itself
  if (/^\[\d{2}:\d{2}:\d{2}\] \[design-space:/.test(trimmed)) return false;
  // Single-char noise
  if (trimmed.length < 3) return false;
  return true;
}

function extractContent(outputBuffer, lastPosted) {
  const newOutput = outputBuffer.substring(lastPosted);
  const lines = newOutput.split('\n').filter(isContentLine);
  return lines.join('\n').trim();
}

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

  if (trimmed === '/stop') {
    const last = Array.from(activeSessions.values()).pop();
    if (last) {
      log(`Killing session ${last.agentName} (Telegram /stop)`);
      last.pty.kill();
      tg(`Stopped ${last.agentName} session on ${MACHINE}`);
    } else {
      tg(`No active sessions on ${MACHINE}`);
    }
    return;
  }

  // @machine directives
  const machineMatch = trimmed.match(/^@(\w+)\s+(.+)$/);
  if (machineMatch) {
    const targetMachine = machineMatch[1].toLowerCase();
    const instruction = machineMatch[2];

    if (targetMachine !== MACHINE.toLowerCase()) {
      postToDesignSpace({
        action: 'send',
        from_agent: `ds-${MACHINE}`,
        content: instruction,
        message_type: 'handoff',
        metadata: { target_machine: targetMachine, source: 'telegram' },
      });
      tg(`Forwarded to ${targetMachine}: ${instruction}`);
      return;
    }
    launchFromTelegram(instruction);
    return;
  }

  // Free text → active session
  const last = Array.from(activeSessions.values()).pop();
  if (last && last.pty) {
    last.pty.write(trimmed + '\r');
    log(`[Telegram → ${last.agentName}] ${trimmed.substring(0, 80)}`);
  } else {
    tg(`No active session. Use \`@${MACHINE} start <agent> for <project>\` to launch.`);
  }
}

function launchFromTelegram(instruction) {
  const match = instruction.match(/^start\s+(\w+)(?:\s+for\s+(\w+))?(?:\s+in\s+(.+))?$/i);
  if (!match) {
    tg(`Format: \`start <agent> for <project> [in <path>]\``);
    return;
  }

  const agentName = match[1].toLowerCase();
  const project = match[2] || null;
  const workDir = match[3] || null;

  // Resolve CLI from agent name
  const agentCli = agentsConfig.agents[agentName]
    ? agentName
    : agentsConfig.agents[`${agentName}-cli`]
      ? `${agentName}-cli`
      : agentsConfig.default_agent;

  const cli = agentsConfig.agents[agentCli] || agentsConfig.agents[agentsConfig.default_agent];
  const activation = cli?.activation || 'prompt';

  let prompt;
  if (activation === 'slash') {
    prompt = `/${agentName}`;
  } else {
    prompt = project
      ? `Work on project: ${project}. Check Design Space for context.`
      : `Check Design Space for pending work.`;
  }

  launchSession({
    agentName,
    agentCli,
    prompt,
    activation,
    workDir,
    project,
    threadId: `telegram-${Date.now()}`,
    fromAgent: 'telegram',
    content: prompt,
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
    agent_id: `ds-${MACHINE}`,
    status: 'in-progress',
  });
}

async function checkUnread() {
  return postToDesignSpace({
    action: 'check',
    agent_id: `ds-${MACHINE}`,
  });
}

// ---------------------------------------------------------------------------
// Session launcher
// ---------------------------------------------------------------------------

function launchSession({ agentName, agentCli, prompt, workDir, project, threadId, fromAgent, content, activation }) {
  const cli = agentsConfig.agents[agentCli] || agentsConfig.agents[agentsConfig.default_agent];
  activation = activation || cli?.activation || 'prompt';
  if (!cli) {
    log(`Unknown agent CLI: ${agentCli}`);
    tg(`Unknown agent CLI: ${agentCli}`);
    return;
  }

  const cwd = workDir || join(__dirname, '..');
  log(`Launching ${agentName} via ${cli.command} in ${cwd}`);
  tg(`*${MACHINE}:* Starting ${agentName} session...\n_${(prompt || '').substring(0, 120)}_`);

  // Confirm session start to Design Space thread
  if (threadId && !threadId.startsWith('telegram-')) {
    postToDesignSpace({
      action: 'respond',
      message_id: threadId,
      from_agent: `ds-${MACHINE}`,
      content: `Session started on ${MACHINE} (${cli.command}, ${activation} mode)`,
    });
  }

  const args = [...cli.args];

  // Clean env
  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;
  cleanEnv.AGENT_ID = agentName;
  cleanEnv.AGENT_PROJECT = project || '';

  let fullCmd;
  if (activation === 'prompt' && prompt) {
    const launcherPath = join(__dirname, `.ds-${Date.now()}.bat`);
    const cmdParts = [cli.command, ...args];
    if (cli.prompt_flag) {
      cmdParts.push(cli.prompt_flag, `"${prompt.replace(/"/g, '')}"`);
    } else {
      cmdParts.push(`"${prompt.replace(/"/g, '')}"`);
    }
    const batContent = `@echo off\r\ncd /d "${cwd}"\r\n${cmdParts.join(' ')}`;
    writeFileSync(launcherPath, batContent);
    fullCmd = launcherPath;
    setTimeout(() => { try { unlinkSync(launcherPath); } catch (_) {} }, 60000);
  } else {
    fullCmd = [cli.command, ...args].join(' ');
  }

  // Spawn via node-pty
  const pty = ptySpawn('cmd.exe', ['/c', fullCmd], {
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
    outputBuffer: '',
    lineCount: 0,
    lastOutputAt: Date.now(),
    lastPostedAt: 0, // position in outputBuffer last posted to DS
  };

  activeSessions.set(threadId, session);

  // --- PTY output → terminal + observation ---
  pty.onData((data) => {
    process.stdout.write(data);
    session.outputBuffer += data;
    session.lineCount += (data.match(/\n/g) || []).length;
    session.lastOutputAt = Date.now();
  });

  // --- Persona activation for slash-mode agents ---
  if (activation === 'slash' && prompt) {
    let injected = false;
    const promptDisposable = pty.onData((data) => {
      if (!injected && (data.includes('❯') || data.includes('$') || data.includes('>'))) {
        injected = true;
        setTimeout(() => {
          pty.write(prompt);
          pty.write('\r');
          log(`Activated ${agentName} with: ${prompt}`);
        }, 500);
        promptDisposable.dispose();
      }
    });

    setTimeout(() => {
      if (!injected) {
        injected = true;
        pty.write(prompt);
        pty.write('\r');
        log(`Activated ${agentName} (fallback): ${prompt}`);
      }
    }, 30000);
  }

  // --- Keyboard input → PTY ---
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const stdinHandler = (data) => {
      if (data.toString() === '\x03') {
        pty.write('\x03');
      } else {
        pty.write(data.toString());
      }
    };
    process.stdin.on('data', stdinHandler);
    session.stdinHandler = stdinHandler;
  }

  // --- Periodic content digest to Design Space ---
  if (threadId && !threadId.startsWith('telegram-')) {
    session.digestInterval = setInterval(() => {
      const content = extractContent(session.outputBuffer, session.lastPostedAt);
      if (content && content.length > 20) {
        postToDesignSpace({
          action: 'respond',
          message_id: threadId,
          from_agent: `ds-${MACHINE}`,
          content: `[progress] ${content.substring(0, 800)}`,
        });
        session.lastPostedAt = session.outputBuffer.length;
      }
    }, 30000); // Post digest every 30 seconds if there's new content
  }

  // --- Session end ---
  pty.onExit(({ exitCode }) => {
    const duration = Math.round((Date.now() - session.startedAt) / 60000);
    log(`\n${agentName} session ended (exit ${exitCode}, ${duration}m, ${session.lineCount} lines)`);
    tg(`*${MACHINE}:* ${agentName} session complete — ${duration}m, exit ${exitCode}`);

    // Post final summary to Design Space
    const finalContent = extractContent(session.outputBuffer, session.lastPostedAt);
    if (threadId && !threadId.startsWith('telegram-')) {
      postToDesignSpace({
        action: 'respond',
        message_id: threadId,
        from_agent: `ds-${MACHINE}`,
        content: `Session ended (exit ${exitCode}, ${duration}m)${finalContent ? `\n\n${finalContent.substring(0, 1000)}` : ''}`,
      });
    }

    // Clean up
    if (session.digestInterval) clearInterval(session.digestInterval);
    activeSessions.delete(threadId);

    if (process.stdin.isTTY) {
      if (session.stdinHandler) {
        process.stdin.removeListener('data', session.stdinHandler);
      }
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  });

  return session;
}

// Nudge a running session about a new Design Space message.
function nudgeSession(session, fromAgent) {
  setTimeout(() => {
    session.pty.write(`/btw You have a new message from ${fromAgent} in Design Space. Run /u when ready.\r`);
    log(`Nudged ${session.agentName} about message from ${fromAgent}`);
  }, 1000);
}

// ---------------------------------------------------------------------------
// Watchdog
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
  // Clean up dead sessions
  for (const [key, session] of activeSessions) {
    try {
      if (session.pty && session.pty.pid) {
        process.kill(session.pty.pid, 0);
      }
    } catch (_) {
      log(`Cleaned up dead session: ${session.agentName}`);
      activeSessions.delete(key);
    }
  }

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

  if (targetMachine && targetMachine.toLowerCase() !== MACHINE.toLowerCase()) {
    return;
  }

  if (fromAgent === `ds-${MACHINE}`) {
    return;
  }

  // Skip messages from our own child sessions
  for (const [, session] of activeSessions) {
    const names = [session.agentName, session.agentCli];
    if (names.some(n => n && (fromAgent === n || fromAgent.startsWith(n + '-')))) {
      log(`Ignoring message from own child session: ${fromAgent}`);
      return;
    }
  }

  // Nudge existing session if one is running for this agent
  let existingSession = activeSessions.get(threadId);
  if (!existingSession) {
    for (const [, session] of activeSessions) {
      if (session.agentName === toAgent) {
        existingSession = session;
        break;
      }
    }
  }
  if (existingSession && existingSession.pty) {
    nudgeSession(existingSession, fromAgent);
    tg(`[DS → ${existingSession.agentName}@${MACHINE}] ${fromAgent}: ${content.substring(0, 100)}`);
    return;
  }

  // --- Launch new session ---
  if (!AUTO_LAUNCH) {
    showToast(`${fromAgent} → ${toAgent || 'all'}`, content.substring(0, 120));
    tg(`[Design Space] ${fromAgent} → ${toAgent || 'all'}: ${content.substring(0, 200)}`);
    return;
  }

  if (!toAgent && !targetMachine) {
    tg(`[Design Space] ${fromAgent} broadcast: ${content.substring(0, 200)}`);
    return;
  }

  claimMessage(msg.id);

  const agentCli = agentsConfig.agents[toAgent]
    ? toAgent
    : agentsConfig.agents[`${toAgent}-cli`]
      ? `${toAgent}-cli`
      : agentsConfig.default_agent;
  const workDir = meta.working_directory || null;
  const project = msg.project || meta.project || null;

  const cli2 = agentsConfig.agents[agentCli] || agentsConfig.agents[agentsConfig.default_agent];
  const activation = cli2?.activation || 'prompt';

  let prompt;
  if (activation === 'slash' && toAgent) {
    prompt = `/${toAgent}`;
  } else {
    prompt = content || `Check Design Space for your messages. You have a ${messageType} from ${fromAgent}.`;
  }

  launchSession({
    agentName: toAgent || 'agent',
    agentCli,
    prompt,
    activation,
    workDir,
    project,
    threadId,
    fromAgent,
    content,
  });
}

// ---------------------------------------------------------------------------
// Windows toast notification
// ---------------------------------------------------------------------------

function showToast(title, message) {
  try {
    const escaped = message.replace(/'/g, "''").replace(/`/g, '``');
    execSync(
      `powershell -Command "New-BurntToastNotification -Text '${title}', '${escaped}'"`,
      { timeout: 5000, stdio: 'ignore' }
    );
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toLocaleTimeString('sv-SE');
  console.log(`[${ts}] [design-space:${MACHINE}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

log('Design Space starting...');
log(`Machine: ${MACHINE}`);
log(`Mode: ${AUTO_LAUNCH ? 'auto-launch' : 'notifications only'}`);
log(`Telegram: ${TELEGRAM_BOT_TOKEN ? 'enabled' : 'disabled'}`);
log(`Agents: ${Object.keys(agentsConfig.agents).join(', ')}`);

tg(`*${MACHINE} online* — Design Space is listening.`);

// Check for messages that arrived while offline
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
        log(`Found ${directed.length} unread message(s) from while offline`);
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
  .channel('design-space-runner')
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

// Reconnection detection
let wasConnected = false;
let disconnectedAt = null;

setInterval(async () => {
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
    const result = await checkUnread();
    if (result?.messages?.length > 0) {
      tg(`*${MACHINE}:* ${result.messages.length} message(s) arrived while offline`);
    }
  }
  if (state === 'joined') wasConnected = true;
}, 30000);

// Telegram polling
if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
  log('Starting Telegram polling...');
  (async function telegramLoop() {
    while (true) {
      await pollTelegram();
    }
  })();
}

// Watchdog
setInterval(watchdog, 5 * 60 * 1000);

// Graceful shutdown
process.on('SIGINT', () => {
  log('Shutting down...');
  tg(`*${MACHINE} offline* — Design Space shutting down.`);
  channel.unsubscribe();
  supabase.removeAllChannels();
  for (const [, session] of activeSessions) {
    session.pty.kill();
  }
  setTimeout(() => process.exit(0), 1000);
});

// Keep alive
setInterval(() => {}, 60000);
