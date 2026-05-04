// create-article v1 — WO-003 Mobile Publishing Pipeline
//
// Creates a new article on a draft branch in whiteport-astro,
// logs to publish_jobs, returns a Cloudflare Pages preview URL.
//
// POST {
//   material:     string       — raw text/transcript from Mårten
//   media_folder: string       — e.g. "Communication/2026-05-03 Title"
//   slug?:        string       — auto-generated if omitted
//   title?:       string       — extracted by Claude if omitted
//   tags?:        string[]
//   excerpt?:     string
//   author?:      string       — defaults to "Mårten Angner"
// }
//
// Required secrets: PUBLISH_SECRET, GITHUB_PAT,
//                   CLOUDFLARE_PAGES_PROJECT (e.g. "whiteport-astro")
// Auto-available:   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GITHUB_API = "https://api.github.com";
const REPO = "whiteport-collective/whiteport-astro";
const BASE_BRANCH = "master";

// ── Helpers ──

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[åä]/g, "a")
    .replace(/ö/g, "o")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

function toBase64(str: string): string {
  return btoa(unescape(encodeURIComponent(str)));
}

function isoDate(): string {
  return new Date().toISOString().split("T")[0];
}

// ── GitHub API ──

async function githubFetch(
  pat: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "whiteport-publish-pipeline/1.0",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok && res.status !== 404 && res.status !== 409 && res.status !== 422) {
    throw new Error(`GitHub ${method} ${path} → ${res.status}: ${await res.text()}`);
  }

  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function getBaseSha(pat: string): Promise<string> {
  const result = await githubFetch(pat, `/repos/${REPO}/git/refs/heads/${BASE_BRANCH}`) as { body: { object: { sha: string } } };
  return result.body.object.sha;
}

async function createBranch(pat: string, slug: string, sha: string): Promise<void> {
  const result = await githubFetch(pat, `/repos/${REPO}/git/refs`, "POST", {
    ref: `refs/heads/draft/${slug}`,
    sha,
  }) as { status: number };

  if (result.status === 422) {
    // Branch already exists — that's fine, we'll update the file
    console.log(`Branch draft/${slug} already exists, reusing.`);
  }
}

async function commitFile(
  pat: string,
  slug: string,
  content: string,
  message: string,
): Promise<void> {
  const branch = `draft/${slug}`;
  const filePath = `/repos/${REPO}/contents/src/content/blog/${slug}.md`;

  // Check if file already exists (need its SHA to update)
  let existingSha: string | undefined;
  const existing = await githubFetch(pat, `${filePath}?ref=${encodeURIComponent(branch)}`) as { status: number; body: { sha?: string } };
  if (existing.status === 200) {
    existingSha = existing.body.sha;
  }

  await githubFetch(pat, filePath, "PUT", {
    message,
    content: toBase64(content),
    branch,
    ...(existingSha ? { sha: existingSha } : {}),
  });
}

// ── Frontmatter ──

function buildMarkdown(params: {
  title: string;
  slug: string;
  excerpt: string;
  tags: string[];
  author: string;
  mediaFolder: string;
  body: string;
}): string {
  const { title, excerpt, tags, author, mediaFolder, body } = params;
  const date = isoDate();
  const tagYaml = tags.map((t) => `  - ${t}`).join("\n");

  return `---
title: "${title.replace(/"/g, '\\"')}"
publishDate: ${date}
draft: false
author: ${author}
excerpt: "${excerpt.replace(/"/g, '\\"')}"
tags:
${tagYaml}
mediaFolder: "${mediaFolder}"
---

${body}
`;
}

// ── Preview URL ──

function previewUrl(slug: string, cfProject: string): string {
  // Branch draft/<slug> → Cloudflare subdomain draft-<slug>.<project>.pages.dev
  const subdomain = `draft-${slug}`.replace(/[^a-z0-9-]/g, "-");
  return `https://${subdomain}.${cfProject}.pages.dev/blog/${slug}/`;
}

// ── Handler ──

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  // Auth
  const secret = Deno.env.get("PUBLISH_SECRET");
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json() as {
      material: string;
      media_folder: string;
      slug?: string;
      title?: string;
      tags?: string[];
      excerpt?: string;
      author?: string;
    };

    const {
      material,
      media_folder,
      title: providedTitle,
      tags: providedTags,
      excerpt: providedExcerpt,
      author = "Mårten Angner",
    } = body;

    if (!material) throw new Error("material is required");
    if (!media_folder) throw new Error("media_folder is required");

    // Required env
    const pat = Deno.env.get("GITHUB_PAT");
    if (!pat) throw new Error("GITHUB_PAT not set");
    const cfProject = Deno.env.get("CLOUDFLARE_PAGES_PROJECT") ?? "whiteport-astro";

    // Supabase client
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Step 1: Use provided article fields. Mårten writes/cleans the article upstream.
    const title = providedTitle ?? `Artikel ${isoDate()}`;
    const slug = body.slug ?? slugify(title);
    const excerpt = providedExcerpt ?? "";
    const tags = providedTags ?? [];
    const articleBody = material;

    const branch = `draft/${slug}`;

    // Step 2: Build markdown
    const markdown = buildMarkdown({ title, slug, excerpt, tags, author, mediaFolder: media_folder, body: articleBody });

    // Step 3: GitHub — create branch + commit file
    const baseSha = await getBaseSha(pat);
    await createBranch(pat, slug, baseSha);
    await commitFile(
      pat,
      slug,
      markdown,
      `draft: add ${slug}`,
    );

    // Step 4: Build preview URL
    const preview = previewUrl(slug, cfProject);

    // Step 5: Log to publish_jobs
    const { data: job, error: dbErr } = await supabase
      .from("publish_jobs")
      .insert({
        slug,
        branch,
        title,
        author,
        media_folder,
        status: "draft",
        material,
        preview_url: preview,
        iterations: [],
      })
      .select("id")
      .single();

    if (dbErr) console.error("publish_jobs insert failed:", dbErr.message);

    return new Response(
      JSON.stringify({
        ok: true,
        slug,
        branch,
        title,
        preview_url: preview,
        job_id: job?.id ?? null,
      }),
      { headers: { ...CORS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
