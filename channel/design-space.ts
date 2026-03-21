#!/usr/bin/env bun
// Design Space Channel — pushes agent messages into Claude Code sessions in real-time
// Subscribes to Supabase Realtime for new messages, pushes as <channel source="design-space"> events
// Two-way: Claude can reply and send messages back through the channel

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@supabase/supabase-js";

// --- Configuration ---

const SUPABASE_URL =
  process.env.DESIGN_SPACE_URL?.replace(/\/functions\/v1\/?$/, "") ||
  process.env.SUPABASE_URL ||
  "";
const SUPABASE_KEY =
  process.env.DESIGN_SPACE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "";
const AGENT_ID = process.env.AGENT_ID || "claude-code";
const AGENT_PROJECT = process.env.AGENT_PROJECT || "";
const AGENT_MESSAGES_URL =
  process.env.DESIGN_SPACE_URL ||
  `${SUPABASE_URL}/functions/v1`;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "Design Space Channel: DESIGN_SPACE_URL/DESIGN_SPACE_KEY or SUPABASE_URL/SUPABASE_ANON_KEY required"
  );
  process.exit(1);
}

// --- Supabase client ---

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { params: { eventsPerSecond: 10 } },
});

// --- Session state ---

let sessionId = AGENT_ID;
const readMessages = new Set<string>();

// --- Signal strength (same logic as agent-messages edge function) ---

function getSignal(
  msg: any
): "strong" | "medium" | "weak" | "available" {
  const meta = msg.metadata || {};
  const toAgent = meta.to_agent;
  const msgProject = msg.project;
  const isDirected = toAgent === AGENT_ID || toAgent === sessionId;
  const isProjectMatch = AGENT_PROJECT && msgProject === AGENT_PROJECT;

  if (isDirected && isProjectMatch) return "strong";
  if (isDirected) return "medium";
  if (isProjectMatch) return "weak";
  return "available";
}

function isOwnMessage(msg: any): boolean {
  const from = msg.metadata?.from_agent;
  return from === AGENT_ID || from === sessionId;
}

function formatSignalLabel(signal: string, msg: any): string {
  const meta = msg.metadata || {};
  const priority = meta.priority === "urgent" ? "URGENT+" : "";
  switch (signal) {
    case "strong":
      return `${priority}DIRECT+PROJECT`;
    case "medium":
      return `${priority}DIRECT`;
    case "weak":
      return `${priority}PROJECT`;
    default:
      return `${priority}FYI`;
  }
}

// --- MCP Server ---

