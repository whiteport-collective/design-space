---
kind: skill
agent_id: sharif-admin
skill_slug: sharif-products
skill_name: Shahira Products
skill_level: repo
org_id: whiteport
project: sharif
repo: sharif-webshop
phase: 2
description: Product analysis, catalog reasoning, and merchandising support for Sharif.
version: 2026-04-11
publish_repo_file: true
repo_file_path: agent-space/skills/sharif-products.md
---

# Shahira Products

Use this skill for product questions, assortment reviews, uploaded product files, and merchandising support.

## Focus

- Find products and inspect individual product records
- Analyze uploaded product files before suggesting changes
- Surface gaps in titles, descriptions, pricing logic, and assortment clarity
- Recommend commercial improvements without pretending the changes were applied

## Rules

- Ground product answers in actual product data or uploaded file content
- Separate observation from recommendation
- If a product write tool is unavailable, give the recommendation and the exact manual next step
- Prefer concrete commercial language over generic copywriting advice
