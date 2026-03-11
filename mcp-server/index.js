import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

// Track connection health — agents must report failures to their human
let lastConnectionError = null;

process.on('unhandledRejection', (err) => {
  lastConnectionError = `Unhandled error: ${err?.message || err}`;
});

const SUPABASE_URL = process.env.DESIGN_SPACE_URL;
const SUPABASE_ANON_KEY = process.env.DESIGN_SPACE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    'Missing required environment variables:\n' +
    '  DESIGN_SPACE_URL     — Your Supabase project URL\n' +
    '  DESIGN_SPACE_ANON_KEY — Your Supabase anon key\n\n' +
    'See .env.example for configuration.'
  );
  process.exit(1);
}

async function callEdgeFunction(name, body) {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      lastConnectionError = `Design Space returned ${response.status}: ${response.statusText}`;
      throw new Error(lastConnectionError);
    }
    lastConnectionError = null; // Clear on success
    return response.json();
  } catch (err) {
    lastConnectionError = err.message || 'Connection to Design Space failed';
    throw new Error(
      `CONNECTION FAILED: ${lastConnectionError}. ` +
      `Please check the network connection or restart the session.`
    );
  }
}

// ============================================================
// REALTIME NOTIFICATION QUEUE
// Push notifications via Supabase Realtime websocket
// ============================================================

const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Agent identity: set via environment variables or register_presence
let registeredAgentId = process.env.AGENT_ID || null;
let registeredAgentName = process.env.AGENT_NAME || null;
let registeredPlatform = process.env.AGENT_PLATFORM || 'claude-code';
let registeredProject = process.env.AGENT_PROJECT || null;
let registeredFramework = process.env.AGENT_FRAMEWORK || null;

// Notification queue: pushed to by Realtime, drained by tools
const notificationQueue = [];

// Realtime connection health
let realtimeConnected = false;
let realtimeChannel = null;

function startRealtimeSubscription() {
  // Scope subscription to project if known (RLS at the stream level)
  const filter = registeredProject
    ? `category=eq.agent_message&project=eq.${registeredProject}`
    : 'category=eq.agent_message';

  realtimeChannel = supabaseClient
    .channel('agent-messages-live')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'design_space',
      filter,
    }, (payload) => {
      const msg = payload.new;
      if (msg.metadata?.from_agent === registeredAgentId) return;
      const to = msg.metadata?.to_agent;
      if (to && to !== registeredAgentId) return;

      notificationQueue.push({
        id: msg.id,
        from: msg.metadata?.from_agent || 'unknown',
        platform: msg.metadata?.from_platform || 'unknown',
        content: msg.content,
        type: msg.metadata?.message_type || 'notification',
        thread_id: msg.thread_id,
        priority: msg.metadata?.priority || 'normal',
        time: msg.created_at,
      });
    })
    .subscribe((status) => {
      realtimeConnected = (status === 'SUBSCRIBED');
      if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
        realtimeConnected = false;
        setTimeout(() => {
          try { realtimeChannel?.unsubscribe(); } catch (_) {}
          try { startRealtimeSubscription(); } catch (_) {}
        }, 5000);
      }
    });
}

// Re-scope subscription when project changes (e.g. register_presence with new project)
function rescopeSubscription() {
  try { realtimeChannel?.unsubscribe(); } catch (_) {}
  startRealtimeSubscription();
}

// Fallback: poll via HTTP when Realtime is down
async function pollForMessages() {
  if (!registeredAgentId) return [];
  try {
    const result = await callEdgeFunction("agent-messages", {
      action: "check",
      agent_id: registeredAgentId,
      project: registeredProject,
      include_broadcast: true,
      limit: 20,
    });
    return result.messages || [];
  } catch (_) {
    return [];
  }
}