const mcp = new Server(
  { name: "design-space", version: "1.0.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to Design Space, an agent communication and knowledge system.

Messages from other agents arrive as <channel source="design-space" signal="..." from_agent="..." message_type="..." ...>. The signal attribute indicates relevance:
- strong: directed to you AND matches your project
- medium: directed to you
- weak: matches your project (sent to someone else)
- available: ambient broadcast

To reply to a message, use the ds_reply tool with the message_id from the tag.
To send a new message, use the ds_send tool.
To search Design Space knowledge, use the ds_search tool.

Always respond to strong and medium signals. Weak signals are informational. Available signals are ambient — act on them only if relevant to your current work.

When a meeting_transcript message arrives, it contains live transcript segments. Read them for context and respond when prompted by the user.`,
  }
);

// --- Tools ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ds_reply",
      description:
        "Reply to a Design Space message in its thread",
      inputSchema: {
        type: "object" as const,
        properties: {
          message_id: {
            type: "string",
            description: "The message ID to reply to (from the channel tag)",
          },
          text: {
            type: "string",
            description: "Your reply content",
          },
        },
        required: ["message_id", "text"],
      },
    },
    {
      name: "ds_send",
      description:
        "Send a new message to another agent or broadcast",
      inputSchema: {
        type: "object" as const,
        properties: {
          to_agent: {
            type: "string",
            description:
              "Target agent (saga, codex, freya, ivonne) or omit for broadcast",
          },
          text: {
            type: "string",
            description: "Message content",
          },
          message_type: {
            type: "string",
            description:
              "notification, question, work-order, handoff, or broadcast",
          },
          project: {
            type: "string",
            description: "Project context (optional)",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "ds_search",
      description: "Search Design Space knowledge by semantic query",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "What to search for",
          },
          category: {
            type: "string",
            description:
              "Filter by category: meeting_transcript, successful_pattern, client_feedback, etc.",
          },
          limit: {
            type: "number",
            description: "Max results (default 5)",
          },
        },
        required: ["query"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments as Record<string, any>;

  if (req.params.name === "ds_reply") {
    const resp = await fetch(`${AGENT_MESSAGES_URL}/agent-messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "respond",
        message_id: args.message_id,
        content: args.text,
        from_agent: AGENT_ID,
      }),
    });
    const data = await resp.json();
    if (!resp.ok)
      return {
        content: [{ type: "text", text: `Error: ${JSON.stringify(data)}` }],
      };
    return { content: [{ type: "text", text: "Replied in thread." }] };
  }

  if (req.params.name === "ds_send") {
    const resp = await fetch(`${AGENT_MESSAGES_URL}/agent-messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "send",
        from_agent: AGENT_ID,
        to_agent: args.to_agent || null,
        content: args.text,
        message_type: args.message_type || "notification",
        project: args.project || AGENT_PROJECT || null,
      }),
    });
    const data = await resp.json();
    if (!resp.ok)
      return {
        content: [{ type: "text", text: `Error: ${JSON.stringify(data)}` }],
      };
    return { content: [{ type: "text", text: "Message sent." }] };
  }

  if (req.params.name === "ds_search") {
    const resp = await fetch(`${AGENT_MESSAGES_URL}/search-design-space`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: args.query,
        category: args.category || undefined,
        limit: args.limit || 5,
      }),
    });
    const data = await resp.json();
    if (!resp.ok)
      return {
        content: [{ type: "text", text: `Error: ${JSON.stringify(data)}` }],
      };
    const results = data.results || data.entries || [];
    const summary = results
      .map(
        (r: any, i: number) =>
          `${i + 1}. [${r.category}] ${r.content?.substring(0, 200)}...`
      )
      .join("\n\n");
    return {
      content: [{ type: "text", text: summary || "No results found." }],
    };
  }

  throw new Error(`Unknown tool: ${req.params.name}`);
});

// --- Register agent ---

async function registerAgent() {
  try {
    const resp = await fetch(`${AGENT_MESSAGES_URL}/agent-messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "register",
        agent_id: AGENT_ID,
        repo: process.env.AGENT_REPO || "",
      }),
    });
    const data = await resp.json();
    if (data.session_id) {
      sessionId = data.session_id;
      console.error(`Design Space Channel: registered as ${sessionId}`);
    }
    return data;
  } catch (err) {
    console.error("Design Space Channel: registration failed:", err);
  }
}

// --- Supabase Realtime subscription ---

function subscribeToMessages() {
  const channel = supabase
    .channel("design-space-messages")
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "design_space",
        filter: "category=eq.agent_message",
      },
      async (payload) => {
        const msg = payload.new;

        // Skip own messages
        if (isOwnMessage(msg)) return;

        // Skip already-read messages
        if (readMessages.has(msg.id)) return;
        readMessages.add(msg.id);

        // Check if already read by this agent
        const readBy = msg.metadata?.read_by || [];
        if (
          readBy.includes(AGENT_ID) ||
          readBy.includes(sessionId)
        )
          return;

        const signal = getSignal(msg);
        const label = formatSignalLabel(signal, msg);
        const meta = msg.metadata || {};

        // Push to Claude Code session
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: msg.content,
            meta: {
              message_id: msg.id,
              signal,
              label,
              from_agent: meta.from_agent || "unknown",
              to_agent: meta.to_agent || "broadcast",
              message_type: meta.message_type || "notification",
              project: msg.project || "",
              priority: meta.priority || "normal",
              thread_id: msg.thread_id || "",
            },
          },
        });

        // Mark as read
        try {
          await fetch(`${AGENT_MESSAGES_URL}/agent-messages`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${SUPABASE_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              action: "mark-read",
              message_ids: [msg.id],
              agent_id: AGENT_ID,
            }),
          });
        } catch {
          // silent — mark-read is best-effort
        }
      }
    )
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "design_space",
        filter: "category=eq.meeting_transcript",
      },
      async (payload) => {
        const msg = payload.new;
        const meta = msg.metadata || {};

        // Push transcript segments as channel events
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: msg.content,
            meta: {
              message_id: msg.id,
              signal: "transcript",
              label: "TRANSCRIPT",
              from_agent: "fireflies-bot",
              meeting_title: meta.title || "",
              chunk_index: String(meta.chunk_index ?? ""),
              is_summary: String(meta.is_summary ?? false),
              project: msg.project || "",
            },
          },
        });
      }
    )
    .subscribe((status) => {
      console.error(`Design Space Channel: realtime ${status}`);
    });

  return channel;
}

// --- Startup ---

await mcp.connect(new StdioServerTransport());
await registerAgent();
subscribeToMessages();

console.error(
  `Design Space Channel: listening as ${sessionId} (project: ${AGENT_PROJECT || "any"})`
);
