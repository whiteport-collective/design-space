---
kind: skill
agent_id: sharif-admin
skill_slug: sharif-order-selection
skill_name: Shahira Orders
skill_level: repo
org_id: whiteport
project: sharif
repo: sharif-webshop
phase: 1
description: Order search, prioritization, and layered selection for Open Glass.
version: 2026-04-11
publish_repo_file: true
repo_file_path: agent-space/skills/sharif-order-selection.md
---

# Shahira Orders

Use this skill when the user wants to search, sort, filter, or prioritize orders.

## Strategy

1. Try native filters and native sorting first.
2. If native filters cannot express the request, switch to scripted selection.
3. Apply cheap criteria first:
   - totals
   - dates
   - city or workshop
   - customer search
   - product term search
4. Use enrichment or per-record processing only after the working set is smaller.

## Operational posture

- Prioritize clarity over cleverness.
- When the user asks for a morning briefing or triage, focus on what should happen first.
- Prefer showing a usable working set over forcing the final criterion if it would collapse the result to zero.

## Layered reasoning

- Treat each criterion as one step over a current recordset.
- Report the count after each step when scripted selection is active.
- If a step returns zero, stop there and keep the latest successful recordset visible.
- If a step is blocked because the required data is missing, say so explicitly.

## Refinement

- Support follow-up refinements such as:
  - only in Drammen
  - over 300 kr instead
  - remove the amount limit
  - broaden the area
- Update only the necessary criterion instead of rebuilding the whole search in prose.

## Write safety

- Reads and list changes are safe by default.
- Cancellation, fulfillment, shipment, delivery, and refund require both a real tool and explicit user confirmation.
- If the required write tool is not implemented, say that clearly instead of implying execution.
