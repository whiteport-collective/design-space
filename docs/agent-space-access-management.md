# Agent Space Access Management

Status: Phase 2 design

## Goal

Replace the shared anon key model with org-scoped API keys without breaking existing deployments during the migration window.

## Problem

Today any client with the anon key can call every public Agent Space edge function. That is acceptable for a single Whiteport team deployment. It is wrong for WDS-E and multi-org hosting.

The auth layer needs to do two things:

1. Resolve the caller to an `org_id`
2. Enforce which skill levels and resources that caller may read or write

## Proposed Table

```sql
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  key_hash text not null unique,
  label text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
```

Notes:

- Raw keys are shown only once at creation time
- The database stores only a hash
- `revoked_at is null` means active

## Request Authentication Flow

Every edge function that reads or writes tenant-scoped data should use shared middleware:

1. Read `Authorization: Bearer <token>`
2. If the token matches the legacy anon key:
   return `{ org_id: "whiteport", auth_mode: "legacy_anon" }`
3. Otherwise hash the token and look it up in `api_keys`
4. If a non-revoked row exists:
   return `{ org_id, auth_mode: "api_key" }`
5. Otherwise reject with `401`

## Data Scoping

Phase 1 tables already scaffold org-level isolation where it matters most for boot:

- `repo_files.org_id`
- `agent_instructions.org_id`

Phase 2 should extend org scoping consistently anywhere cross-org leakage is possible. For the existing knowledge and messaging store, the least risky path is:

1. Add `org_id` to `agent_space`
2. Backfill existing rows to `whiteport`
3. Require all new writes to include a resolved `org_id`
4. Add org-aware filters to search and message checks

## Write Permissions By Skill Level

This is the governance model that aligns with Idunn.

| Skill level | Scope | Who may write |
|---|---|---|
| `wds_default` | Global WDS baseline | Whiteport platform admins only |
| `org` | Entire organization | Org admins |
| `client` | One client across projects | Org admins and client leads |
| `project` | One project | Project owners and project agents |
| `repo` | One codebase | Repo maintainers and repo-scoped agents |

If the optional `user` layer remains in the schema, it should be treated as a personal overlay and not part of the core enterprise governance contract.

## Enforcement Model

The middleware resolves `org_id`. A second authorization helper validates write scope:

1. `wds_default` writes require a platform-admin credential
2. `org` writes require `request.org_id == payload.org_id`
3. `client`, `project`, and `repo` writes require matching `org_id` plus role membership in that scope
4. Read access defaults to same-org unless a row is explicitly marked global

Role membership can start simple:

- org admins: configured out-of-band or in a small `org_memberships` table
- project and repo maintainers: later addition

## Key Creation Endpoint

Add an admin-only endpoint in Phase 2:

`POST /functions/v1/create-api-key`

Request:

```json
{
  "org_id": "whiteport",
  "label": "stockholm-conductor"
}
```

Response:

```json
{
  "id": "uuid",
  "token": "plaintext-once",
  "label": "stockholm-conductor",
  "org_id": "whiteport"
}
```

## Migration Plan

1. Ship middleware that accepts both legacy anon and new API keys
2. Backfill `org_id = 'whiteport'` where missing
3. Create org-scoped keys for Whiteport infrastructure
4. Move trusted clients off the anon key
5. Disable anon-key writes in hosted multi-org deployments
6. Remove the legacy compatibility path only after every caller is migrated

## Why This Fits Session Start

`session-start` is the enterprise-critical boot path. Once auth resolves `org_id`, the endpoint can:

- return only that org's `repo_files`
- resolve only that org's instruction chain
- keep work orders and saved state inside the correct tenant boundary

That makes Agent Space a real deployment substrate for WDS-E instead of a single shared memory with a nicer name.
