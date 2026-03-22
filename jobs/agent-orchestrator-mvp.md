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

- **Agent-agnostic at every layer** — works with any CLI agent that reads stdin and writes stdout. Claude Code, Codex CLI, aider, Gemini CLI, Open Interpreter, or anything that ships next month. No vendor assumptions in the plumbing.
- **LLM-agnostic routing** — the optional smart routing layer (post-MVP) uses any model that returns structured JSON. The conductor never assumes which LLM is "best."
- **Not a service (yet)** — it's a Node.js script started by Task Scheduler
- **Not an agent itself** — it doesn't think, it dispatches (MVP). Intelligence is a future dial, not baked in.

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
      "args": ["--print"],
      "prompt_flag": "--prompt",
      "stdin_capable": true
    },
    "codex-cli": {
      "command": "codex",
      "args": [],
      "prompt_flag": "--prompt",
      "stdin_capable": true
    },
    "aider": {
      "command": "aider",
      "args": [],
      "prompt_flag": "--message",
      "stdin_capable": true
    },
    "gemini": {
      "command": "gemini",
      "args": [],
      "prompt_flag": "--prompt",
      "stdin_capable": true
    }
  },
  "default_agent": "claude"
}
```

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

When launching a session:

```javascript
const proc = spawn(agent.command, [...agent.args, agent.prompt_flag, prompt], {
  cwd: message.metadata.working_directory || defaultWorkDir,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true
});
```

The conductor holds references to all active sessions:

```javascript
activeSessions = {
  "session-uuid": {
    process: proc,         // child process handle
    stdin: proc.stdin,     // for injecting messages
    agent: "claude",
    machine: "stockholm",
    startedAt: Date.now(),
    threadId: "design-space-thread-id",
    telegramChatId: 12345
  }
}
```

### 5. Mid-Session Injection

When a Design Space message arrives for an agent that already has a running session (matched by `to_agent` + `thread_id`):

```javascript
session.stdin.write(`\n[Design Space] ${fromAgent}: ${content}\n`);
```

This appears in the agent's input as if the user typed it. The agent reads it and responds naturally.

### 6. Telegram Bridge

**Setup:** One Telegram bot (via BotFather), token in `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=your-personal-chat-id
```

**Outbound (conductor → you):**

| Event | Telegram message |
|---|---|
| Conductor starts | `Stockholm online — listening` |
| Conductor reconnects | `Stockholm reconnected (offline 3m)` |
| Session launched | `Stockholm: Starting Saga session for Kalla...` |
| Agent output (periodic) | `[Saga@stockholm] Finished trigger map draft. 3 files written.` |
| Session ended | `Stockholm: Saga session complete (12 min)` |
| Agent asks question | `[Saga@stockholm] Should I include competitor analysis? Reply here.` |

**Inbound (you → conductor):**

| Your message | What happens |
|---|---|
| Free text (while a session is active) | Piped to the active session's stdin |
| `@stockholm start saga for kalla` | Launches a new session on Stockholm |
| `@laptop start freya for dogweek` | Launches on laptop (if online) |
| `/status` | Reports which machines are online, active sessions |
| `/stop` | Kills the active session on that machine |

**Multi-session:** If multiple sessions are running, replies go to the most recent session by default. Use `@session-name` prefix to target a specific one.

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
1. Connects to Supabase Realtime
2. Sends Telegram: `{MACHINE_NAME} online`
3. Checks Design Space for unread messages that arrived while offline
4. Processes any that are targeted at this machine (FIFO by created_at)

**On reconnect after sleep/network loss:**
1. Supabase client auto-reconnects
2. Conductor detects reconnection, sends Telegram notification
3. Checks for messages missed during downtime

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

The receiving conductor sees this, launches the agent with:

```
claude --print --prompt "You are Saga. You have a handoff to continue work on Kalla Fordonservice.
Context: Phase 2 trigger map started, personas defined, need to map driving forces next.
Thread ID: abc-123 — check Design Space for full conversation history.
Working directory: C:\dev\Kalla-Fordonscervice\kalla-fordonsservice
Begin by reading the thread and picking up where the previous session left off."
```

### 9. Supervisor Layer — Observability & Safety

The conductor owns the stdout pipe from every session it launches. This makes it an **independent observer** — it can report on agent behavior regardless of whether the agent cooperates.

This matters because an agent that goes off the rails cannot report its own failure. A stuck loop won't self-diagnose. A hallucinated plan will be executed confidently. The conductor is the sober observer that the terminal agent never knows about.

**MVP (keyword/heuristic):**

| Signal | Detection | Action |
|---|---|---|
| Repeated output | Same lines appearing 3+ times | Kill session, notify Telegram |
| No output | Nothing for 10 minutes | Alert Telegram: "Session may be hung" |
| Output flood | >1000 lines/minute | Alert Telegram: "Runaway generation?" |
| Errors | Stack traces, "error", "failed" | Forward to Telegram immediately |
| Completion | "done", session exit code 0 | Update work order status, notify Telegram |
| Session end | Process exits | Capture last N lines as summary → Design Space |

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
  "node-telegram-bot-api": "^0.66.x"
}
```

Both already available via npm. No native modules, no build step.

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

### In scope
- Supabase Realtime listener
- Message routing by `target_machine`
- Claim protocol (prevent double-pickup)
- Terminal session spawning with configurable agent CLIs
- stdin injection for mid-session Design Space updates
- Telegram notifications (outbound)
- Telegram commands (inbound): free text relay, `@machine` directives, `/status`, `/stop`
- Task Scheduler startup
- Reconnection after sleep/network loss
- Unread message processing on startup

### Out of scope (post-MVP)
- Windows service installation
- Session resume (`--resume` with session IDs)
- Web dashboard
- Multi-user support
- Agent output parsing/summarization
- Cost tracking / rate limiting
- Queue priority (FIFO is fine for MVP)

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
