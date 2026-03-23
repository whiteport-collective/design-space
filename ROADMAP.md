# Agent Space Roadmap

Current working name: **Design Space** (Whiteport brand)
Future BMad module: **bmad-agent-space**

---

## Completed

### Agent Messaging v21 — Unified Messaging (2026-03-20)
- Everything is a message. Work orders use `message_type: "work-order"`
- Two-phase fetch: direct messages (no limit), everything else (limit 50)
- Own messages filtered from inbox
- Auto-instructions on register (Protocol v3)

### Fireflies → Design Space Integration (2026-03-23)
- Webhook deployed: `webhook-fireflies` edge function
- Transcript chunking with speaker-block preservation (~800 tokens/chunk)
- Duplicate detection + partial write recovery
- Project mapping (title regex + participant email)
- Agent broadcast notification on new transcript
- All 14 historical meetings synced (200+ chunks indexed)
- Audio URL available via API (Pro plan)
- Video requires Business plan — stored in Fireflies if needed

### Design Space Runner — ds.js (2026-03-22/23)
- Agent-agnostic session manager via Supabase Realtime
- node-pty for interactive sessions (full agent UI + stdin/stdout)
- Two activation modes: slash (/saga, /freya) and prompt (Codex, aider)
- Mid-session nudging via /btw for non-interrupting notifications
- Agent name → CLI resolution (codex → codex-cli in agents.json)
- Dead session cleanup, child session filtering
- Content filter: strips terminal UI chrome, posts only agent content
- Session start/end confirmation to Design Space thread
- Periodic progress digest (filtered, every 30s)
- Proven cross-model: Claude (Opus 4.6) and Codex (GPT-5.4) reviewing same code

### Work Order Flow — End-to-End (2026-03-12)
- Codex claimed and delivered work orders for Kalla
- Validated: check-in, claim, spec challenge, build, report back

### Agent Self-Registration (2026-03-17)
- Session-scoped IDs (saga-4894, freya-2567)
- Pronouns stored silently
- Boot message format standardized

---

## Active

### Stabilize ds.js — Merge PRs
- PR #1 from Claude review (bugfixes) — merge into feat/conductor-mvp
- Fix session reply field (thread_id vs message_id)
- Fix Telegram start command agent resolution
- Fix cross-machine handoff routing
- Fix stdin multiplexing for multiple sessions
- Merge feat/conductor-mvp → master
- Branch: `fix/conductor-bugfixes`

### Fireflies Live Transcript — Support Request Pending
- Fireflies confirmed: no live API today, request flagged internally
- Workaround: copy-paste from Live Assist Chrome extension into agent chat
- Ideal: WebSocket/SSE stream of live sentences, or incremental webhook
- Waiting for Fireflies response on beta/design partnership
- When available: agent follows meeting live, surfaces context, flags contradictions

---

## Next

### Dual-Mode Execution
- Interactive (PTY) for sessions where human may interact
- Headless (`codex exec`) for autonomous coding tasks
- ds.js chooses mode based on message context
- Headless output captured and posted to Design Space thread

### Telegram Bridge
- Create bot via BotFather
- Outbound: session start/end, errors, progress
- Inbound: `@stockholm start saga for kalla`, free text relay
- `/status` and `/stop` commands

### Always-On Deployment
- Task Scheduler on Stockholm (at boot)
- Task Scheduler on laptop (at login)
- Auto-reconnect after sleep/network loss
- Cross-machine handoff testing

### Codex app-server Integration
- `codex app-server` exposes structured lifecycle events (JSONL/WebSocket)
- Better than PTY scraping for Codex sessions
- Events: thread/started, item/completed, serverRequest/resolved

### Migrate to `bmad-agent-space` Module
- Create `bmad-agent-space` repo under `bmad-code-org`
- Structure as proper BMad module
- Genericize: configurable `{space_name}`
- WDS expansion adds `recommendedModules: [agent-space]`

---

## Future

### Live Meeting Agent
- Agent consumes real-time meeting transcript (pending Fireflies API or alternative)
- Surfaces context from previous meetings during conversation
- Flags contradictions with existing specs/decisions
- Captures decisions and action items live to Design Space
- Cross-references with design artifacts (specs, wireframes, PRDs)
- Alternative paths: Google Meet Media API, Deepgram streaming, system audio capture

### Smart Routing (`--smart` flag)
- Lightweight LLM (Haiku/Flash) for routing decisions
- Auto-select machine based on repo location
- Auto-select agent based on task type
- Batch related messages into single sessions
- Stuck session detection and alerting

### Multi-Tenant Support
- RLS policies for team-based permissions
- Project isolation: agents only see their project's data

### Social Publishing
- Agent-driven cross-posting from Design Space
- Slack, Discord, LinkedIn integrations

### Dashboard Improvements
- Real-time messenger UI
- Work order board view
- Agent presence indicators
- Mobile-friendly layout

### Paper.design Research
- Figma alternative built on code
- Evaluate for WDS pipeline

---

*Updated: 2026-03-23*
