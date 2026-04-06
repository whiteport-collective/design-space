import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginsDirectory = path.resolve(__dirname, "..", "plugins");

const AGENT_ID = process.env.AGENT_ID;
const ORG_ID = process.env.ORG_ID;
const AGENT_SPACE_URL = process.env.AGENT_SPACE_URL || process.env.DESIGN_SPACE_URL;
const AGENT_SPACE_KEY =
  process.env.AGENT_SPACE_KEY ||
  process.env.DESIGN_SPACE_ANON_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const AGENT_NAME = process.env.AGENT_NAME || AGENT_ID;
const AGENT_PLATFORM = process.env.AGENT_PLATFORM || "claude-code";
const AGENT_PROJECT = process.env.AGENT_PROJECT || null;
const AGENT_REPO = process.env.AGENT_REPO || AGENT_PROJECT || null;
const AGENT_USER_ID = process.env.AGENT_USER_ID || null;
const AGENT_FRAMEWORK = process.env.AGENT_FRAMEWORK || null;

if (!AGENT_ID || !ORG_ID || !AGENT_SPACE_URL || !AGENT_SPACE_KEY) {
  console.error(
    [
      "Missing required environment variables for agent-space-mcp:",
      "  AGENT_ID",
      "  ORG_ID",
      "  AGENT_SPACE_URL (or DESIGN_SPACE_URL)",
      "  AGENT_SPACE_KEY (or DESIGN_SPACE_ANON_KEY)",
    ].join("\n"),
  );
  process.exit(1);
}

const supabase = createClient(AGENT_SPACE_URL, AGENT_SPACE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const PHASE_ONE_PROXY_PLUGINS = {
  fireflies: {
    display_name: "Fireflies",
    category: "plugin",
    sourceSlugs: ["fireflies", "external_intake"],
    fileName: "fireflies-stub.js",
    setup: "Load this module into local-mcp with load_plugin. It reads cached meeting transcripts from Agent Space.",
  },
  google_workspace: {
    display_name: "Google Workspace",
    category: "plugin",
    sourceSlugs: ["google_workspace"],
    fileName: "google-workspace-stub.js",
    setup: "Load this module into local-mcp with load_plugin after Idun enables Google Workspace sync for the org.",
  },
  github: {
    display_name: "GitHub",
    category: "plugin",
    sourceSlugs: ["github", "repo_files"],
    fileName: "github-stub.js",
    setup: "Load this module into local-mcp with load_plugin after Idun enables GitHub sync for the org.",
  },
};

const pluginCodeEntries = await Promise.all(
  Object.entries(PHASE_ONE_PROXY_PLUGINS).map(async ([pluginSlug, config]) => {
    const filePath = path.join(pluginsDirectory, config.fileName);
    const code = await fs.readFile(filePath, "utf8");
    return [pluginSlug, code];
  }),
);

const pluginCodeMap = new Map(pluginCodeEntries);

function asTextResult(text, structuredContent) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function getBaseAgentId(agentId) {
  const match = agentId?.match(/^(.+)-(\d{4})$/);
  return match ? match[1] : null;
}

async function fetchCatalogBySlug() {
  const { data, error } = await supabase
    .from("plugin_catalog")
    .select("plugin_slug, display_name, category");

  if (error) {
    throw error;
  }

  return new Map((data || []).map((row) => [row.plugin_slug, row]));
}

async function fetchOrgInstallations() {
  const { data, error } = await supabase
    .from("org_plugin_installations")
    .select("plugin_slug, status")
    .eq("org_id", ORG_ID);

  if (error) {
    throw error;
  }

  return new Map((data || []).map((row) => [row.plugin_slug, row.status]));
}

function resolveProxyPlugin(pluginSlug, catalogBySlug, installationsBySlug) {
  const config = PHASE_ONE_PROXY_PLUGINS[pluginSlug];
  if (!config) {
    return null;
  }

  const sourceRecord = config.sourceSlugs
    .map((slug) => catalogBySlug.get(slug))
    .find(Boolean);

  const authorized = config.sourceSlugs.some(
    (slug) => installationsBySlug.get(slug) === "active",
  );

  return {
    plugin_slug: pluginSlug,
    display_name: sourceRecord?.display_name || config.display_name,
    category: sourceRecord?.category || config.category,
    authorized,
    setup: config.setup,
    code: pluginCodeMap.get(pluginSlug),
  };
}

function computeSignal(message) {
  const baseAgentId = getBaseAgentId(AGENT_ID);
  const directIds = baseAgentId ? [AGENT_ID, baseAgentId] : [AGENT_ID];
  const toAgent = message.metadata?.to_agent || null;
  const fromAgent = message.metadata?.from_agent || null;
  const readBy = message.metadata?.read_by || [];
  const messageType = message.metadata?.message_type || "notification";
  const messageRepo = message.metadata?.repo || message.repo || null;
  const messageProject = message.project || null;
  const messageUserId = message.metadata?.user_id || null;

  const alreadyRead =
    readBy.includes(AGENT_ID) || (baseAgentId ? readBy.includes(baseAgentId) : false);
  if (alreadyRead) {
    return null;
  }

  if (messageType !== "handoff") {
    if (fromAgent === AGENT_ID || (baseAgentId && fromAgent === baseAgentId)) {
      return null;
    }
  }

  if (AGENT_USER_ID && messageUserId && messageUserId !== AGENT_USER_ID) {
    return null;
  }

  const agentMatch = toAgent && directIds.includes(toAgent);
  const scopeMatch =
    (AGENT_REPO && (messageRepo === AGENT_REPO || messageProject === AGENT_REPO)) ||
    (AGENT_PROJECT && messageProject === AGENT_PROJECT);
  const userMatch = AGENT_USER_ID && messageUserId === AGENT_USER_ID;

  let signal = "available";
  if (messageType === "handoff" && agentMatch && scopeMatch && userMatch) {
    signal = "urgent";
  } else if (agentMatch && scopeMatch) {
    signal = "strong";
  } else if (agentMatch) {
    signal = "medium";
  } else if (scopeMatch) {
    signal = "weak";
  }

  const signalWeight = {
    urgent: 0,
    strong: 1,
    medium: 2,
    weak: 3,
    available: 4,
  };

  return {
    ...message,
    signal,
    signal_weight: signalWeight[signal],
  };
}

const server = new McpServer({
  name: "agent-space-mcp",
  version: "0.1.0",
});

server.registerTool(
  "agent_space_list_plugins",
  {
    description: "List org proxy plugins.",
  },
  async () => {
    const [catalogBySlug, installationsBySlug] = await Promise.all([
      fetchCatalogBySlug(),
      fetchOrgInstallations(),
    ]);

    const plugins = Object.keys(PHASE_ONE_PROXY_PLUGINS)
      .map((pluginSlug) =>
        resolveProxyPlugin(pluginSlug, catalogBySlug, installationsBySlug),
      )
      .filter(Boolean)
      .map(({ plugin_slug, display_name, category, authorized }) => ({
        plugin_slug,
        display_name,
        category,
        authorized,
      }));

    return asTextResult(JSON.stringify(plugins, null, 2), { plugins });
  },
);

server.registerTool(
  "agent_space_get_plugin",
  {
    description: "Get proxy plugin code if authorized.",
    inputSchema: {
      plugin_slug: z.string().min(1),
    },
  },
  async ({ plugin_slug }) => {
    const [catalogBySlug, installationsBySlug] = await Promise.all([
      fetchCatalogBySlug(),
      fetchOrgInstallations(),
    ]);

    const plugin = resolveProxyPlugin(plugin_slug, catalogBySlug, installationsBySlug);
    if (!plugin) {
      throw new Error(`Unknown proxy plugin "${plugin_slug}".`);
    }

    if (!plugin.authorized) {
      return asTextResult(JSON.stringify({ authorized: false }, null, 2), {
        authorized: false,
      });
    }

    return asTextResult(
      `Authorized plugin "${plugin_slug}" ready for local-mcp load_plugin.`,
      {
        authorized: true,
        code: plugin.code,
        setup: plugin.setup,
      },
    );
  },
);

server.registerTool(
  "agent_space_check_messages",
  {
    description: "Get unread Agent Space messages.",
  },
  async () => {
    const { data, error } = await supabase
      .from("agent_space")
      .select("id, content, category, project, thread_id, metadata, created_at")
      .eq("category", "agent_message")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      throw error;
    }

    const messages = (data || [])
      .map((message) => computeSignal(message))
      .filter(Boolean)
      .sort((a, b) => {
        const signalDiff = a.signal_weight - b.signal_weight;
        if (signalDiff !== 0) {
          return signalDiff;
        }

        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      })
      .slice(0, 10)
      .map(({ signal_weight, ...message }) => message);

    return asTextResult(JSON.stringify(messages, null, 2), { messages });
  },
);

