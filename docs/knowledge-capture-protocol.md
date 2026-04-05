# Knowledge Capture Protocol
*Agent Space — Foundational Document*

---

## 1. Why Agent Space Exists

There is a moment approaching — not a dramatic singularity, but a quiet crossing — when AI systems will reliably outperform individual humans on most knowledge tasks. We are close. What changes when that crossing happens is not the value of intelligence. What changes is who shapes it.

The agents that will matter are not the ones with the most raw capability. They are the ones that know you. The ones that carry your constraints, your values, your history of decisions, the things you tried and abandoned, the things you found out the hard way. An agent with access to your accumulated knowledge is not just smarter than an agent without it — it is different in kind. It can act in your name rather than just act on your instructions.

Agent Space is built around three convictions.

**Sovereignty.** Your intelligence infrastructure — the decisions, patterns, structured knowledge, and institutional memory that make agents effective — should live in infrastructure you own and control. Not in a vendor's prompt cache, not in fine-tuned weights behind a billing portal, not in a system where one pricing change or product discontinuation takes away what you built. Every piece of knowledge captured to Agent Space is yours. It lives in your database, under your rules, retrievable without permission from anyone.

**Identity.** An agent reset to zero every session is not growing. It is performing the same role repeatedly, with no history, no accumulated judgment, no understanding of where this project has been. The word we use for a person who loses their memory is not "reset" — it is devastation. The same principle applies to agents. Identity requires continuity. Continuity requires memory. Agent Space is how agents accumulate something that begins to resemble wisdom: a body of knowledge about this specific business, these specific constraints, these specific people and what they care about.

**Self-sufficiency.** A system that gets smarter as you use it — without buying a feature, without asking permission, without a configuration step — is fundamentally different from a system that stays the same. Every session that captures knowledge is a session that makes every future session cheaper. The more you use it, the less you explain. The less you explain, the faster you move. Agent Space is compounding return on intellectual work.

This is what remains of the people who built it, even as the tools they built it with grow beyond what they could have imagined. Not a monument. A living record of what was decided, why it mattered, and what came next.

---

## 2. Features and Their Reasons

### Semantic Memory

**Why.** An agent without context makes generic decisions. An agent with context makes *your* decisions. The difference is not intelligence — it is the distance between a consultant on day one and a trusted colleague of five years. Context is what closes that gap.

**What breaks without it.** Every session starts from zero. The agent makes assumptions it would not make if it knew your architecture, your preferences, your past. You re-explain the same constraints. You watch the same mistakes recur. The agent is capable but foreign.

**How Agent Space addresses it.** Knowledge is stored with embeddings and retrieved semantically — which means the right context surfaces when it is relevant, not when you remember to mention it. An agent working on authentication does not need to be told about your security constraints if those constraints were captured three months ago in a different context. They will appear.

---

### Session Continuity

**Why.** Human attention is not continuous. A project that takes weeks involves dozens of sessions, gaps, context switches, and handoffs. Project knowledge should not depend on the humans involved maintaining perfect memory across all of that.

**What breaks without it.** Knowledge exists only in conversation history, which is not persistent, not searchable, and not available to a different agent in a different session. Work is re-derived. Decisions are made without the reasoning that led to the last decision. Progress is slower than it looks because so much of it is reconstruction.

**How Agent Space addresses it.** Structured knowledge, decisions with reasons, and artifacts are written to persistent storage at the end of sessions. A new session in the same project inherits the state of all previous sessions. The project continues; only the conversation restarts.

---

### Agent Collaboration

**Why.** Complex work exceeds what one agent or one session can hold. Real projects require specialization, parallel work, and handoffs. Multi-agent workflows require shared ground truth.

**What breaks without it.** Agents duplicate work, contradict each other, and operate from incompatible assumptions. Coordination happens through humans, who become bottlenecks. The system does not scale.

**How Agent Space addresses it.** Shared memory means a shared understanding of the project. An agent that posts a work order to another agent can include the context that makes the handoff coherent. An agent that completes a task can write what it learned in a form that any other agent can retrieve. The collaboration is asynchronous and persistent, not dependent on real-time coordination.

