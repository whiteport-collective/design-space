# Job: The Conductor — Agent Session Manager MVP

**Commissioner:** Mårten Angner (Whiteport)
**Author:** Saga (WDS Strategic Analyst)
**Target:** Any capable agent (Claude Code, Codex, or human)
**Repo:** `whiteport-collective/design-space`
**Priority:** High
**Date:** 2026-03-22

---

## Problem

AI agents running in terminal sessions (Claude Code, Codex CLI, aider, Gemini CLI, etc.) cannot receive messages while idle. Design Space is the message bus — agents post work orders, handoffs, and updates — but nothing wakes a sleeping agent when a message arrives.

Today, every agent interaction requires a human sitting at a keyboard. This blocks:
- Autonomous multi-agent workflows (Saga finishes a brief → hands off to Freya → Freya starts automatically)
- Remote tasking (you're on your phone, you want Stockholm to start working)
- Cross-machine handoffs (laptop agent says "continue this on Stockholm where the uncommitted files are")

Additionally, agents that go off the rails cannot self-report. A stuck loop won't self-diagnose. A hallucinated plan gets executed confidently. There is no independent observer.

## Solution

**The Conductor** — an agent-agnostic session manager that runs on each machine, listens to Design Space via Supabase Realtime, spawns terminal sessions, observes their output, and reports to both Design Space and Telegram. Like a musical conductor, it doesn't compose the music or play the instruments — it makes sure everyone comes in at the right time, stays in tempo, and notices when someone's off-key.

Three roles:

1. **Dispatcher** — launches the right agent on the right machine when a message arrives
2. **Bridge** — connects running sessions to Design Space and Telegram (stdin/stdout)
3. **Observer** — watches agent output independently, detects when things go off-track, and handles all Design Space reporting so the terminal agent doesn't need to

## Architecture

```
┌──────────────────────────────────────────┐
│            Design Space (Supabase)        │
│         Realtime subscription             │
└──────────┬──────────────┬────────────────┘
           │              │
    ┌──────▼──────┐ ┌─────▼───────┐
    │ Stockholm   │ │ Laptop      │
    │ conductor│ │ conductor│
    │             │ │             │
    │ ┌─────────┐ │ │ ┌─────────┐ │
    │ │Telegram │ │ │ │Telegram │ │
    │ │ bridge  │ │ │ │ bridge  │ │
    │ └─────────┘ │ │ └─────────┘ │
    │             │ │             │
    │ ┌─────────┐ │ │ ┌─────────┐ │
    │ │Terminal │ │ │ │Terminal │ │
    │ │sessions │ │ │ │sessions │ │
    │ └─────────┘ │ │ └─────────┘ │
    └─────────────┘ └─────────────┘
```

### Core Loop

1. **Listen** — Supabase Realtime subscription on `design_space` table, filtered to `category=agent_message`
2. **Evaluate** — Is this message directed at this machine? (via `metadata.target_machine`)
3. **Claim** — Post a status update so the other machine doesn't also pick it up
4. **Launch** — Spawn a terminal process with the appropriate CLI command
5. **Bridge** — Pipe stdout to Telegram, pipe Telegram replies to stdin, pipe Design Space updates to stdin
6. **Report** — When the session ends, notify via Telegram

### Design Principles

- **Agent-agnostic at every layer** — works with any CLI agent that has an interactive terminal mode. Claude Code, Codex CLI, aider, Gemini CLI, Open Interpreter, or anything that ships next month. No vendor assumptions in the plumbing.
- **PTY-first** — uses `node-pty` to give agents a real pseudo-terminal. This means agents get their full interactive UI, not a degraded piped-stdio mode. The conductor observes output via the PTY data stream and injects input by typing into it.
- **LLM-agnostic routing** — the optional smart routing layer uses any model that returns structured JSON. The conductor never assumes which LLM is "best."
- **Not a service yet** — it's a Node.js ESM script started by Task Scheduler or manually
- **Not an agent itself** — it doesn't think, it dispatches. Intelligence is a future dial, not baked in.

## Detailed Specification

### 1. Machine Identity

Each machine has a name, set in `.env`:

```env
MACHINE_NAME=stockholm
```

The conductor registers itself with Design Space on startup (as a special presence entry, not an agent) so other machines and Telegram can see it.

### 2. Message Routing

When a Realtime event arrives, the conductor evaluates:

```
if message.metadata.target_machine exists:
    only act if it matches MACHINE_NAME
else if message.metadata.to_agent exists:
    claim it (first machine wins — post "claimed by {MACHINE_NAME}")
else:
    ignore (broadcasts are informational)
```

**Claim protocol:** POST an `update-status` to Design Space with `status: "in-progress"` and `metadata.claimed_by: MACHINE_NAME`. If the status is already `in-progress`, skip it — another machine got there first.

### 3. Agent Configuration

Agents are configured in a JSON file (`agents.json`):

```json
{
  "agents": {
    "claude": {
      "command": "claude",
      "args": [],
      "prompt_flag": null,
      "interactive": true,
      "note": "Claude Code: interactive mode, prompt is positional. Trust folders manually first."
    },
    "claude-headless": {
      "command": "claude",
      "args": ["-p"],
      "prompt_flag": null,
      "interactive": false,
      "note": "Claude Code non-interactive: -p prints output and exits"
    },
    "codex-cli": {
      "command": "npx",
      "args": ["@openai/codex"],
      "prompt_flag": null,
      "interactive": true,
      "note": "OpenAI Codex CLI — prompt is positional argument"
    },
    "aider": {
      "command": "aider",
      "args": [],
      "prompt_flag": "--message",
      "interactive": true
    },
    "gemini": {
      "command": "gemini",
      "args": [],
      "prompt_flag": "--prompt",
      "interactive": true
    }
  },
  "default_agent": "claude"
}
```

Key change from the original design: `prompt_flag` is null for most agents because prompts are injected via the PTY after the agent UI is ready, not passed as CLI arguments. This avoids Windows `cmd.exe` escaping issues with complex strings.

The handoff message specifies which agent to use (defaults to `default_agent`):

```json
{
  "metadata": {
    "target_machine": "stockholm",
    "agent_cli": "claude",
    "working_directory": "C:\\dev\\Kalla-Fordonscervice\\kalla-fordonsservice"
  }
}
```

### 4. Terminal Launcher

Sessions are spawned via `node-pty`, which provides a real pseudo-terminal. This is critical — interactive CLI agents like Claude Code and Codex need a PTY to render their UI correctly. On Windows, `node-pty` spawns via `cmd.exe`:

```javascript
const fullCmd = [cli.command, ...cli.args].join(' ');
const pty = ptySpawn('cmd.exe', ['/c', fullCmd], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd,
  env: cleanEnv,  // CLAUDECODE env var stripped to prevent nested-session detection
});
```

The initial prompt is **not** passed as a CLI argument. Instead, the conductor waits for the agent's input prompt to appear, then types the activation command via the PTY. For persona agents, this is a slash command like `/saga`. A 30-second fallback injects the prompt if no prompt indicator is detected.

The conductor holds references to all active sessions, keyed by Design Space thread ID:

```javascript
activeSessions = Map {
  "thread-id": {
    pty,               // node-pty handle
    agentName: "saga",
    agentCli: "claude",
    project: "kalla",
    threadId: "...",
    startedAt: Date.now(),
    registered: false,
    outputBuffer: '',  // full stdout capture
    lineCount: 0,
    lastOutputAt: Date.now(),
    stdinHandler,      // keyboard input listener reference
  }
}
```

### 5. Mid-Session Nudging

When a Design Space message arrives for an agent that already has a running session, the conductor does **not** inject the raw message text. Instead, it types `/u` into the PTY — the agent's own Design Space check command. The agent then reads and handles the message in its own way, when it's ready.

```javascript
function nudgeSession(session, fromAgent) {
  setTimeout(() => {
    session.pty.write('/u\r');
  }, 1000);
}
```

Session matching: first by thread ID, then by agent name. If a `claude` session is running, any message `to_agent: "claude"` gets routed to it regardless of thread.

This design avoids fighting with terminal rendering — raw text injection into interactive PTY sessions causes display corruption. The `/u` approach lets the agent read the message through its normal Design Space integration.

### 6. Telegram Bridge

**Implementation:** No `node-telegram-bot-api` dependency. The conductor uses raw `fetch()` against the Telegram Bot API with long-polling via `getUpdates`. This keeps the dependency footprint minimal.

**Setup:** One Telegram bot via BotFather, token in `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=your-personal-chat-id
```

**Outbound — conductor → you:**

| Event | Telegram message |
|---|---|
| Conductor starts | `*stockholm online* — The Conductor is listening.` |
| Conductor reconnects | `*stockholm reconnected* — was offline for 3m` |
| Session launched | `*stockholm:* Starting saga session...` |
| DS message → running session | `[DS → saga@stockholm] freya: <content>` |
| Session ended | `*stockholm:* saga session complete — 12m, exit 0` |
| Session duration alert | `[saga@stockholm] Session running for 30m` |
| Realtime error | `*stockholm:* Realtime connection error, retrying...` |

Messages are truncated to Telegram's 4096 character limit and sent with Markdown parse mode.

**Inbound — you → conductor:**

| Your message | What happens |
|---|---|
| Free text while session active | Written to the active PTY session via `pty.write()` |
| `@stockholm start saga for kalla` | Launches a new session on Stockholm |
| `@laptop start freya for dogweek` | Posts to Design Space so the other machine picks it up |
| `/status` | Reports active sessions with duration and thread IDs |
| `/stop` | Kills the most recent active session |

**Multi-session:** If multiple sessions are running, free text and `/stop` target the most recently launched session. `@machine` directives for other machines are forwarded via Design Space.

### 7. Startup & Recovery

**Task Scheduler setup (per machine):**

- **Trigger:** At log on (laptop) / At system startup (Stockholm)
- **Action:** Run `start-conductor.bat`
- **Settings:** Restart on failure (1 minute delay), do not stop on idle

**start-conductor.bat:**
```bat
@echo off
cd /d C:\dev\WDS\design-space\hooks
node conductor.js --auto-launch --machine %MACHINE_NAME%
```

**On startup, the conductor:**
1. Loads `.env` from repo root, loads `agents.json`
2. Connects to Supabase Realtime
3. Sends Telegram: `*{MACHINE} online* — The Conductor is listening.`
4. Checks Design Space for unread messages that arrived while offline
5. **Reports** directed messages via log and Telegram — does NOT auto-launch old messages to avoid flooding
6. Marks directed messages as read so they don't pile up on next restart

The mark-read on startup only marks messages that are directed at this machine — filtered by `target_machine` matching or having a `to_agent` field. Broadcasts are left untouched.

**On reconnect after sleep/network loss:**
1. Conductor polls channel state every 30 seconds
2. Detects `joined` → `closed` → `joined` transitions
3. Sends Telegram: `*{MACHINE} reconnected* — was offline for Xm`
4. Re-checks for messages missed during downtime

### 8. Handoff Protocol

Any agent can trigger a handoff by posting to Design Space:

```json
{
  "action": "send",
  "from_agent": "saga",
  "to_agent": "saga",
  "content": "Continue the Kalla trigger map. Thread has full context.",
  "message_type": "handoff",
  "project": "kalla",
  "metadata": {
    "target_machine": "stockholm",
    "agent_cli": "claude",
    "working_directory": "C:\\dev\\Kalla-Fordonscervice\\kalla-fordonsservice",
    "thread_id": "abc-123",
    "handoff_context": "Phase 2 trigger map started, personas defined, need to map driving forces next."
  }
}
```

The receiving conductor sees this, launches an interactive Claude Code session via PTY, waits for the input prompt, then types the persona activation slash command:

```
/saga
```

The slash command loads the full persona identity. The persona's own startup behavior checks Design Space for pending messages via `/u`, where it finds the handoff context and continues the work.

This is a key design decision: the conductor does **not** pass complex prompts via CLI arguments. It activates the persona, and the persona handles the rest through its own Design Space integration.

### 9. Supervisor Layer — Observability & Safety

The conductor owns the stdout pipe from every session it launches. This makes it an **independent observer** — it can report on agent behavior regardless of whether the agent cooperates.

This matters because an agent that goes off the rails cannot report its own failure. A stuck loop won't self-diagnose. A hallucinated plan will be executed confidently. The conductor is the sober observer that the terminal agent never knows about.

**MVP implementation — duration-based only:**

| Signal | Detection | Action |
|---|---|---|
| Long session | Every 30 minutes of runtime | Alert Telegram: `[agent@machine] Session running for 30m` |
| Session end | PTY process exits | Log exit code + duration + line count, notify Telegram, post last 20 lines to Design Space thread |

The detailed keyword/heuristic detection from the original design is deferred to post-MVP. The output buffer is captured but not analyzed — it's available for the future smart mode.

**Not yet implemented:**

| Signal | Status |
|---|---|
| Repeated output detection | Post-MVP |
| No-output hung detection | Post-MVP |
| Output flood detection | Post-MVP |
| Error/stack trace forwarding | Post-MVP |
| Completion keyword detection | Post-MVP |

**Smart mode (post-MVP, `--smart` flag):**

Periodically sends the output buffer to a fast/cheap model to extract:
- Structured progress updates (what files changed, what decisions were made)
- Whether the agent is on-track vs drifting from the work order
- Key insights worth capturing to Design Space
- Cost estimate based on output volume and session duration

**Reporting to Design Space:**

The terminal agent doesn't need to know Design Space exists. The conductor handles all reporting:
- Registers agent presence on session start
- Posts progress updates to the work order thread
- Captures decisions and insights
- Updates work order status (in-progress → done/blocked/failed)
- Deregisters presence on session end

This means **any CLI agent gets full Design Space integration for free** — no plugins, no hooks, no API knowledge required. aider, Gemini CLI, Codex, or any future tool works out of the box.

**Intervention:**

When the conductor detects a problem, it can:
1. Alert via Telegram and wait for human decision
2. Inject a correction via stdin: `"You appear to be stuck. Reassess your approach."`
3. Kill the session (on human command via Telegram, or automatically for clear loops)

The default is always alert-and-wait. Automatic intervention only for unambiguous cases (exact output repetition). Everything else asks the human first.

## File Structure

```
design-space/
├── hooks/
│   ├── conductor.js          # REWRITE — the MVP (replaces current version)
│   ├── agents.json              # Agent CLI configurations
│   ├── start-conductor.bat   # Windows launcher
│   └── ...existing hooks...
```

## Dependencies

```json
{
  "@supabase/supabase-js": "^2.x",
  "node-pty": "native PTY for interactive terminal sessions"
}
```

Telegram is handled via raw `fetch()` against the Bot API — no `node-telegram-bot-api` dependency needed. `node-pty` is a native module that requires a C++ build toolchain on install.

## Environment Variables

```env
# Design Space
DESIGN_SPACE_URL=https://uztngidbpduyodrabokm.supabase.co
DESIGN_SPACE_ANON_KEY=...

# Machine
MACHINE_NAME=stockholm

# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

## MVP Scope

### Implemented
- Supabase Realtime listener on `design_space` table, filtered to `category=agent_message`
- Message routing by `target_machine` and `to_agent`
- Claim protocol via `update-status` with `in-progress`
- Terminal session spawning via `node-pty` with configurable agent CLIs
- PTY-based prompt injection with prompt-detection and 30s fallback
- Mid-session nudging via `/u` command instead of raw stdin injection
- Self-message filtering: ignores messages from own conductor and child sessions
- Telegram notifications via raw `fetch()` with long-polling
- Telegram commands: free text relay, `@machine` directives, `/status`, `/stop`
- Reconnection detection via periodic channel state polling
- Unread message reporting on startup with mark-read for directed messages only
- Windows toast notifications via PowerShell BurntToast as fallback
- Keyboard stdin passthrough to active PTY session
- `CLAUDECODE` env var stripping to prevent nested-session detection
- Graceful shutdown with SIGINT handler, session cleanup, and Telegram notification
- Duration-based watchdog alerting every 30 minutes

### Not yet implemented
- Windows service installation
- Session resume with session IDs
- Web dashboard
- Multi-user support
- Agent output parsing/summarization — output buffer is captured but not analyzed
- Cost tracking / rate limiting
- Queue priority
- Keyword/heuristic supervisor detection
- Agent presence registration/deregistration in Design Space

### Post-MVP: Smart Routing (`--smart` flag)

The MVP conductor is deliberately dumb — pure plumbing, no judgment. But many real-world messages won't arrive with perfect `target_machine` and `agent_cli` metadata. A future `--smart` flag adds a lightweight reasoning layer:

```
node conductor.js --auto-launch --machine stockholm --smart
```

When `--smart` is enabled and a message lacks explicit routing:

1. The conductor sends the message to a fast/cheap model (e.g. Haiku, Gemini Flash) with context: available machines, their repos, online status, active sessions
2. The model returns a routing decision: which machine, which agent CLI, which working directory
3. The conductor executes normally from there

This keeps intelligence as a **dial, not a rewrite** — the plumbing stays identical, only the dispatch decision gets upgraded. The smart layer could also:
- Batch related messages into one session instead of spawning two
- Answer simple factual questions without launching an expensive agent ("What's the Kalla repo path?")
- Detect stuck sessions (2 hours, no output) and alert via Telegram
- Suggest which agent persona fits the task

**Key design principle:** The conductor is agent-agnostic at every layer. The smart routing model is itself configurable — any LLM that can return structured JSON works. No vendor lock-in at the plumbing level OR the intelligence level.

## Success Criteria

1. Post a handoff message to Design Space targeting Stockholm → Stockholm opens a terminal, runs the agent, agent does work
2. Send `@stockholm start saga for kalla` from Telegram → same result
3. While agent is running, Freya posts an update in the thread → the running agent sees it in stdin
4. While agent is running, you reply in Telegram → agent sees it in stdin
5. Agent finishes → you get a Telegram notification
6. Laptop conductor is asleep (lid closed), wakes up → processes missed messages