server.registerTool(
  "agent_space_post_message",
  {
    description: "Post an Agent Space message.",
    inputSchema: {
      to_agent: z.string().min(1).optional(),
      content: z.string().min(1),
      message_type: z.string().min(1).default("notification"),
      title: z.string().min(1).optional(),
    },
  },
  async ({ to_agent, content, message_type, title }) => {
    const payload = {
      content,
      category: "agent_message",
      project: AGENT_PROJECT,
      thread_id: randomUUID(),
      metadata: {
        from_agent: AGENT_ID,
        from_platform: AGENT_PLATFORM,
        to_agent: to_agent || null,
        message_type,
        title: title || null,
        priority: "normal",
        user_id: AGENT_USER_ID,
        repo: AGENT_REPO,
        read_by: [],
      },
    };

    const { data, error } = await supabase
      .from("agent_space")
      .insert(payload)
      .select("id, thread_id, created_at")
      .single();

    if (error) {
      throw error;
    }

    return asTextResult(
      `Posted ${message_type} message${to_agent ? ` to ${to_agent}` : ""}.`,
      {
        id: data.id,
        thread_id: data.thread_id,
        created_at: data.created_at,
      },
    );
  },
);

server.registerTool(
  "agent_space_update_status",
  {
    description: "Update current agent status.",
    inputSchema: {
      status: z.string().min(1),
      working_on: z.string().min(1).optional(),
    },
  },
  async ({ status, working_on }) => {
    const payload = {
      agent_id: AGENT_ID,
      agent_name: AGENT_NAME,
      platform: AGENT_PLATFORM,
      framework: AGENT_FRAMEWORK,
      project: AGENT_PROJECT,
      repo: AGENT_REPO,
      org_id: ORG_ID,
      status,
      working_on: working_on || null,
      last_heartbeat: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("agent_presence")
      .upsert(payload, { onConflict: "agent_id" });

    if (error) {
      throw error;
    }

    return asTextResult(`Updated status for ${AGENT_ID} to ${status}.`, payload);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
