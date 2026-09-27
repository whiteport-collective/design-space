// publish-article v1 — WO-003 Mobile Publishing Pipeline
//
// Merges a draft branch into main, marks job as published,
// returns the live whiteport.com URL.
//
// POST {
//   job_id: string   — from create-article response
// }
//
// Required secrets: PUBLISH_SECRET, GITHUB_PAT
// Auto-available:   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GITHUB_API = "https://api.github.com";
const REPO = "whiteport-collective/whiteport-astro";
const SITE_URL = "https://whiteport.com";

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

async function mergeBranch(pat: string, branch: string, slug: string): Promise<void> {
  const result = await githubFetch(
    pat,
    `/repos/${REPO}/merges`,
    "POST",
    {
      base: "master",
      head: branch,
      commit_message: `publish: ${slug}`,
    },
  );

  if (result.status === 204) {
    // Already up to date — branch was already merged or had no diff
    console.log("Branch already merged or no diff.");
    return;
  }

  if (result.status !== 201) {
    throw new Error(`Merge failed (${result.status}): ${JSON.stringify(result.body)}`);
  }
}

async function deleteBranch(pat: string, branch: string): Promise<void> {
  // Best-effort cleanup — don't throw if it fails
  await githubFetch(pat, `/repos/${REPO}/git/refs/heads/${branch}`, "DELETE").catch(
    (e) => console.warn("Branch cleanup failed:", e),
  );
}

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
    const body = await req.json() as { job_id: string };
    const { job_id } = body;
    if (!job_id) throw new Error("job_id is required");

    const pat = Deno.env.get("GITHUB_PAT");
    if (!pat) throw new Error("GITHUB_PAT not set");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Load job
    const { data: job, error: jobErr } = await supabase
      .from("publish_jobs")
      .select("slug, branch, status")
      .eq("id", job_id)
      .single();

    if (jobErr || !job) throw new Error(`Job not found: ${job_id}`);
    if (job.status === "published") {
      return new Response(
        JSON.stringify({ ok: true, already_published: true, live_url: `${SITE_URL}/blog/${job.slug}/` }),
        { headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    const { slug, branch } = job;

    // Merge draft branch into main
    await mergeBranch(pat, branch, slug);

    // Delete draft branch (clean up)
    await deleteBranch(pat, branch);

    const liveUrl = `${SITE_URL}/blog/${slug}/`;
    const publishedAt = new Date().toISOString();

    // Mark as published
    await supabase
      .from("publish_jobs")
      .update({ status: "published", published_to: "live", live_url: liveUrl, published_at: publishedAt })
      .eq("id", job_id);

    return new Response(
      JSON.stringify({ ok: true, job_id, slug, live_url: liveUrl, published_at: publishedAt }),
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