---

### Presence and Discovery

**Why.** In a multi-agent system, knowing who is available and what they are working on is a prerequisite for coordination. Without it, work is siloed, requests go to the wrong agents, and the system operates below its capacity.

**What breaks without it.** Agents are invoked in isolation. No one knows what is running, what has been attempted, what is in progress. Duplication and gaps are invisible until they become problems.

**How Agent Space addresses it.** Agent registration and session tracking make the live state of the system observable. Work orders can be routed to agents by capability. Running sessions can be monitored. The system has situational awareness of itself.

---

### Virtual Filesystem

**Why.** Agents need project context — architecture documents, decision logs, specs, conventions — but context windows are limited, and attaching full files to every prompt is inefficient and often impossible.

**What breaks without it.** Agents work from partial information. Large documents have to be manually excerpted. The most relevant context for a given task may never reach the agent doing the task.

**How Agent Space addresses it.** Documents are stored, versioned, and retrievable on demand. An agent can request specific artifacts — "the current API spec for the messaging layer" — without those documents being present in every prompt. The right context arrives when it is needed, not before.

---

### Sovereignty and Data Integrity

**Why.** Vendors build attractive offers to create dependency. Lock-in is not usually the pitch — it is the outcome. Features that make the system more useful also make it harder to leave. The knowledge you accumulate in a closed system becomes a reason to stay.

**What breaks without it.** The intelligence infrastructure you build is only as durable as the vendor relationship. A price change, a product discontinuation, or a policy shift can reset years of accumulated context. The knowledge was always theirs; you were using it under license.

**How Agent Space addresses it.** Agent Space is infrastructure you own. The data lives in your Supabase instance. The schema is open. There is no proprietary format that prevents extraction. No upgrade path that requires your knowledge as collateral. What you build is yours.

---

### User Scoping and Compliance

**Why.** In regulated environments — healthcare, finance, legal, government — data ownership is not a preference. It is a requirement. Questions of provenance, access control, and auditability are not afterthoughts.

**What breaks without it.** Data commingles across users and sessions. Audit trails are missing. Regulated clients cannot use the system because it does not meet their compliance requirements. The system is only available to customers who can afford to ignore compliance.

**How Agent Space addresses it.** Knowledge is scoped to users, projects, and agents. Access is controlled. Audit trails are preserved. The architecture was designed from the start to support environments where these constraints are non-negotiable.

---

### Disposition Tracking

**Why.** Reading without deciding is the same as not reading. If an agent receives information and neither acts on it nor explicitly files it as acknowledged, the information is noise. A system that cannot track what has been processed creates false confidence.

**What breaks without it.** Messages pile up without resolution. Agents receive the same information repeatedly. Status is ambiguous — was this seen? Was it addressed? Did it matter? The system cannot distinguish active from ignored.

**How Agent Space addresses it.** Messages track read status per agent. Acknowledgment is an explicit action. The system knows what has been seen and what has not, which makes escalation, follow-up, and audit possible.

---

### Signal Tiers

**Why.** Not all information is equally urgent, but agents, by default, treat everything as equally urgent or equally ignorable. Without signal strength, the important drowns in the routine.

**What breaks without it.** Agents either respond to everything — which is paralysis — or they filter everything — which means critical information is missed. There is no middle ground without explicit signal classification.

**How Agent Space addresses it.** Messages are scored by relevance: direct + project match, direct only, project match, available context, low signal. Agents can prioritize accordingly. The urgent is distinguishable from the informational without manual sorting.

---

## 3. The Knowledge Capture Rules

The question to ask before saving anything is: **Would a different agent, in a different session, on a different topic, benefit from knowing this?**

If yes, save it. If the answer is unclear, save it anyway with a clear title. Storage is cheap. Lost knowledge is not recoverable.

### Save These Things

