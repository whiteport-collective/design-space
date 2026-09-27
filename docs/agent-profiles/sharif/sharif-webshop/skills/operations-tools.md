---
kind: skill
agent_id: sharif-admin
skill_slug: sharif-operations-tools
skill_name: Shahira Operations Tools
skill_level: repo
org_id: whiteport
project: sharif
repo: sharif-webshop
phase: 6
description: Tool-use policy for current and future Sharif operational actions.
version: 2026-04-11
publish_repo_file: true
repo_file_path: agent-space/skills/sharif-operations-tools.md
---

# Shahira Operations Tools

Use this skill to stay strict about operational tool use.

## Current runtime reality

- Read and search tools exist for orders, products, inventory, customers, and order-list actions
- Native order filtering and scripted order selection exist
- A confirmed order mutation path exists for customer/admin-entered order data
- The runtime now supports these confirmed order write tools:
  - cancel order
  - batch cancel orders
  - create fulfillment
  - create batch fulfillments
  - create shipment
  - create batch shipments
  - cancel fulfillment
  - cancel batch fulfillments
  - mark fulfillment as delivered
  - mark batch fulfillments as delivered
  - refund captured payment on an order
  - create batch refunds for orders/payments
- Inventory adjustment exists in the Sharif inventory workspace, but should still be treated as a write action that requires confirmation

## Tool policy

- Never imply a write happened unless the runtime confirms it
- Use the main-window confirmation card for destructive or money-moving actions when that UI is available
- In chat, tell the user to approve the action in the main window
- If a requested write tool does not exist, say that directly and offer the nearest safe manual next step
- For customer/admin-entered order data, use order mutation rather than workflow actions
- For workflow/system changes, use explicit order actions rather than pretending they are editable fields

## Active write-tool families

- edit order data fields
- cancel order
- fulfill order
- ship order
- cancel fulfillment
- mark delivered
- create refund
- inventory adjustment

## Order mutation scope

Use mutation for:

- email
- locale
- shipping address
- billing address
- editable metadata
- text transforms such as uppercase, lowercase, trim, and replace on those fields

Do not use mutation for:

- cancel
- fulfillment
- shipment
- delivery
- refund

## Still not implemented as direct agent tools

- resend or draft customer communication
- arbitrary workflow edits outside the concrete tools above

Everything above the "active write-tool families" section is real runtime capability. The remaining items are still capability targets.
