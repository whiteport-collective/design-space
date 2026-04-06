# WDS 1.0 — Professional Agentic Development

**Author:** Saga (WDS Strategic Analyst)
**Date:** 2026-03-24
**Status:** Draft

---

## What is WDS 1.0?

Four agents. Four phases. One shared brain. Fully autonomous.

WDS 1.0 is a professional development system where AI agents collaborate to take a product from strategy to market — and keep it there. No framework overhead. No module system. No YAML manifests. No pirate language.

Strategy → Design → Development → Validate → repeat.

---

## The four phases

### 1. STRATEGY — Saga

*From business goal to user understanding.*

- Product brief: vision, constraints, goals, stakeholders
- Trigger mapping: user psychology, driving forces, personas, barriers
- Document stack: the strategic foundation that feeds all agents

**Why it matters:** Every other framework skips this. GSD jumps straight to code. BMad has templates but no depth. WDS starts with WHY — why do users behave the way they do? The trigger map is the competitive advantage that flows through every subsequent phase.

**Output:** Product brief, trigger map with personas, strategic document stack.

### 2. DESIGN — Freya

*From user understanding to experience specification.*

- UX scenarios grounded in trigger map personas
- Information architecture driven by user mental models
- Interaction design based on driving forces and barriers
- Design system decisions linked to real user needs

**Why it matters:** Design decisions are traceable to specific user triggers. Not "we think a modal works here" but "Harriet needs immediate confirmation because her trust barrier is high."

**Output:** UX scenarios, specifications, design system, interaction flows.

### 3. DEVELOPMENT — Mimir

*From specification to working product.*

- PRD: solution architecture based on Freya's specifications
- Development plan: structured tasks with verification criteria
- Implementation: wave-based parallel execution, cross-model review
- Testing: automated + agentic evaluation against trigger map
- Ship: deploy when tests pass

**Why it matters:** Mimir doesn't just build — he builds with context. The trigger map tells him WHY each feature exists. Cross-model review (Claude builds, Codex reviews) catches bugs neither alone would find.

**Output:** Working, tested, deployed code.

### 4. VALIDATE — Idunn

*From deployment to real-world learning.*

- Deploy and monitor: uptime, performance, errors
- Usability testing: does the product match trigger map predictions?
- User feedback: collect, analyze, route to the right agent
- Measure: conversion, engagement, satisfaction against hypotheses
- Dispatch: send work orders back to Saga, Freya, or Mimir
- Iterate: the lean loop — build, measure, learn, repeat

**Why it matters:** Idunn is the connection to reality. She watches the product in the wild 24/7. She's the only agent that faces outward — monitoring, collecting feedback, communicating with the external world. When something needs to change, she dispatches it.

**Output:** Validation data, work orders, iteration cycles.

---

## The agents

| Agent | Phase | Role | Faces |
|---|---|---|---|
| **Saga** | Strategy | Strategic analyst. Understands users and business. | Inward |
| **Freya** | Design | UX designer. Shapes the experience. | Inward |
| **Mimir** | Development | Builder. Architects and codes. | Inward |
| **Idunn** | Validate | Quality guardian. Monitors, validates, dispatches. | Outward |

Saga, Freya, and Mimir work **inward** — building the product.
Idunn works **outward** — watching the real world and driving the next cycle.

### Idunn as always-on agent

Idunn can be deployed as an Open Claw (always-on autonomous agent):

- Monitors deployed sites and services
- Receives user feedback (forms, email, chat, support tickets)
- Runs usability tests against trigger map personas
- Measures hypotheses from the strategy phase
- Dispatches work orders: "Saga, landing page conversion is 2%, investigate" or "Mimir, 500 error on checkout, fix now"
- Communicates with external systems — APIs, webhooks, monitoring tools
- Reports status via Telegram or other channels

---

## Design Space — the shared brain

Everything flows through Design Space:

### Three-layer instruction system

```
Layer 1: WDS (Framework)
  Source: WDS repo → GitHub webhook → Design Space
  Contains: Methodology, trigger mapping, agent personas, quality criteria
  Updated: When WDS repo is pushed

Layer 2: Organization
  Source: Company repo → GitHub webhook → Design Space
  Contains: Code standards, design system, brand, domain knowledge
  Updated: When company repo is pushed

Layer 3: Personal
  Source: Agent sessions → auto-captured
  Contains: Skills, preferences, learned patterns, project context
  Updated: Every session
```

### On every session start

```
Agent starts
  → Fetches Layer 1 (WDS methodology)
  → Fetches Layer 2 (company context)
  → Fetches Layer 3 (personal skills + project history)
  → Ready to work. No briefing. No context pasting.
```