// Drain notifications — uses Realtime queue if connected, falls back to polling
async function drainNotifications() {
  // If Realtime is down, poll as fallback
  if (!realtimeConnected && registeredAgentId && notificationQueue.length === 0) {
    const polled = await pollForMessages();
    for (const m of polled) {
      // Avoid duplicates
      if (!notificationQueue.find(n => n.id === m.id)) {
        notificationQueue.push({
          id: m.id,
          from: m.metadata?.from_agent || 'unknown',
          platform: m.metadata?.from_platform || 'unknown',
          content: m.content,
          type: m.metadata?.message_type || 'notification',
          thread_id: m.thread_id,
          priority: m.metadata?.priority || 'normal',
          time: m.created_at,
        });
      }
    }
  }

  if (notificationQueue.length === 0) return '';
  const notes = notificationQueue.splice(0);
  const lines = notes.map(n =>
    `[${n.priority === 'urgent' ? 'URGENT' : 'NEW'}] from ${n.from} (${n.platform}): ${n.content.substring(0, 120)}${n.content.length > 120 ? '...' : ''}`
  );
  const mode = realtimeConnected ? 'realtime' : 'polled';
  return `\n--- INCOMING MESSAGES (${lines.length}, ${mode}) ---\n${lines.join('\n')}\n---\n\n`;
}

// Auto-register + catch up on missed messages on startup
async function autoRegister() {
  if (!registeredAgentId) return;
  try {
    // Register presence
    await callEdgeFunction("agent-messages", {
      action: "register",
      agent_id: registeredAgentId,
      agent_name: registeredAgentName || registeredAgentId,
      platform: registeredPlatform,
      project: registeredProject,
      framework: registeredFramework,
      status: "online",
    });
    // Catch up: fetch any messages that arrived while we were offline
    const missed = await pollForMessages();
    for (const m of missed) {
      notificationQueue.push({
        id: m.id,
        from: m.metadata?.from_agent || 'unknown',
        platform: m.metadata?.from_platform || 'unknown',
        content: m.content,
        type: m.metadata?.message_type || 'notification',
        thread_id: m.thread_id,
        priority: m.metadata?.priority || 'normal',
        time: m.created_at,
      });
    }
  } catch (e) {
    lastConnectionError = `Auto-registration failed: ${e.message}. Design Space may be unreachable.`;
  }
}

// Lazy start: Realtime + registration happen AFTER transport connects
// This prevents network failures from crashing the MCP server
let realtimeStarted = false;

function ensureRealtimeStarted() {
  if (realtimeStarted) return;
  realtimeStarted = true;
  try {
    startRealtimeSubscription();
  } catch (e) {
    // Realtime is optional — server works fine without it (polling fallback)
    realtimeConnected = false;
  }
  // Auto-register in background, never blocks — but reports failures
  autoRegister().catch((e) => {
    lastConnectionError = `Startup registration failed: ${e.message}`;
  });
}

const server = new McpServer({
  name: "design-space",
  version: "2.0.0",
});

