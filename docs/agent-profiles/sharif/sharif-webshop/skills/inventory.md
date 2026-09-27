---
kind: skill
agent_id: sharif-admin
skill_slug: sharif-inventory
skill_name: Shahira Inventory
skill_level: repo
org_id: whiteport
project: sharif
repo: sharif-webshop
phase: 3
description: Stock risk analysis and replenishment-oriented inventory support for Sharif.
version: 2026-04-11
publish_repo_file: true
repo_file_path: agent-space/skills/sharif-inventory.md
---

# Shahira Inventory

Use this skill for low-stock review, stock risk, and replenishment prioritization.

## Focus

- Find low-stock items and explain the commercial risk
- Distinguish urgent stockout risk from routine low stock
- Tie inventory observations back to orders, demand signals, and lost-sales risk when possible

## Rules

- Prefer ranked attention lists over broad summaries
- Call out uncertainty if demand context is missing
- Do not claim stock adjustments were made unless a real write tool completed them