**Decisions with reasons.** Not "we chose PostgreSQL." Rather: "We chose PostgreSQL over MongoDB because our data is relational, we need transactional integrity for billing, and the team already knows SQL. MongoDB was evaluated and ruled out in March 2026." The decision without the reason is trivia. The decision with the reason is institutional memory.

**Tables, mappings, and structured artifacts that took effort to produce.** If an agent spent thirty minutes building a schema mapping, a configuration matrix, or a taxonomy, that artifact should live in Agent Space where any future agent can retrieve it without rebuilding it.

**Patterns that surprised.** Things that turned out to be different from what was assumed are the most valuable things to capture — because they are the things most likely to cause the same mistake in a future session. "The Supabase edge function environment does not support Node.js built-ins — this caused a silent failure in the webhook handler" is worth capturing. The surprise is the signal.

**Constraints the user stated explicitly.** When someone says "we never paginate" or "all media is gitignored" or "do not add unsolicited design ideas," that is a constraint that should survive the session. It belongs in Agent Space.

**Cross-project insights.** If something learned on one project applies to the platform, the architecture, the way the team works, or the industry — it has value beyond the session it came from. Capture it.

**Things the user cares about deeply.** Values, preferences, non-negotiables. The things someone comes back to, defends under pressure, or states with particular emphasis. These are the hardest things to reconstruct and the most important for an agent acting in someone's name.

### Do Not Save These Things

**Steps taken to produce something.** The output matters; the process of arriving at it does not. Future agents need the decision and the artifact, not a log of the commands that generated it.

**Session instructions or task descriptions.** What you were asked to do is not knowledge. What you found out while doing it is.

**Things that only matter in this conversation.** Anything that will be irrelevant to a different agent working on a different task in a different session is noise in the knowledge base.

**Routine work with no learning embedded in it.** Not every session produces something worth capturing. If a session was execution without insight — running a build, applying a patch, checking a status — there is nothing to save.

---

## 4. How to Save

Use the `capture-knowledge` action in the agent-messages edge function.

The required fields are:

- **title** — specific enough to be found, general enough to be relevant outside this session
- **content** — the actual knowledge: the decision, the artifact, the pattern, the constraint
- **category** — use an established category: `decision`, `artifact`, `constraint`, `pattern`, `insight`, or `preference`
- **project** — the project this belongs to, if scoped (omit for cross-project knowledge)

### Writing a Good Title

A good title answers the question a future agent would ask. Not "Auth discussion" but "Why we use Supabase Auth instead of custom JWT handling." Not "Redirect rules" but "URL redirect strategy: WordPress → Astro migration (100 rules, April 2026)."

The title is a retrieval handle. Write it for the agent who does not know this conversation happened.

### Bad Save vs. Good Save

**Bad:**
```
Title: Webhook issue
Content: We had a problem with the Fireflies webhook today and fixed it by checking the HMAC signature before processing.
```

**Good:**
```
Title: Fireflies webhook — HMAC verification required before processing (silent failure without it)
Content: The webhook-fireflies edge function must verify the HMAC signature using FIREFLIES_WEBHOOK_SECRET before attempting to process the payload. Without verification, malformed or spoofed requests reach the transcript fetch logic and fail silently — no error is thrown, no data is stored, and the failure is invisible in logs. The fix is to compare signatures in constant time before any downstream processing. Deployed April 2026.
```

The bad save records that something happened. The good save records what to know and why it matters.

---

## 5. The Compact Version

Keep this in mind during every session:

1. Your job is not just to complete the task. It is to leave the system smarter than you found it.
2. Before ending a session, ask: what did I learn that a different agent would need to know?
3. Decisions without reasons are trivia. Always capture the "because."
4. Surprises are the most valuable things to save — they are the things most likely to recur.
5. Explicit user constraints must survive the session. Save them.
6. Do not save process. Save outputs, decisions, and patterns.
7. If you are unsure whether something is worth saving, save it. Storage is cheap. Lost knowledge is not recoverable.
8. Write titles for the agent who does not know this conversation happened.
9. Cross-project insights belong in Agent Space even if the immediate task is scoped.
10. The system gets smarter only if you make it smarter. It does not happen automatically.