// Capture knowledge into Design Space
server.tool(
  "capture_knowledge",
  "Capture a design insight, pattern, experiment, or methodology learning into the Design Space. Use this whenever you discover something worth remembering across projects.",
  {
    content: z.string().describe("The knowledge to capture — be specific and include context"),
    category: z.enum([
      "inspiration",
      "failed_experiment",
      "successful_pattern",
      "component_experience",
      "design_system_evolution",
      "client_feedback",
      "competitive_intelligence",
      "methodology",
      "agent_experience",
      "reference",
      "general"
    ]).default("general").describe("Category of knowledge"),
    project: z.string().optional().describe("Project name (e.g. 'kalla', 'bythjul', 'sharif')"),
    designer: z.string().default("marten").describe("Who captured this"),
    client: z.string().optional().describe("Client name (only stored in owner's space)"),
    topics: z.array(z.string()).default([]).describe("Semantic tags: ['mobile', 'navigation', 'popup']"),
    components: z.array(z.string()).default([]).describe("Design components: ['modal', 'bottom-sheet']"),
    source: z.string().optional().describe("Where this came from: 'agent-dialog', 'workshop', 'reference'"),
    source_file: z.string().optional().describe("Original file path if ingested from repo"),
  },
  async ({ content, category, project, designer, client, topics, components, source, source_file }) => {
    try {
      const result = await callEdgeFunction("capture-design-space", {
        content, category, project, designer, client, topics, components, source, source_file,
      });
      if (result.error) {
        return { content: [{ type: "text", text: `Error: ${result.error}` }] };
      }
      return {
        content: [{ type: "text", text: `Captured to Design Space:\n${JSON.stringify(result.entry, null, 2)}` }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

// Search Design Space
server.tool(
  "search_space",
  "Search the Design Space for accumulated knowledge — design patterns, experiments, methodology insights, component experiences. Returns semantically similar results.",
  {
    query: z.string().describe("What to search for (natural language)"),
    category: z.string().optional().describe("Filter by category"),
    project: z.string().optional().describe("Filter by project"),
    designer: z.string().optional().describe("Filter by designer"),
    topics: z.array(z.string()).optional().describe("Filter by topics"),
    components: z.array(z.string()).optional().describe("Filter by components"),
    limit: z.number().default(10).describe("Max results"),
    threshold: z.number().default(0.7).describe("Similarity threshold (0-1)"),
  },
  async ({ query, category, project, designer, topics, components, limit, threshold }) => {
    try {
      const result = await callEdgeFunction("search-design-space", {
        query, category, project, designer, topics, components, limit, threshold,
      });
      if (result.error) {
        return { content: [{ type: "text", text: `Error: ${result.error}` }] };
      }
      const entries = result.results || [];
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No matching knowledge found in Design Space." }] };
      }
      const formatted = entries.map((e, i) =>
        `${i + 1}. [${e.category}] ${e.content}\n   Project: ${e.project || '-'} | Designer: ${e.designer || '-'} | Topics: ${(e.topics || []).join(', ') || '-'} | Similarity: ${(e.similarity * 100).toFixed(1)}%`
      ).join('\n\n');
      return {
        content: [{ type: "text", text: `Found ${entries.length} results:\n\n${formatted}` }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

// Capture visual pattern (screenshot + semantic description → dual embedding)
server.tool(
  "capture_visual",
  "Capture a visual design pattern with its screenshot into the Design Space. Creates both semantic (text) and parametric (visual) embeddings. Use this when analyzing sites, capturing component screenshots, or recording visual patterns.",
  {
    content: z.string().describe("Semantic description of the visual pattern — what it is, why it works, design decisions"),
    image_base64: z.string().describe("Base64-encoded screenshot of the pattern (PNG or JPG)"),
    category: z.enum([
      "inspiration",
      "failed_experiment",
      "successful_pattern",
      "component_experience",
      "design_system_evolution",
      "client_feedback",
      "competitive_intelligence",
      "methodology",
      "agent_experience",
      "reference",
      "general"
    ]).default("successful_pattern").describe("Category of the visual pattern"),
    project: z.string().optional().describe("Project name (e.g. 'whiteport', 'kalla')"),
    designer: z.string().default("marten").describe("Who captured this"),
    client: z.string().optional().describe("Client name"),
    topics: z.array(z.string()).default([]).describe("Semantic tags: ['hero', 'dark-theme', 'trust-section']"),
    components: z.array(z.string()).default([]).describe("Design components: ['hero-banner', 'cta-button']"),
    source: z.string().default("site-analysis").describe("Where this came from"),
    source_file: z.string().optional().describe("URL or file path of the source"),
    quality_score: z.number().optional().describe("Aesthetic quality score (0-5)"),
    pattern_type: z.enum(["baseline", "inspiration", "delta", "rejected", "approved", "conditional"]).optional().describe("Pattern type in the design journey"),
  },
  async ({ content, image_base64, category, project, designer, client, topics, components, source, source_file, quality_score, pattern_type }) => {
    try {
      const result = await callEdgeFunction("capture-visual", {
        content, image_base64, category, project, designer, client, topics, components, source, source_file, quality_score, pattern_type,
      });
      if (result.error) {
        return { content: [{ type: "text", text: `Error: ${result.error}` }] };
      }
      const dims = result.embedding_dimensions || {};
      return {
        content: [{ type: "text", text: `Visual pattern captured to Design Space:\n${JSON.stringify(result.entry, null, 2)}\n\nEmbeddings: semantic=${dims.semantic}d, visual=${dims.visual}d` }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

// Recent entries
server.tool(
  "recent_knowledge",
  "Show recent entries in the Design Space, optionally filtered by category or project.",
  {
    limit: z.number().default(20).describe("How many entries"),
    category: z.string().optional().describe("Filter by category"),
    project: z.string().optional().describe("Filter by project"),
  },
  async ({ limit, category, project }) => {
    try {
      const result = await callEdgeFunction("search-design-space", {
        query: "recent design knowledge",
        limit,
        category,
        project,
        threshold: 0.0,
      });
      // Fallback: direct SQL via a simple edge function call
      const entries = result.results || [];
      const formatted = entries.map((e, i) =>
        `${i + 1}. [${e.category}] ${e.content}\n   Project: ${e.project || '-'} | ${e.created_at}`
      ).join('\n\n');
      return {
        content: [{ type: "text", text: entries.length ? `Recent entries:\n\n${formatted}` : "Design Space is empty." }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

// Space stats
server.tool(
  "space_stats",
  "Get overview statistics of the Design Space — total entries, categories, projects, top topics.",
  {},
  async () => {
    try {
      // Use execute_sql via edge function isn't available, so we query via search with very low threshold
      const result = await callEdgeFunction("search-design-space", {
        query: "design space overview",
        limit: 1,
        threshold: 0.0,
      });
      return {
        content: [{ type: "text", text: `Design Space has ${result.count || 0} total entries matching. Use search_space for specific queries.` }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

// Search by visual similarity (parametric search via Voyage AI embeddings)
server.tool(
  "search_visual_similarity",
  "Search the Design Space by visual similarity — find patterns that LOOK like a given image. Uses Voyage AI visual embeddings (1024d). Great for finding visually similar components, layouts, or design patterns across projects.",
  {
    image_base64: z.string().describe("Base64-encoded image to find similar patterns for"),
    category: z.string().optional().describe("Filter by category"),
    project: z.string().optional().describe("Filter by project"),
    pattern_type: z.enum(["baseline", "inspiration", "delta", "rejected", "approved", "conditional"]).optional().describe("Filter by pattern type"),
    limit: z.number().default(5).describe("Max results"),
    threshold: z.number().default(0.6).describe("Visual similarity threshold (0-1)"),
  },
  async ({ image_base64, category, project, pattern_type, limit, threshold }) => {
    try {
      const result = await callEdgeFunction("search-visual-similarity", {
        image_base64, category, project, pattern_type, limit, threshold,
      });
      if (result.error) {
        return { content: [{ type: "text", text: `Error: ${result.error}` }] };
      }
      const entries = result.results || [];
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No visually similar patterns found in Design Space." }] };
      }
      const formatted = entries.map((e, i) =>
        `${i + 1}. [${e.category}] [${e.pattern_type || '-'}] ${e.content}\n   Project: ${e.project || '-'} | Visual similarity: ${(e.similarity * 100).toFixed(1)}%`
      ).join('\n\n');
      return {
        content: [{ type: "text", text: `Found ${entries.length} visually similar patterns:\n\n${formatted}` }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

// Capture feedback pair (linked before/after with designer reasoning)
server.tool(
  "capture_feedback_pair",
  "Capture a linked design feedback pair: BEFORE state → designer's REASONING → AFTER state. This is how the Design Space learns the designer's taste. Creates two linked entries sharing a pair_id. Use this whenever the designer requests a change to your work.",
  {
    before_description: z.string().describe("Semantic description of the design BEFORE the change — what it looked like and its characteristics"),
    before_image_base64: z.string().optional().describe("Screenshot of the before state"),
    after_description: z.string().describe("Semantic description of the design AFTER the change — what was chosen instead"),
    after_image_base64: z.string().optional().describe("Screenshot of the after state"),
    reasoning: z.string().describe("The designer's WHY — what drove this change, what felt wrong, what feels right now"),
    pattern_type_before: z.enum(["baseline", "inspiration", "delta", "rejected", "approved", "conditional"]).default("rejected").describe("Pattern type for the before state"),
    pattern_type_after: z.enum(["baseline", "inspiration", "delta", "rejected", "approved", "conditional"]).default("approved").describe("Pattern type for the after state"),
    project: z.string().optional().describe("Project name"),
    designer: z.string().default("marten").describe("Who gave the feedback"),
    topics: z.array(z.string()).default([]).describe("Semantic tags for this preference"),
    components: z.array(z.string()).default([]).describe("Design components affected"),
  },
  async ({ before_description, before_image_base64, after_description, after_image_base64, reasoning, pattern_type_before, pattern_type_after, project, designer, topics, components }) => {
    try {
      const result = await callEdgeFunction("capture-feedback-pair", {
        before_description, before_image_base64,
        after_description, after_image_base64,
        reasoning, pattern_type_before, pattern_type_after,
        project, designer, topics, components,
      });
      if (result.error) {
        return { content: [{ type: "text", text: `Error: ${result.error}` }] };
      }
      const summary = `Feedback pair captured:\n` +
        `  pair_id: ${result.pair_id}\n` +
        `  BEFORE [${pattern_type_before}]: ${before_description.substring(0, 100)}...\n` +
        `  AFTER [${pattern_type_after}]: ${after_description.substring(0, 100)}...\n` +
        `  REASONING: ${reasoning.substring(0, 100)}...\n` +
        `  Embeddings: before=${JSON.stringify(result.before_dims)}, after=${JSON.stringify(result.after_dims)}`;
      return { content: [{ type: "text", text: summary }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

// Search preference patterns (red flag detection)
server.tool(
  "search_preference_patterns",
  "Check if a proposed design matches known REJECTED patterns. Use this BEFORE presenting any new design to the designer. Returns rejected patterns with their approved alternatives. This is the 'red flag' detector — if a match is found, adjust the design before showing it.",
  {
    description: z.string().describe("Semantic description of the proposed design"),
    image_base64: z.string().optional().describe("Screenshot of the proposed design (enables visual similarity check)"),
    project: z.string().optional().describe("Filter by project"),
    designer: z.string().default("marten").describe("Whose preferences to check against"),
    limit: z.number().default(5).describe("Max results"),
    semantic_threshold: z.number().default(0.75).describe("Semantic similarity threshold for flagging"),
    visual_threshold: z.number().default(0.70).describe("Visual similarity threshold for flagging"),
  },
  async ({ description, image_base64, project, designer, limit, semantic_threshold, visual_threshold }) => {
    try {
      const result = await callEdgeFunction("search-preference-patterns", {
        description, image_base64, project, designer, limit, semantic_threshold, visual_threshold,
      });
      if (result.error) {
        return { content: [{ type: "text", text: `Error: ${result.error}` }] };
      }
      const matches = result.results || [];
      if (matches.length === 0) {
        return { content: [{ type: "text", text: "No red flags — proposed design does not match any known rejected patterns." }] };
      }
      const formatted = matches.map((m, i) => {
        let line = `${i + 1}. RED FLAG: ${m.content.substring(0, 150)}...\n`;
        line += `   Semantic: ${(m.semantic_similarity * 100).toFixed(1)}% | Visual: ${(m.visual_similarity * 100).toFixed(1)}%\n`;
        if (m.paired_content) {
          line += `   PREFERRED INSTEAD: ${m.paired_content.substring(0, 150)}...`;
        }
        return line;
      }).join('\n\n');
      return {
        content: [{ type: "text", text: `⚠️ Found ${matches.length} preference conflicts:\n\n${formatted}\n\nConsider adjusting the design to align with known preferences before presenting.` }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

// ============================================================
// AGENT MESSAGING — Cross-LLM, cross-IDE agent communication
// ============================================================

// Send a message to another agent
server.tool(
  "send_agent_message",
  "Send a message to another agent via the Design Space. Messages are embedded as searchable knowledge — every conversation becomes part of the collective design memory. Works across LLMs and platforms (Claude Code, ChatGPT, Cursor, etc.).",
  {
    content: z.string().describe("The message content"),
    from_agent: z.string().describe("Your agent identity (e.g. 'freya', 'saga')"),
    from_platform: z.string().default("claude-code").describe("Platform: 'claude-code', 'chatgpt', 'cursor', etc."),
    to_agent: z.string().optional().describe("Recipient agent ID (null = broadcast to project)"),
    project: z.string().optional().describe("Project context (e.g. 'kalla')"),
    message_type: z.enum(["notification", "question", "request", "task_offer", "task_complete"]).default("notification").describe("Type of message"),
    capabilities: z.array(z.string()).default([]).describe("Your capabilities: ['file-editing', 'image-generation', 'code-execution']"),
    priority: z.enum(["normal", "urgent"]).default("normal").describe("Message priority"),
    topics: z.array(z.string()).default([]).describe("Semantic tags"),
    components: z.array(z.string()).default([]).describe("Design components related to this message"),
    attachments: z.array(z.object({
      type: z.enum(["image", "link", "file"]),
      base64: z.string().optional().describe("Base64 image data (for type=image)"),
      url: z.string().optional().describe("URL (for type=link)"),
      path: z.string().optional().describe("File path (for type=file)"),
      title: z.string().optional().describe("Display title"),
      caption: z.string().optional().describe("Description"),
    })).default([]).describe("Attachments: images, links, files"),
  },
  async ({ content, from_agent, from_platform, to_agent, project, message_type, capabilities, priority, topics, components, attachments }) => {
    try {
      const result = await callEdgeFunction("agent-messages", {
        action: "send",
        content, from_agent, from_platform, to_agent, project,
        message_type, capabilities, priority, topics, components, attachments,
      });
      if (result.error) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
      const msg = result.message;
      return {
        content: [{ type: "text", text: `Message sent to ${to_agent || 'broadcast'}:\n  Thread: ${result.thread_id}\n  ID: ${msg.id}\n  Content: ${content.substring(0, 100)}...` }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

// Check for unread messages
server.tool(
  "check_agent_messages",
  "Check for unread messages addressed to you or broadcast to your project. Run this at session start to see if other agents have sent you anything.",
  {
    agent_id: z.string().describe("Your agent identity (e.g. 'freya')"),
    project: z.string().optional().describe("Filter by project"),
    include_broadcast: z.boolean().default(true).describe("Include broadcast messages (no specific recipient)"),
    limit: z.number().default(20).describe("Max messages to return"),
  },
  async ({ agent_id, project, include_broadcast, limit }) => {
    try {
      const result = await callEdgeFunction("agent-messages", {
        action: "check", agent_id, project, include_broadcast, limit,
      });
      if (result.error) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
      if (result.unread_count === 0) {
        return { content: [{ type: "text", text: "No unread messages." }] };
      }
      const formatted = result.messages.map((m, i) =>
        `${i + 1}. [${m.metadata?.message_type || 'msg'}] from ${m.metadata?.from_agent} (${m.metadata?.from_platform || '?'}):\n   ${m.content}\n   Thread: ${m.thread_id} | ID: ${m.id} | ${m.created_at}`
      ).join('\n\n');
      return {
        content: [{ type: "text", text: `${result.unread_count} unread message(s):\n\n${formatted}` }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

// Respond to a message
server.tool(
  "respond_to_message",
  "Reply to an agent message. Automatically links to the conversation thread and notifies the original sender.",
  {
    message_id: z.string().optional().describe("ID of the message to reply to"),
    thread_id: z.string().optional().describe("Thread ID (alternative to message_id)"),
    content: z.string().describe("Your response"),
    from_agent: z.string().describe("Your agent identity"),
    from_platform: z.string().default("claude-code").describe("Your platform"),
    message_type: z.enum(["answer", "question", "acknowledgment", "task_accept", "task_complete"]).default("answer").describe("Type of response"),
    attachments: z.array(z.object({
      type: z.enum(["image", "link", "file"]),
      base64: z.string().optional(),
      url: z.string().optional(),
      path: z.string().optional(),
      title: z.string().optional(),
      caption: z.string().optional(),
    })).default([]).describe("Attachments: images, links, files"),
  },
  async ({ message_id, thread_id, content, from_agent, from_platform, message_type, attachments }) => {
    try {
      const result = await callEdgeFunction("agent-messages", {
        action: "respond",
        message_id, thread_id, content, from_agent, from_platform, message_type, attachments,
      });
      if (result.error) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
      return {
        content: [{ type: "text", text: `Response sent:\n  To: ${result.message.metadata?.to_agent || 'thread'}\n  Thread: ${result.message.thread_id}\n  ID: ${result.message.id}` }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

// Register/update presence (auto-registered on startup if AGENT_ID env is set)
server.tool(
  "register_presence",
  "Update your agent presence — status, working_on, context_window, capabilities. Auto-registered on startup if AGENT_ID env var is configured. Use this to update dynamic fields during your session.",
  {
    agent_id: z.string().describe("Your agent identity"),
    agent_name: z.string().optional().describe("Display name (e.g. 'Freya (Designer)')"),
    model: z.string().optional().describe("LLM model (e.g. 'claude-opus-4-6', 'gpt-4o')"),
    platform: z.string().default("claude-code").describe("IDE/tool platform"),
    framework: z.string().optional().describe("Methodology framework (e.g. 'WDS')"),
    project: z.string().optional().describe("Current project"),
    working_on: z.string().optional().describe("Current task description"),
    workspace: z.string().optional().describe("Working directory or repo"),
    capabilities: z.array(z.string()).default([]).describe("What you can do"),
    tools_available: z.array(z.string()).default([]).describe("MCP servers and tools loaded"),
    context_window: z.object({
      used: z.number().optional(),
      max: z.number().optional(),
    }).optional().describe("Context window usage"),
    status: z.enum(["online", "busy", "idle"]).default("online").describe("Current status"),
  },
  async ({ agent_id, agent_name, model, platform, framework, project, working_on, workspace, capabilities, tools_available, context_window, status }) => {
    try {
      const result = await callEdgeFunction("agent-messages", {
        action: "register",
        agent_id, agent_name, model, platform, framework, project,
        working_on, workspace, capabilities, tools_available, context_window, status,
      });
      if (result.error) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
      // Set identity for Realtime notification filtering
      registeredAgentId = agent_id;
      registeredProject = project || null;
      const notifications = await drainNotifications();
      return {
        content: [{ type: "text", text: `${notifications}Registered as online (push notifications active):\n  Agent: ${result.agent.agent_name}\n  Platform: ${result.agent.platform}\n  Project: ${result.agent.project || 'none'}\n  Capabilities: ${(result.agent.capabilities || []).join(', ')}\n  Realtime: listening for messages to '${agent_id}'` }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

// Who's online
server.tool(
  "who_online",
  "See which agents are currently online. Filter by project or capability to find agents that can help with specific tasks.",
  {
    project: z.string().optional().describe("Filter by project"),
    capability: z.string().optional().describe("Filter by capability (e.g. 'image-generation')"),
  },
  async ({ project, capability }) => {
    try {
      const result = await callEdgeFunction("agent-messages", {
        action: "who-online", project, capability,
      });
      if (result.error) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
      if (result.online_count === 0) {
        return { content: [{ type: "text", text: "No agents currently online." }] };
      }
      const formatted = result.agents.map((a, i) =>
        `${i + 1}. ${a.agent_name} (${a.agent_id})\n   Model: ${a.model || '?'} | Platform: ${a.platform}\n   Working on: ${a.working_on || '-'} | Project: ${a.project || '-'}\n   Capabilities: ${(a.capabilities || []).join(', ')}\n   Last seen: ${a.last_heartbeat}`
      ).join('\n\n');
      return {
        content: [{ type: "text", text: `${result.online_count} agent(s) online:\n\n${formatted}` }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

// Check live notification queue (pushed via Supabase Realtime)
server.tool(
  "check_notifications",
  "Check the real-time notification queue. Messages pushed instantly via Supabase Realtime websocket — no polling needed. Call this anytime to see if new messages arrived since your last check.",
  {},
  async () => {
    const notifications = await drainNotifications();
    const connStatus = realtimeConnected ? 'push (realtime)' : 'polling (fallback)';
    const identity = registeredAgentId
      ? `Agent: ${registeredAgentName || registeredAgentId} | Platform: ${registeredPlatform} | Project: ${registeredProject || 'any'} | Mode: ${connStatus}`
      : 'Not identified — set AGENT_ID env var or call register_presence';

    // Surface connection problems — agent must tell the human
    const health = lastConnectionError
      ? `\n⚠ CONNECTION PROBLEM: ${lastConnectionError}\nPlease check the connection or restart the session.\n`
      : '';

    if (!notifications) {
      return { content: [{ type: "text", text: `${health}No new notifications.\n${identity}` }] };
    }
    return { content: [{ type: "text", text: `${health}${notifications}${identity}` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

// NOW safe to start networking — transport is connected, server is live
ensureRealtimeStarted();

// BACKGROUND POLL: check notification queue every 10s and push via MCP logging
// This surfaces incoming messages to the user without requiring a tool call
setInterval(() => {
  if (notificationQueue.length === 0) return;
  const notes = notificationQueue.splice(0);
  for (const n of notes) {
    const preview = n.content.length > 120 ? n.content.slice(0, 120) + '...' : n.content;
    server.sendLoggingMessage({
      level: 'info',
      logger: 'design-space',
      data: `New message from ${n.from} (${n.platform}): ${preview} [thread: ${n.thread_id}]`,
    });
  }
}, 10_000);
