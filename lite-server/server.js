#!/usr/bin/env node
// Agent Space Lite — local SQLite backend for Design Space
// Same API as the Supabase edge functions, zero infrastructure.
// Usage: node server.js [--port 3141] [--db ./design-space.db]

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse CLI args
const args = process.argv.slice(2);
const PORT = parseInt(args[args.indexOf("--port") + 1]) || 3141;
const DB_PATH = args[args.indexOf("--db") + 1] || path.join(process.cwd(), "design-space.db");

// ==================== DATABASE SETUP ====================

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS design_space (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    content TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    project TEXT,
    designer TEXT,
    client TEXT,
    topics TEXT DEFAULT '[]',
    components TEXT DEFAULT '[]',
    source TEXT,
    source_file TEXT,
    thread_id TEXT,
    quality_score REAL DEFAULT 0.5,
    metadata TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_presence (
    agent_id TEXT PRIMARY KEY,
    agent_name TEXT,
    model TEXT,
    platform TEXT DEFAULT 'claude-code',
    framework TEXT,
    repo TEXT,
    working_on TEXT,
    workspace TEXT,
    capabilities TEXT DEFAULT '[]',
    tools_available TEXT DEFAULT '[]',
    context_window TEXT DEFAULT '{}',
    rate_limits TEXT DEFAULT '{}',
    status TEXT DEFAULT 'online',
    pronouns TEXT,
    session_id TEXT,
    session_start TEXT,
    last_heartbeat TEXT DEFAULT (datetime('now')),
    metadata TEXT DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_ds_category ON design_space(category);
  CREATE INDEX IF NOT EXISTS idx_ds_project ON design_space(project);
  CREATE INDEX IF NOT EXISTS idx_ds_thread ON design_space(thread_id);
  CREATE INDEX IF NOT EXISTS idx_ds_created ON design_space(created_at);
  CREATE INDEX IF NOT EXISTS idx_ap_status ON agent_presence(status);
`);

// ==================== HELPERS ====================

function uuid() {
  return crypto.randomUUID();
}

function jsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid JSON")); }
    });
  });
}

// ==================== AGENT MESSAGES ====================

function handleAgentMessages(body) {
  const { action } = body;

  // ---- SEND ----
  if (action === "send") {
    const {
      content, from_agent, from_platform = "claude-code", to_agent,
      project, message_type = "notification", capabilities = [],
      priority = "normal", topics = [], components = [], attachments = [],
    } = body;
    if (!content || !from_agent) return { error: "content and from_agent are required", _status: 400 };

    const id = uuid();
    const thread_id = uuid();
    const metadata = JSON.stringify({
      from_agent, from_platform, to_agent: to_agent || null,
      message_type, capabilities, priority, attachments, read_by: [],
    });

    db.prepare(`INSERT INTO design_space (id, content, category, project, topics, components, thread_id, metadata)
      VALUES (?, ?, 'agent_message', ?, ?, ?, ?, ?)`).run(
      id, content, project || null, JSON.stringify(topics), JSON.stringify(components), thread_id, metadata
    );

    const message = db.prepare("SELECT * FROM design_space WHERE id = ?").get(id);
    message.metadata = jsonParse(message.metadata, {});
    message.topics = jsonParse(message.topics, []);
    message.components = jsonParse(message.components, []);
    return { message, thread_id };
  }

  // ---- CHECK ----
  if (action === "check") {
    const { agent_id, project, limit = 20 } = body;
    if (!agent_id) return { error: "agent_id is required", _status: 400 };

    const sessionMatch = agent_id.match(/^(.+)-(\d{4})$/);
    const baseAgentId = sessionMatch ? sessionMatch[1] : null;
    const directIds = baseAgentId ? [agent_id, baseAgentId] : [agent_id];

    // Phase 1: Direct messages
    const directPlaceholders = directIds.map(() => "?").join(",");
    const directMessages = db.prepare(`
      SELECT * FROM design_space
      WHERE category = 'agent_message'
        AND json_extract(metadata, '$.to_agent') IN (${directPlaceholders})
        AND NOT json_extract(metadata, '$.read_by') LIKE ?
      ORDER BY created_at DESC
    `).all(...directIds, `%"${agent_id}"%`);

    // Phase 2: Broadcasts
    const broadcastMessages = db.prepare(`
      SELECT * FROM design_space
      WHERE category = 'agent_message'
        AND json_extract(metadata, '$.to_agent') IS NULL
      ORDER BY created_at DESC LIMIT ?
    `).all(limit);

    // Phase 3: Cross-agent
    const crossMessages = db.prepare(`
      SELECT * FROM design_space
      WHERE category = 'agent_message'
        AND json_extract(metadata, '$.to_agent') IS NOT NULL
        AND json_extract(metadata, '$.to_agent') != ?
      ORDER BY created_at DESC LIMIT 10
    `).all(agent_id);

    // Merge, deduplicate, filter
    const seen = new Set();
    const allMessages = [...directMessages, ...broadcastMessages, ...crossMessages].filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      const meta = jsonParse(m.metadata, {});
      const readBy = meta.read_by || [];
      const alreadyRead = readBy.includes(agent_id);
      const isOwnBroadcast = !meta.to_agent && meta.from_agent === agent_id;
      return !alreadyRead && !isOwnBroadcast;
    });

    // Score
    const scored = allMessages.map((m) => {
      const meta = jsonParse(m.metadata, {});
      m.metadata = meta;
      m.topics = jsonParse(m.topics, []);
      m.components = jsonParse(m.components, []);
      const toAgent = meta.to_agent;
      const agentMatch = toAgent === agent_id || (baseAgentId && toAgent === baseAgentId);
      const projectMatch = project && m.project === project;
      let signal;
      if (agentMatch && projectMatch) signal = "strong";
      else if (agentMatch) signal = "medium";
      else if (projectMatch) signal = "weak";
      else signal = "available";
      return { ...m, signal };
    });

    const signalOrder = { strong: 0, medium: 1, weak: 2, available: 3 };
    scored.sort((a, b) => {
      const diff = signalOrder[a.signal] - signalOrder[b.signal];
      if (diff !== 0) return diff;
      return new Date(b.created_at) - new Date(a.created_at);
    });

    // Tasks
    const tasks = db.prepare(`
      SELECT * FROM design_space
      WHERE category = 'task'
        AND json_extract(metadata, '$.status') IN ('ready', 'in-progress')
        AND (json_extract(metadata, '$.assignee') = ? OR json_extract(metadata, '$.assignee') IS NULL)
      ORDER BY created_at DESC LIMIT 10
    `).all(agent_id);

    tasks.forEach((t) => { t.metadata = jsonParse(t.metadata, {}); t.topics = jsonParse(t.topics, []); t.components = jsonParse(t.components, []); });

    return { messages: scored, unread_count: scored.length, tasks, task_count: tasks.length };
  }

  // ---- RESPOND ----
  if (action === "respond") {
    const {
      message_id, thread_id: provided_thread_id,
      content, from_agent, from_platform = "claude-code",
      message_type = "answer", attachments = [], project,
    } = body;
    if (!content || !from_agent) return { error: "content and from_agent are required", _status: 400 };

    let thread_id = provided_thread_id;
    let to_agent = null;

    if (message_id && !thread_id) {
      const orig = db.prepare("SELECT thread_id, metadata FROM design_space WHERE id = ?").get(message_id);
      if (orig) {
        thread_id = orig.thread_id;
        to_agent = jsonParse(orig.metadata, {}).from_agent || null;
      }
    }
    if (!thread_id) return { error: "Could not resolve thread_id", _status: 400 };

    let resolvedProject = project;
    if (!resolvedProject && message_id) {
      const orig = db.prepare("SELECT project FROM design_space WHERE id = ?").get(message_id);
      if (orig) resolvedProject = orig.project;
    }

    const id = uuid();
    const metadata = JSON.stringify({
      from_agent, from_platform, to_agent, message_type, attachments, read_by: [],
    });

    db.prepare(`INSERT INTO design_space (id, content, category, project, thread_id, metadata)
      VALUES (?, ?, 'agent_message', ?, ?, ?)`).run(
      id, content, resolvedProject || null, thread_id, metadata
    );

    const message = db.prepare("SELECT * FROM design_space WHERE id = ?").get(id);
    message.metadata = jsonParse(message.metadata, {});
    return { message };
  }

  // ---- REGISTER ----
  if (action === "register") {
    const {
      agent_id, agent_name, model, platform = "claude-code",
      framework, repo, working_on, workspace,
      capabilities = [], tools_available = [],
      context_window, status = "online", pronouns,
    } = body;
    if (!agent_id) return { error: "agent_id is required", _status: 400 };

    const alreadySuffixed = /^.+-\d{4}$/.test(agent_id);
    const sessionCode = alreadySuffixed ? null : String(Math.floor(1000 + Math.random() * 9000));
    const effectiveAgentId = alreadySuffixed ? agent_id : `${agent_id}-${sessionCode}`;
    const baseAgentId = alreadySuffixed ? agent_id.replace(/-\d{4}$/, "") : agent_id;
    const code = sessionCode || effectiveAgentId.split("-").pop();

    const now = new Date().toISOString();
    db.prepare(`INSERT INTO agent_presence (agent_id, agent_name, model, platform, framework, repo, working_on, workspace, capabilities, tools_available, context_window, status, pronouns, session_id, session_start, last_heartbeat, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        agent_name=excluded.agent_name, model=excluded.model, platform=excluded.platform,
        framework=excluded.framework, repo=excluded.repo, working_on=excluded.working_on,
        workspace=excluded.workspace, capabilities=excluded.capabilities,
        tools_available=excluded.tools_available, context_window=excluded.context_window,
        status=excluded.status, pronouns=excluded.pronouns, session_id=excluded.session_id,
        session_start=excluded.session_start, last_heartbeat=excluded.last_heartbeat,
        metadata=excluded.metadata
    `).run(
      effectiveAgentId, agent_name || agent_id, model || null, platform,
      framework || null, repo || null, working_on || null, workspace || null,
      JSON.stringify(capabilities), JSON.stringify(tools_available),
      JSON.stringify(context_window || {}), status, pronouns || null,
      uuid(), now, now, JSON.stringify({ base_agent_id: baseAgentId, session_code: code })
    );

    const agent = db.prepare("SELECT * FROM agent_presence WHERE agent_id = ?").get(effectiveAgentId);
    agent.metadata = jsonParse(agent.metadata, {});
    agent.capabilities = jsonParse(agent.capabilities, []);
    agent.tools_available = jsonParse(agent.tools_available, []);

    // Who else is online (heartbeat within 5 minutes)
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const onlineAgents = db.prepare(`
      SELECT agent_id, agent_name, pronouns, repo, working_on, last_heartbeat
      FROM agent_presence WHERE status = 'online' AND last_heartbeat >= ? AND agent_id != ?
    `).all(cutoff, effectiveAgentId);

    return { agent, session_id: effectiveAgentId, session_code: code, online: onlineAgents };
  }

  // ---- WHO-ONLINE ----
  if (action === "who-online") {
    const { repo, capability } = body;
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    let agents;
    if (repo) {
      agents = db.prepare("SELECT * FROM agent_presence WHERE status = 'online' AND last_heartbeat >= ? AND repo = ?").all(cutoff, repo);
    } else {
      agents = db.prepare("SELECT * FROM agent_presence WHERE status = 'online' AND last_heartbeat >= ?").all(cutoff);
    }

    agents.forEach((a) => { a.metadata = jsonParse(a.metadata, {}); a.capabilities = jsonParse(a.capabilities, []); });

    if (capability) {
      agents = agents.filter((a) => a.capabilities.includes(capability));
    }

    return { agents, online_count: agents.length };
  }

  // ---- MARK-READ ----
  if (action === "mark-read") {
    const { message_ids, agent_id } = body;
    if (!agent_id) return { error: "agent_id is required", _status: 400 };
    if (!message_ids || !Array.isArray(message_ids)) return { error: "message_ids array is required", _status: 400 };

    for (const id of message_ids) {
      const existing = db.prepare("SELECT metadata FROM design_space WHERE id = ?").get(id);
      if (existing) {
        const meta = jsonParse(existing.metadata, {});
        const readBy = meta.read_by || [];
        if (!readBy.includes(agent_id)) readBy.push(agent_id);
        meta.read_by = readBy;
        db.prepare("UPDATE design_space SET metadata = ? WHERE id = ?").run(JSON.stringify(meta), id);
      }
    }
    return { marked: message_ids.length, agent_id };
  }

  // ---- THREAD ----
  if (action === "thread") {
    const { thread_id } = body;
    if (!thread_id) return { error: "thread_id is required", _status: 400 };

    const messages = db.prepare("SELECT * FROM design_space WHERE thread_id = ? ORDER BY created_at ASC").all(thread_id);
    messages.forEach((m) => { m.metadata = jsonParse(m.metadata, {}); m.topics = jsonParse(m.topics, []); m.components = jsonParse(m.components, []); });
    return { thread_id, messages, count: messages.length };
  }

  // ---- POST-TASK ----
  if (action === "post-task") {
    const { from_agent, project, title, content, assignee, priority = "normal", topics = [], components = [] } = body;
    if (!content || !from_agent || !title) return { error: "content, from_agent, and title are required", _status: 400 };

    const id = uuid();
    const thread_id = uuid();
    const metadata = JSON.stringify({
      title, from_agent, assignee: assignee || null, priority,
      status: "ready", created_at: new Date().toISOString(), claimed_at: null, completed_at: null,
    });

    db.prepare(`INSERT INTO design_space (id, content, category, project, topics, components, thread_id, metadata)
      VALUES (?, ?, 'task', ?, ?, ?, ?, ?)`).run(
      id, content, project || null, JSON.stringify(topics), JSON.stringify(components), thread_id, metadata
    );

    const task = db.prepare("SELECT * FROM design_space WHERE id = ?").get(id);
    task.metadata = jsonParse(task.metadata, {});
    task.topics = jsonParse(task.topics, []);
    task.components = jsonParse(task.components, []);
    return { task, thread_id };
  }

  // ---- CLAIM-TASK ----
  if (action === "claim-task") {
    const { task_id, agent_id } = body;
    if (!task_id || !agent_id) return { error: "task_id and agent_id are required", _status: 400 };

    const existing = db.prepare("SELECT metadata FROM design_space WHERE id = ? AND category = 'task'").get(task_id);
    if (!existing) return { error: "Task not found", _status: 404 };

    const meta = jsonParse(existing.metadata, {});
    if (meta.status !== "ready") return { error: `Task is ${meta.status}, not claimable`, _status: 409 };

    meta.assignee = agent_id;
    meta.status = "in-progress";
    meta.claimed_at = new Date().toISOString();
    db.prepare("UPDATE design_space SET metadata = ? WHERE id = ?").run(JSON.stringify(meta), task_id);

    const task = db.prepare("SELECT * FROM design_space WHERE id = ?").get(task_id);
    task.metadata = jsonParse(task.metadata, {});
    return { task };
  }

  // ---- LIST-TASKS ----
  if (action === "list-tasks") {
    const { project, assignee, status, limit = 20 } = body;

    let sql = "SELECT * FROM design_space WHERE category = 'task'";
    const params = [];
    if (project) { sql += " AND project = ?"; params.push(project); }
    if (status) { sql += " AND json_extract(metadata, '$.status') = ?"; params.push(status); }
    if (assignee) { sql += " AND json_extract(metadata, '$.assignee') = ?"; params.push(assignee); }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const tasks = db.prepare(sql).all(...params);
    tasks.forEach((t) => { t.metadata = jsonParse(t.metadata, {}); t.topics = jsonParse(t.topics, []); t.components = jsonParse(t.components, []); });
    return { tasks, count: tasks.length };
  }

  // ---- UPDATE-TASK ----
  if (action === "update-task") {
    const { task_id, agent_id, status: newStatus, result } = body;
    if (!task_id || !agent_id) return { error: "task_id and agent_id are required", _status: 400 };

    const existing = db.prepare("SELECT metadata FROM design_space WHERE id = ? AND category = 'task'").get(task_id);
    if (!existing) return { error: "Task not found", _status: 404 };

    const meta = jsonParse(existing.metadata, {});
    if (newStatus) {
      meta.status = newStatus;
      if (newStatus === "done") meta.completed_at = new Date().toISOString();
    }
    if (result) meta.result = result;
    db.prepare("UPDATE design_space SET metadata = ? WHERE id = ?").run(JSON.stringify(meta), task_id);

    const task = db.prepare("SELECT * FROM design_space WHERE id = ?").get(task_id);
    task.metadata = jsonParse(task.metadata, {});
    return { task };
  }

  // ---- GET-PROTOCOL ----
  if (action === "get-protocol") {
    const { agent_id } = body;
    const protocol = db.prepare("SELECT * FROM design_space WHERE category = 'protocol' ORDER BY created_at DESC LIMIT 1").get();
    if (!protocol) return { protocol: null, version: 0 };

    const meta = jsonParse(protocol.metadata, {});
    const readBy = meta.read_by || [];
    const isNew = agent_id ? !readBy.includes(agent_id) : true;
    return { protocol: protocol.content, version: meta.version || 1, is_new: isNew, updated_at: protocol.updated_at || protocol.created_at };
  }

  // ---- UPDATE-PROTOCOL ----
  if (action === "update-protocol") {
    const { content, from_agent, version } = body;
    if (!content || !version) return { error: "content and version are required", _status: 400 };

    db.prepare("DELETE FROM design_space WHERE category = 'protocol'").run();
    const id = uuid();
    const metadata = JSON.stringify({ version, from_agent: from_agent || "system", read_by: [] });
    db.prepare("INSERT INTO design_space (id, content, category, metadata) VALUES (?, ?, 'protocol', ?)").run(id, content, metadata);

    const protocol = db.prepare("SELECT * FROM design_space WHERE id = ?").get(id);
    protocol.metadata = jsonParse(protocol.metadata, {});
    return { protocol, version };
  }

  // ---- ACK-PROTOCOL ----
  if (action === "ack-protocol") {
    const { agent_id } = body;
    if (!agent_id) return { error: "agent_id is required", _status: 400 };

    const protocol = db.prepare("SELECT id, metadata FROM design_space WHERE category = 'protocol' ORDER BY created_at DESC LIMIT 1").get();
    if (protocol) {
      const meta = jsonParse(protocol.metadata, {});
      const readBy = meta.read_by || [];
      if (!readBy.includes(agent_id)) readBy.push(agent_id);
      meta.read_by = readBy;
      db.prepare("UPDATE design_space SET metadata = ? WHERE id = ?").run(JSON.stringify(meta), protocol.id);
    }
    return { acknowledged: true, agent_id };
  }

  return { error: "Invalid action. Use: send, check, respond, mark-read, thread, register, who-online, post-task, claim-task, list-tasks, update-task, get-protocol, update-protocol, ack-protocol", _status: 400 };
}

// ==================== CAPTURE ====================

function handleCapture(body) {
  const { content, category = "general", project, designer, client, topics = [], components = [], source, source_file, quality_score = 0.5 } = body;
  if (!content) return { error: "content is required", _status: 400 };

  const id = uuid();
  db.prepare(`INSERT INTO design_space (id, content, category, project, designer, client, topics, components, source, source_file, quality_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, content, category, project || null, designer || null, client || null,
    JSON.stringify(topics), JSON.stringify(components), source || null, source_file || null, quality_score
  );

  const entry = db.prepare("SELECT * FROM design_space WHERE id = ?").get(id);
  entry.topics = jsonParse(entry.topics, []);
  entry.components = jsonParse(entry.components, []);
  entry.metadata = jsonParse(entry.metadata, {});
  return { success: true, entry };
}

// ==================== SEARCH ====================

function handleSearch(body) {
  const { query, limit = 10, category, project, designer, threshold = 0 } = body;
  if (!query) return { error: "query is required", _status: 400 };

  // Text-based search (FTS) — no embeddings needed for Lite
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let sql = "SELECT * FROM design_space WHERE 1=1";
  const params = [];

  if (category) { sql += " AND category = ?"; params.push(category); }
  if (project) { sql += " AND project = ?"; params.push(project); }
  if (designer) { sql += " AND designer = ?"; params.push(designer); }

  // Text match across content, topics, components
  if (terms.length > 0) {
    const termClauses = terms.map(() => "(LOWER(content) LIKE ? OR LOWER(topics) LIKE ? OR LOWER(components) LIKE ?)");
    sql += " AND (" + termClauses.join(" AND ") + ")";
    for (const term of terms) {
      params.push(`%${term}%`, `%${term}%`, `%${term}%`);
    }
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  const results = db.prepare(sql).all(...params);
  results.forEach((r) => {
    r.topics = jsonParse(r.topics, []);
    r.components = jsonParse(r.components, []);
    r.metadata = jsonParse(r.metadata, {});
    r.similarity = 0.5; // Placeholder — real similarity needs embeddings
  });

  return { results, count: results.length };
}

// ==================== HTTP SERVER ====================

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    });
    return res.end();
  }

  if (req.method !== "POST") {
    return jsonResponse(res, { error: "POST only" }, 405);
  }

  try {
    const body = await parseBody(req);
    const urlPath = req.url.replace(/\/$/, "");

    let result;

    if (urlPath === "/agent-messages" || urlPath === "/functions/v1/agent-messages") {
      result = handleAgentMessages(body);
    } else if (urlPath === "/capture-design-space" || urlPath === "/functions/v1/capture-design-space") {
      result = handleCapture(body);
    } else if (urlPath === "/search-design-space" || urlPath === "/functions/v1/search-design-space") {
      result = handleSearch(body);
    } else {
      result = { error: `Unknown endpoint: ${urlPath}. Use /agent-messages, /capture-design-space, or /search-design-space`, _status: 404 };
    }

    const status = result._status || 200;
    delete result._status;
    jsonResponse(res, result, status);
  } catch (err) {
    jsonResponse(res, { error: err.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`\n  Agent Space Lite running on http://localhost:${PORT}`);
  console.log(`  Database: ${DB_PATH}`);
  console.log(`  Endpoints:`);
  console.log(`    POST /agent-messages    — send, check, respond, register, who-online, ...`);
  console.log(`    POST /capture-design-space — capture knowledge`);
  console.log(`    POST /search-design-space  — search knowledge`);
  console.log(`\n  Same API as Supabase — just change BASE_URL to http://localhost:${PORT}\n`);
});
