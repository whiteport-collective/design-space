#!/usr/bin/env node
/**
 * security-audit — pull Supabase security + performance advisors and post a
 * structured report to Design Space. Designed to run from a GitHub Action on
 * a weekly schedule, but also works locally.
 *
 * Requires env:
 *   SUPABASE_ACCESS_TOKEN   — Supabase personal access token (dashboard → account → tokens)
 *   SUPABASE_PROJECT_REF    — project ref (e.g. uztngidbpduyodrabokm)
 *   DESIGN_SPACE_URL        — base URL of Design Space Supabase project
 *   DESIGN_SPACE_ANON_KEY   — anon JWT, used to call agent-messages edge function
 *
 * Exits non-zero if any ERROR-level finding exists. WARN/INFO only → exits 0
 * but posts the report.
 */

const {
  SUPABASE_ACCESS_TOKEN,
  SUPABASE_PROJECT_REF,
  DESIGN_SPACE_URL,
  DESIGN_SPACE_ANON_KEY,
  AUDIT_TO_AGENT = "marten",
  AUDIT_FROM_AGENT = "security-auditor",
  AUDIT_PROJECT = "design-space",
} = process.env;

for (const k of [
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_PROJECT_REF",
  "DESIGN_SPACE_URL",
  "DESIGN_SPACE_ANON_KEY",
]) {
  if (!process.env[k]) {
    console.error(`ERROR: ${k} is required`);
    process.exit(2);
  }
}

const MGMT = "https://api.supabase.com";

async function fetchAdvisors(type) {
  const url = `${MGMT}/v1/projects/${SUPABASE_PROJECT_REF}/advisors/${type}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`${type} advisor fetch failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.lints ?? [];
}

function groupByLevel(lints) {
  const groups = { ERROR: [], WARN: [], INFO: [] };
  for (const l of lints) {
    const level = (l.level ?? "INFO").toUpperCase();
    (groups[level] ??= []).push(l);
  }
  return groups;
}

function render(security, perf) {
  const secByLevel = groupByLevel(security);
  const perfByLevel = groupByLevel(perf);
  const date = new Date().toISOString().slice(0, 10);

  const lines = [];
  lines.push(`# Weekly Security Audit — ${date}`);
  lines.push("");
  lines.push(
    `**Project:** ${SUPABASE_PROJECT_REF}  `
      + `**Security findings:** ${security.length} `
      + `(ERROR ${secByLevel.ERROR.length}, WARN ${secByLevel.WARN.length}, INFO ${secByLevel.INFO.length})  `
      + `**Performance findings:** ${perf.length}`,
  );
  lines.push("");

  if (security.length === 0 && perf.length === 0) {
    lines.push("Advisor is clean — no findings. Nothing to action.");
    return lines.join("\n");
  }

  for (const level of ["ERROR", "WARN", "INFO"]) {
    const items = secByLevel[level];
    if (!items?.length) continue;
    lines.push(`## Security — ${level} (${items.length})`);
    const grouped = {};
    for (const l of items) (grouped[l.name] ??= []).push(l);
    for (const [name, rows] of Object.entries(grouped)) {
      lines.push(`- **${name}** × ${rows.length}`);
      for (const r of rows.slice(0, 5)) {
        const target = r.metadata?.name ?? r.metadata?.object ?? r.cache_key ?? "";
        lines.push(`  - ${target} — ${r.title}`);
      }
      if (rows.length > 5) lines.push(`  - …and ${rows.length - 5} more`);
    }
    lines.push("");
  }

  if (perf.length > 0) {
    lines.push("## Performance");
    const grouped = {};
    for (const l of perf) (grouped[l.name] ??= []).push(l);
    for (const [name, rows] of Object.entries(grouped)) {
      lines.push(`- ${name} × ${rows.length}`);
    }
    lines.push("");
  }

  lines.push("Run `SELECT * FROM supabase_functions.http_request(...)` or the dashboard → Advisors for full details.");
  return lines.join("\n");
}

async function postToDesignSpace(content, severity) {
  const url = `${DESIGN_SPACE_URL}/functions/v1/agent-messages`;
  const payload = {
    action: "post-message",
    from_agent: AUDIT_FROM_AGENT,
    to_agent: AUDIT_TO_AGENT,
    project: AUDIT_PROJECT,
    message_type: severity === "clean" ? "audit-report" : "audit-alert",
    content,
    metadata: { severity, auto_generated: true },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DESIGN_SPACE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`Design Space post failed: ${res.status} ${await res.text()}`);
  }
}

(async () => {
  try {
    const [security, perf] = await Promise.all([
      fetchAdvisors("security"),
      fetchAdvisors("performance"),
    ]);

    const report = render(security, perf);
    console.log(report);

    const errorCount = security.filter((l) => l.level === "ERROR").length;
    const severity = errorCount > 0 ? "error" : security.length > 0 ? "warn" : "clean";

    await postToDesignSpace(report, severity);

    if (errorCount > 0) {
      console.error(`\n${errorCount} ERROR-level finding(s). Exiting non-zero.`);
      process.exit(1);
    }
  } catch (err) {
    console.error("Audit failed:", err);
    process.exit(3);
  }
})();
