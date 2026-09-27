// update-article v1 — WO-003 Mobile Publishing Pipeline
//
// Applies Mårten's feedback to a draft article, commits update to the
// same branch, logs iteration, returns new preview URL.
//
// POST {
//   job_id:   string   — from create-article response
//   feedback: string   — e.g. "kortare ingress", "byt rubrik till X"
// }
//
// Required secrets: PUBLISH_SECRET, GITHUB_PAT, ANTHROPIC_API_KEY
// Auto-available:   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GITHUB_API = "https://api.github.com";
const REPO = "whiteport-collective/whiteport-astro";

// ── GitHub ──

async function githubFetch(
  pat: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
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
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function getFileFromBranch(
  pat: string,
  branch: string,
  slug: string,
): Promise<{ content: string; sha: string }> {
  const filePath = `/repos/${REPO}/contents/src/content/blog/${slug}.md`;
  const result = await githubFetch(pat, `${filePath}?ref=${encodeURIComponent(branch)}`);

  if (result.status !== 200) {
    throw new Error(`File not found in branch ${branch}: ${slug}.md`);
  }

  const data = result.body as { content: string; sha: string };
  // GitHub returns base64 with newlines
  const decoded = atob(data.content.replace(/\n/g, ""));
  return { content: decoded, sha: data.sha };
}

async function commitUpdatedFile(
  pat: string,
  branch: string,
  slug: string,
  content: string,
  existingSha: string,
  iteration: number,
): Promise<void> {
  const filePath = `/repos/${REPO}/contents/src/content/blog/${slug}.md`;
  const encoded = btoa(unescape(encodeURIComponent(content)));

  const result = await githubFetch(pat, filePath, "PUT", {
    message: `draft: update ${slug} (iteration ${iteration})`,
    content: encoded,
    branch,
    sha: existingSha,
  });

  if (result.status !== 200 && result.status !== 201) {
    throw new Error(`Failed to commit update: ${JSON.stringify(result.body)}`);
  }
}

// ── Claude ──

async function applyFeedback(
  apiKey: string,
  currentMarkdown: string,
  feedback: string,
): Promise<string> {
  // Separate frontmatter from body
  const fmMatch = currentMarkdown.match(/^(---[\s\S]*?---\n)([\s\S]*)$/);
  const frontmatter = fmMatch ? fmMatch[1] : "";
  const body = fmMatch ? fmMatch[2] : currentMarkdown;

  const prompt = `You are editing a blog article for Mårten Angner at whiteport.com.
Apply the following feedback to the article body. Keep his voice — direct, thoughtful, personal but professional.
Only change what the feedback asks for; preserve everything else.

Feedback: "${feedback}"

Current article body (no frontmatter):
---
${body}
---

Return ONLY the updated article body in markdown. No frontmatter, no explanation, no code block wrappers.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4-7",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);

  const data = await res.json() as { content: { text: string }[] };
  const updatedBody = data.content[0].text.trim();

  return frontmatter + updatedBody + "\n";
}

// ── Handler ──

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const secret = Deno.env.get("PUBLISH_SECRET");
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json() as { job_id: string; feedback: string };
    const { job_id, feedback } = body;

    if (!job_id) throw new Error("job_id is required");
    if (!feedback) throw new Error("feedback is required");

    const pat = Deno.env.get("GITHUB_PAT");
    if (!pat) throw new Error("GITHUB_PAT not set");
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY not set");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Load job from DB
    const { data: job, error: jobErr } = await supabase
      .from("publish_jobs")
      .select("slug, branch, preview_url, iterations, status")
      .eq("id", job_id)
      .single();

    if (jobErr || !job) throw new Error(`Job not found: ${job_id}`);
    if (job.status === "published") throw new Error("Cannot update a published article.");

    const { slug, branch, preview_url, iterations } = job;

    // Fetch current file from GitHub
    const { content: currentMarkdown, sha: fileSha } = await getFileFromBranch(pat, branch, slug);

    // Apply feedback via Claude
    const iterationNum = (iterations as unknown[]).length + 1;
    const updatedMarkdown = await applyFeedback(anthropicKey, currentMarkdown, feedback);

    // Commit to branch
    await commitUpdatedFile(pat, branch, slug, updatedMarkdown, fileSha, iterationNum);

    // Append iteration to DB
    const newIteration = { n: iterationNum, feedback, ts: new Date().toISOString() };
    const { error: updateErr } = await supabase
      .from("publish_jobs")
      .update({
        status: "iterating",
        iterations: [...(iterations as unknown[]), newIteration],
      })
      .eq("id", job_id);

    if (updateErr) console.error("Failed to update publish_jobs:", updateErr.message);

    return new Response(
      JSON.stringify({
        ok: true,
        job_id,
        slug,
        preview_url,
        iteration: iterationNum,
        updated_at: new Date().toISOString(),
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
