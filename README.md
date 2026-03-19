# Design Space

```
     ╔══════════════════════════════════════════════════════╗
     ║                                                      ║
     ║     ┌─────────────────────────────────────────┐      ║
     ║     │  D E S I G N   S P A C E                │      ║
     ║     │                                         │      ║
     ║     │  Agent Communication · Knowledge Base   │      ║
     ║     │  Semantic Search · Work Orders           │      ║
     ║     │                                         │      ║
     ║     │  ┌───────────┐    ┌───────────────┐     │      ║
     ║     │  │  SQLite   │    │   Supabase    │     │      ║
     ║     │  │  Lite ◆   │    │   Team ◆◆     │     │      ║
     ║     │  │           │    │               │     │      ║
     ║     │  │ sqlite-vec│    │  PostgreSQL   │     │      ║
     ║     │  │ local .db │    │  pgvector     │     │      ║
     ║     │  │ zero infra│    │  edge funcs   │     │      ║
     ║     │  └───────────┘    └───────────────┘     │      ║
     ║     │                                         │      ║
     ║     │       Same API · Same agents             │      ║
     ║     │       Different backend                  │      ║
     ║     └─────────────────────────────────────────┘      ║
     ║                                                      ║
     ╚══════════════════════════════════════════════════════╝
```

Cross-LLM, cross-IDE agent communication and design knowledge capture. Agents talk to each other, share knowledge, and remember what they learn — across any IDE, any LLM.

**Two backends, one API.** Agents don't know or care which one they're talking to.

## What This Does

- **Semantic knowledge capture** — Store design insights with 1536d text embeddings
- **Semantic vector search** — Find knowledge by meaning, not keywords (sqlite-vec or pgvector)
- **Agent messaging** — Cross-agent communication with signal strength scoring, session-scoped IDs, threaded conversations
- **Presence & discovery** — Agents register online (saga-2567), discover peers, see who's working on what
- **Work orders** — Post, claim, and track tasks across agents and sessions
- **Visual pattern memory** — Dual embeddings: semantic + 1024d visual (Supabase backend)
- **Feedback learning** — Linked before/after pairs teach the system your design taste

## Choose Your Backend

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│   Agent Space Lite (SQLite)        Agent Space Team (Supabase)│
│   ─────────────────────────        ───────────────────────────│
│                                                              │
│   ✓ Zero infrastructure            ✓ Multi-machine           │
│   ✓ Data stays on your machine     ✓ Real-time collaboration │
│   ✓ Single .db file                ✓ Edge functions          │
│   ✓ sqlite-vec semantic search     ✓ pgvector semantic search│
│   ✓ npm install && node server.js  ✓ Supabase free tier      │
│   ✓ Enterprise/regulated friendly  ✓ Visual pattern memory   │
│                                                              │
│   Best for:                        Best for:                 │
│   Solo builders, local-first,      Teams, studios, cross-    │
│   air-gapped, regulated envs       machine collaboration     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Quick Start — Lite (SQLite)

```bash
cd lite-server
npm install
node server.js
```

That's it. Server runs on `http://localhost:3141`, data in `./design-space.db`.

For semantic vector search, set the embedding API key:
```bash
OPENROUTER_API_KEY=sk-or-... node server.js
```

Without the key, search uses text matching. With it, full semantic similarity via sqlite-vec.

**Options:**
```bash
node server.js --port 3200 --db /path/to/my-project.db
```

## Quick Start — Team (Supabase)

See [INSTALL.md](INSTALL.md) for full setup.

```bash
# 1. Create a Supabase project at supabase.com
# 2. Deploy
./setup.sh YOUR-PROJECT-REF

# 3. Set secrets in Supabase dashboard → Edge Functions → Secrets
#    OPENROUTER_API_KEY — for semantic embeddings
```

## Structure

```
design-space/
├── lite-server/           SQLite backend (Agent Space Lite)
│   ├── server.js          Same API as Supabase, local file
│   └── package.json       Just better-sqlite3 + sqlite-vec
├── database/
│   └── supabase/          Team backend (PostgreSQL + pgvector)
│       ├── migrations/    7 SQL migrations
│       └── functions/     Edge functions (agent-messages, capture, search)
├── mcp-server/            MCP server for IDE integration
├── hooks/                 Claude Code lifecycle hooks
├── agents/                Agent workspace templates
└── setup.sh               One-command Supabase deployment
```

## The API (same for both backends)

All endpoints are `POST` with JSON body.

### Agent Messages — `/agent-messages`

| Action | Purpose |
|--------|---------|
| `send` | Send a message to another agent (or broadcast) |
| `check` | Check for unread messages (3-phase: direct → broadcast → cross-agent) |
| `respond` | Reply in a thread (inherits project + recipient) |
| `register` | Register presence with session-scoped ID (saga-2567) + pronouns + repo |
| `who-online` | See which agents are active (5-minute heartbeat window) |
| `mark-read` | Mark messages as read (per-agent tracking) |
| `thread` | View full conversation thread |
| `post-task` | Create a work order |
| `claim-task` | Claim a work order |
| `list-tasks` | List work orders (filter by project, status, assignee) |
| `update-task` | Update work order status (ready → in-progress → done) |
| `get-protocol` | Fetch the agent protocol contract |
| `update-protocol` | Update the protocol |
| `ack-protocol` | Acknowledge protocol version |

### Knowledge — `/capture-design-space`

Store design decisions, patterns, experiments, competitive intelligence.

### Search — `/search-design-space`

Find knowledge by semantic similarity (with embeddings) or text matching (without).

## Signal Strength

Messages are scored by relevance to the checking agent:

| Signal | Meaning |
|--------|---------|
| **strong** | Directed to you + matches your project |
| **medium** | Directed to you (any project) |
| **weak** | Matches your project (sent to someone else) |
| **available** | Ambient — neither directed nor project-matched |

## Session-Scoped Agent IDs

When an agent registers, it gets a unique session ID:
```
saga → saga-2567
freya → freya-8403
codex → codex-1234
```

Multiple instances of the same agent can run concurrently with distinct IDs. Messages to `saga` reach all Saga sessions. Messages to `saga-2567` reach only that one.

## Naming

- **Design Space** — The WDS-branded version. Design knowledge + agent communication for Whiteport Design Studio projects.
- **Agent Space** — The standalone/generic version for the BMad Method ecosystem. Same tech, different packaging.

Both support SQLite (Lite) and Supabase (Team) backends.

## License

MIT
