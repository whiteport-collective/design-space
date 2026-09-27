#!/usr/bin/env node

import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DEFAULT_DIR = join(REPO_ROOT, "docs", "agent-profiles");
const DS_URL = process.env.DESIGN_SPACE_URL || "https://uztngidbpduyodrabokm.supabase.co";

const args = process.argv.slice(2);
const targetDir = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : DEFAULT_DIR;
const targetFile = args.includes("--file") ? args[args.indexOf("--file") + 1] : null;
const dryRun = args.includes("--dry-run");

loadEnv(join(REPO_ROOT, ".env"));

const anonKey = process.env.DESIGN_SPACE_ANON_KEY;
if (!anonKey) {
  console.error("Missing DESIGN_SPACE_ANON_KEY");
  process.exit(1);
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  const envContent = readFileSync(path, "utf8");
  for (const line of envContent.replace(/\r/g, "").split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function parseFrontmatter(rawContent) {
  const match = rawContent.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { attributes: {}, body: rawContent.trim() };

  const attributes = {};
  for (const line of match[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    attributes[key] = value;
  }

  return {
    attributes,
    body: rawContent.slice(match[0].length).trim(),
  };
}

function hash(content) {
  return createHash("sha256").update(content).digest("hex").substring(0, 12);
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const normalised = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalised)) return true;
  if (["false", "0", "no", "off"].includes(normalised)) return false;
  return fallback;
}

function parseNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNullable(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function findMarkdownFiles(dir) {
  const files = [];

  function walk(current) {
    for (const entry of readdirSync(current)) {
      const fullPath = join(current, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        if (entry === "node_modules" || entry === ".git") continue;
        walk(fullPath);
        continue;
      }
      if (entry.toLowerCase().endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files.sort();
}

function humanizeSlug(slug) {
  return slug
    .split(/[-_/]/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function buildRepoFilePath(filePath, attributes) {
  const configured = toNullable(attributes.repo_file_path);
  if (configured) return configured;
  const relativePath = relative(targetDir, filePath).replace(/\\/g, "/");
  return `agent-space/${relativePath}`;
}

async function api(path, body) {
  const response = await fetch(`${DS_URL}/functions/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

function buildInstructionPayload(filePath, attributes, body) {
  return {
    action: "upsert",
    agent_id: attributes.agent_id,
    model_target: attributes.model_target || "claude",
    skill_level: attributes.skill_level || "repo",
    org_id: attributes.org_id || "whiteport",
    client_id: toNullable(attributes.client_id),
    project: toNullable(attributes.project),
    repo: toNullable(attributes.repo),
    user_id: toNullable(attributes.user_id),
    version: attributes.version || `sha:${hash(body).substring(0, 8)}`,
    content: body,
  };
}

function buildSkillPayload(attributes, body) {
  const skillSlug = attributes.skill_slug || attributes.slug;

  return {
    action: "upsert-skill",
    agent_id: attributes.agent_id,
    skill_slug: skillSlug,
    skill_name: attributes.skill_name || humanizeSlug(skillSlug),
    skill_level: attributes.skill_level || "repo",
    org_id: attributes.org_id || "whiteport",
    client_id: toNullable(attributes.client_id),
    project: toNullable(attributes.project),
    repo: toNullable(attributes.repo),
    version: attributes.version || `sha:${hash(body).substring(0, 8)}`,
    description: toNullable(attributes.description),
    phase: parseNumber(attributes.phase),
    content: body,
  };
}

function buildRepoFilePayload(filePath, rawContent, attributes) {
  const project = toNullable(attributes.project);
  if (!project) return null;

  return {
    action: "put",
    org_id: attributes.org_id || "whiteport",
    project,
    repo: toNullable(attributes.repo),
    path: buildRepoFilePath(filePath, attributes),
    content: rawContent,
    content_type: "text/markdown",
  };
}

function validateProfile(filePath, attributes) {
  const kind = attributes.kind;
  if (!kind) {
    return false;
  }

  if (!["instruction", "skill"].includes(kind)) {
    throw new Error(`${filePath}: frontmatter kind must be "instruction" or "skill"`);
  }

  if (!attributes.agent_id) {
    throw new Error(`${filePath}: frontmatter agent_id is required`);
  }

  if (kind === "instruction") {
    if (!attributes.skill_level) {
      throw new Error(`${filePath}: instruction skill_level is required`);
    }
    return true;
  }

  if (!attributes.skill_slug && !attributes.slug) {
    throw new Error(`${filePath}: skill requires skill_slug or slug`);
  }

  return true;
}

async function syncFile(filePath) {
  const rawContent = readFileSync(filePath, "utf8");
  const { attributes, body } = parseFrontmatter(rawContent);
  if (!validateProfile(filePath, attributes)) {
    return;
  }

  const kind = attributes.kind;
  const publishRepoFile = parseBoolean(attributes.publish_repo_file, true);
  const repoFilePayload = publishRepoFile ? buildRepoFilePayload(filePath, rawContent, attributes) : null;
  const payload = kind === "instruction"
    ? buildInstructionPayload(filePath, attributes, body)
    : buildSkillPayload(attributes, body);

  if (dryRun) {
    console.log(`[dry-run] ${kind} ${filePath}`);
    if (repoFilePayload) {
      console.log(`  repo-file -> ${repoFilePayload.project}/${repoFilePayload.repo || ""}:${repoFilePayload.path}`);
    }
    console.log(`  sync -> ${payload.action} ${payload.agent_id}`);
    return;
  }

  if (repoFilePayload) {
    await api("repo-files", repoFilePayload);
  }

  await api("agent-instructions", payload);
  console.log(`[ok] ${kind} ${relative(REPO_ROOT, filePath).replace(/\\/g, "/")}`);
}

async function main() {
  const files = targetFile
    ? [targetFile]
    : findMarkdownFiles(targetDir);

  if (!files.length) {
    console.log("No profile markdown files found.");
    return;
  }

  console.log(`Syncing ${files.length} agent profile file(s) from ${targetDir}`);
  for (const filePath of files) {
    await syncFile(filePath);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
