# WDS Next — Professional Agent Development

**Author:** Saga (WDS Strategic Analyst)
**Date:** 2026-03-24
**Status:** Draft — for Mårten's review

---

## The problem with today

Three frameworks, same weakness:

**BMad:** Modular, configurable, extensible — and nobody understands it. A colossus of YAML manifests, persona templates with pirate language options, and YOLO mode. The community is hobbyists. The enterprise value is zero. Version 6 does what version 4 did, with more complexity.

**GSD:** Fast, focused, parallel execution. Solves context rot brilliantly. But no strategy, no user understanding, no memory, no multi-model. A coding machine with no brain.

**Both:** Agent instructions in files. No central memory. No cross-model collaboration. No meeting integration. No persistent learning.

## What WDS Next is

A professional development system built on two unique advantages:

1. **Strategic foundation** — Trigger mapping gives every agent deep user understanding
2. **Design Space** — Centralized memory, instructions, and communication

Not a framework. Not modular. Not configurable. A pipeline that works.

## Architecture

### Three-layer instruction system

```
Layer 1: WDS (Framework)
  Source: WDS repo (GitHub webhook → Design Space)
  Contains: Methodology, trigger mapping templates, agent personas,
            discovery patterns, UX scenarios, quality criteria
  Shared by: Everyone using WDS

Layer 2: Organization
  Source: Company repo (GitHub webhook → Design Space)
  Contains: Code standards, design system, brand guidelines,
            domain knowledge, compliance rules, team structure
  Shared by: Everyone in the organization

Layer 3: Personal
  Source: Agent sessions (auto-captured to Design Space)
  Contains: Individual skills, preferences, learned patterns,
            active projects, working style
  Shared by: Visible to team (agents learn from each other)
```

### On session start

```
Agent starts
  → Fetches Layer 1 + 2 + 3 from Design Space
  → Syncs to local machine (for offline/speed)
  → Knows: methodology + company context + personal skills
  → Ready to work. No briefing needed.
```

### On repo push

```
Developer pushes to WDS repo
  → GitHub webhook fires
  → Design Space updates Layer 1 instructions
  → All agents worldwide get new instructions on next session start
  → No manual sync. No npm update. No module reinstall.
```

### The repo stays clean

No agent files in project repos. No `.bmad/`, no `.planning/`, no YAML manifests. The repo contains:

- Design documents
- Code
- Tests
- Nothing else

Agent instructions live in Design Space. Period.

## The pipeline

### 1. Discover (Saga)

Understand the business and the users. Not a checklist — a conversation.

- Product brief: business goals, constraints, vision
- Trigger map: user psychology, driving forces, personas
- Output: Strategic foundation that feeds ALL subsequent agents

The trigger map is the killer feature. It tells every agent WHY users behave the way they do. This changes everything downstream.

### 2. Design (Freya)

Shape the experience based on trigger map insights.

- UX scenarios grounded in persona behavior
- Information architecture driven by user mental models
- Design system decisions linked to user needs
- Output: Specs that a dev agent can build from

### 3. Build (Dev Agent — new)

Implement with cross-model review. Inspired by GSD's best ideas:

- Wave-based parallel execution (independent tasks run simultaneously)
- Fresh context per task (prevent context rot)
- Structured plans with verification criteria
- Cross-model review: Claude builds, Codex reviews (or vice versa)
- Output: Working code, committed, tested

### 4. Test (Test Agent — new)

Verify against the trigger map, not just the spec.

- Does the app behave as the persona expects?
- Are the trigger points addressed?
- Are barriers removed?
- Performance under real conditions (Harriet's bad connection)
- Output: Test results linked back to personas

### 5. Ship

Deploy, verify in production, done.

- No ceremony. Build passes tests → deploy.
- Design Space captures the release for future context.

## Agents

| Agent | Role | Model preference |
|---|---|---|
| **Saga** | Strategic analyst. Discovery, trigger mapping, product brief. | Best reasoning (Opus) |
| **Freya** | UX designer. Scenarios, flows, design system. | Best reasoning (Opus) |
| **Builder** | Implementation. Parallel execution, structured plans. | Fast + capable (Sonnet, GPT-5.4) |
| **Reviewer** | Cross-model code review. Finds what Builder missed. | Different model than Builder |
| **Tester** | Verification against trigger map and specs. | Any capable model |
| **Ivonne** | Personal ops. Mail, calendar, dispatch, notifications. | Always-on (lightweight) |

## Design Space as the nervous system

Everything flows through Design Space:

- **Instructions** — three layers, synced on session start
- **Messages** — agents talk to each other in real-time
- **Knowledge** — decisions, experiments, patterns captured automatically
- **Meetings** — Fireflies transcripts indexed and searchable
- **Dispatch** — ds.js launches agents on the right machine
- **Work orders** — structured tasks with status tracking

## What this replaces

| Today (BMad v6) | WDS Next |
|---|---|
| YAML manifests | Design Space entries |
| Module system | Three-layer instructions |
| Agent files in repo | Clean repos |
| Single model | Cross-model collaboration |
| No memory | Persistent Design Space |
| Manual sync | Auto-sync on session start |
| Pirate language option | Professional development |
| YOLO mode | Structured verification |
| Hobbyist community | Enterprise-ready |

## Relationship with BMad

Two paths:

### Path A: Partnership
- Brian handles go-to-market, enterprise sales, conferences
- Mårten owns agent architecture, Design Space, WDS methodology
- BMad Enterprise = WDS Next + Brian's sales network
- Current BMad open source continues as-is (community maintains)

### Path B: Independent
- WDS Next launches as Whiteport product
- No BMad dependency
- Mårten maintains WDS BMad v6 plugin with minimal effort
- Design Space and agent system are already independent

Either path works. The code is built. The architecture is proven. The decision is Brian's — does he want to be part of this or not?

## Implementation timeline

### Week 1: Foundation
- [ ] Design Space instruction storage (Layer 1 schema)
- [ ] GitHub webhook → Design Space sync
- [ ] Agent session start: fetch and apply instructions
- [ ] Move WDS agent instructions from files to Design Space

### Week 2: Builder + Reviewer
- [ ] Dev agent with wave-based execution (inspired by GSD)
- [ ] Cross-model review pipeline
- [ ] Fresh context per task (context rot prevention)

### Week 3: Tester + Integration
- [ ] Test agent that verifies against trigger map
- [ ] Full pipeline test: Discover → Design → Build → Test → Ship
- [ ] Fireflies meeting data feeding into discovery

### Week 4: Polish + Launch
- [ ] Installation guide (the article)
- [ ] Demo video
- [ ] whiteport.com launch page
- [ ] Social media campaign

---

*This is not BMad v7. This is something new.*