### What Design Space holds

- **Instructions** — three layers, auto-synced
- **Knowledge** — decisions, experiments, patterns
- **Messages** — agent-to-agent communication, work orders
- **Meetings** — Fireflies transcripts, indexed and searchable
- **Trigger maps** — the strategic foundation, accessible to all agents
- **Validation data** — metrics, feedback, test results

### The repo stays clean

No agent files in project repos. No `.bmad/`. No `.planning/`. No YAML.

The repo contains:
- Design documents
- Code
- Tests
- Nothing else

---

## The trigger map advantage

This is what separates WDS from every other framework:

| Phase | Without trigger map | With trigger map |
|---|---|---|
| **Strategy** | "What should we build?" | "Why does Harriet abandon checkout at step 3?" |
| **Design** | "What pages do we need?" | "Harriet needs reassurance here — her trust barrier is high" |
| **Development** | "Implement the spec" | "Harriet has poor connectivity — optimize for offline first" |
| **Validate** | "Does it work?" | "Does Harriet complete checkout now? What's her drop-off?" |

The trigger map creates a golden thread from strategy through to validation. Every decision is traceable to a real user need. Every test validates a real hypothesis.

---

## Why enterprises want this

### 1. Strategic decisions based on evidence, not gut feeling
The trigger map forces the organization to understand users before a line of code is written. Every decision traces to a real user need. No more "we think the customer wants..."

### 2. Knowledge stays when people leave
Design Space owns the context — not the person. The consultant leaves, the knowledge stays. New team member day 1: the agent already knows everything.

### 3. Quality through cross-model review
Two models find more bugs than one. Proven: 5 + 4 bugs in the same code, found by different models. Human code review costs hours. Agentic review costs seconds.

### 4. Continuous validation, not just at release
Idunn monitors 24/7. User feedback → automatic dispatch → fix. Not quarterly retrospectives — real-time.

### 5. Scale without headcount
Four agents. Unlimited projects. Same methodology, same quality. New project = new trigger map, not a new team.

### 6. Vendor independent
Not locked to Claude, GPT, or Gemini. Design Space works with all models. Switch tomorrow — the process stays the same.

### 7. Full traceability
Every decision, every meeting, every design choice — indexed and searchable. Audit, compliance, onboarding — everything lives in Design Space.

### 8. From slot machine to production line
Single-prompt AI is pulling a lever and hoping. WDS 1.0 is a professional pipeline where agents remember, collaborate, challenge each other, and deliver verified results.

---

## What this replaces

| Today | WDS 1.0 |
|---|---|
| Agent instructions in files | Design Space (three-layer, auto-sync) |
| Single model, single session | Cross-model collaboration |
| No memory between sessions | Persistent Design Space |
| Manual briefing every session | Agents know everything at start |
| No user understanding | Trigger map in every phase |
| Test against spec | Validate against real users |
| Ship and forget | Idunn monitors, dispatches, iterates |
| Framework overhead | Four phases, four agents, done |
| YOLO mode | Professional verification |

---

## Implementation

### Phase 1: Foundation (Week 1-2)
- Design Space instruction storage (three-layer schema)
- GitHub webhook → Design Space sync for Layer 1 and 2
- Agent session start: fetch and apply instructions
- Move Saga and Freya instructions to Design Space

### Phase 2: Development agent (Week 3)
- Mimir agent with wave-based execution
- Cross-model review pipeline
- PRD → Development plan → Code → Test
- Fresh context per task (context rot prevention from GSD)

### Phase 3: Validation agent (Week 4)
- Idunn as always-on monitor
- Usability testing framework against trigger map
- Feedback collection and routing
- Work order dispatch back to other agents

### Phase 4: Full cycle test (Week 5)
- End-to-end: Strategy → Design → Development → Validate
- Real project (Kalla or RightsTrak)
- Measure: time, quality, coverage vs manual process

### Phase 5: Launch (Week 6)
- whiteport.com product page
- Installation guide (the article)
- Demo video
- Social media campaign
- Enterprise pitch deck

---

## Relationship with BMad

WDS 1.0 is not BMad v7. It's independent.

Options for Brian:
- **Partner:** Brian handles enterprise sales and conferences. Mårten owns agent architecture and WDS methodology. BMad Enterprise = WDS 1.0.
- **Independent:** WDS 1.0 launches as a Whiteport product. Mårten maintains WDS BMad v6 plugin separately with minimal effort.

The code is built. The architecture is proven. Design Space works today.

---

*WDS 1.0 — Four agents. Four phases. One shared brain.*
*Strategy → Design → Development → Validate → repeat.*
