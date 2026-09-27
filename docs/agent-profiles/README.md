# Agent Profiles

Repo markdown in this folder is the source of truth for scoped agent persona, tone, constraints, and skill content.

## File types

- `kind: instruction`
  - upserts one row in `agent_instructions`
- `kind: skill`
  - upserts one row in `agent_skills`

Both file types can also publish the raw markdown into `repo_files`, so agents can inspect the exact source document in Agent Space.

## Frontmatter

Instruction files:

```md
---
kind: instruction
agent_id: sharif-admin
model_target: claude
skill_level: repo
org_id: whiteport
project: sharif
repo: sharif-webshop
version: 2026-04-11
publish_repo_file: true
repo_file_path: agent-space/instructions/sharif-admin.md
---
```

Skill files:

```md
---
kind: skill
agent_id: sharif-admin
skill_slug: sharif-order-selection
skill_name: Sharif Order Selection
skill_level: repo
org_id: whiteport
project: sharif
repo: sharif-webshop
phase: 1
description: Multi-step order selection for Open Glass.
version: 2026-04-11
publish_repo_file: true
repo_file_path: agent-space/skills/sharif-order-selection.md
---
```

## Sync

Dry run:

```bash
node tools/sync-agent-profiles.js --dry-run
```

Sync all profile files:

```bash
node tools/sync-agent-profiles.js
```

Sync one file:

```bash
node tools/sync-agent-profiles.js --file docs/agent-profiles/sharif/sharif-webshop/instructions/sharif-admin.md
```

## Resolution model

- `agent_instructions` resolve by scope: `wds_default -> org -> client -> project -> repo`
- `agent_skills` resolve by the same scope order
- If multiple skill rows share the same `skill_slug`, the most specific matching scope wins
