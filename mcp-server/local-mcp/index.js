import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const toolsDirectory = path.join(__dirname, "tools");

const server = new McpServer({
  name: "local-mcp",
  version: "0.1.0",
});

const loadedModules = new Map();
const toolOwners = new Map();

function sanitizePluginName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatToolList(toolNames) {
  return toolNames.length === 0 ? "none" : toolNames.join(", ");
}

function validateModuleTools(pluginName, tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error(`Plugin "${pluginName}" did not export a non-empty tools array.`);
  }

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") {
      throw new Error(`Plugin "${pluginName}" exported an invalid tool definition.`);
    }

    if (!tool.name || typeof tool.name !== "string") {
      throw new Error(`Plugin "${pluginName}" exported a tool without a valid name.`);
    }

    if (typeof tool.handler !== "function") {
      throw new Error(`Plugin "${pluginName}" tool "${tool.name}" is missing a handler.`);
    }
  }
}

async function importPluginModule(filePath) {
  const moduleUrl = `${pathToFileURL(filePath).href}?ts=${Date.now()}`;
  return import(moduleUrl);
}

async function unloadPlugin(pluginName) {
  const existing = loadedModules.get(pluginName);
  if (!existing) {
    return;
  }

  for (const entry of existing.handles) {
    entry.handle.remove();
    toolOwners.delete(entry.name);
  }

  loadedModules.delete(pluginName);
}

function registerPluginTools(pluginName, tools) {
  const handles = [];

  for (const tool of tools) {
    const owner = toolOwners.get(tool.name);
    if (owner && owner !== pluginName) {
      throw new Error(`Tool "${tool.name}" is already owned by plugin "${owner}".`);
    }

    const handle = server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
        _meta: tool._meta,
      },
      async (args = {}, extra) => tool.handler(args, extra),
    );

    handles.push({ name: tool.name, handle });
    toolOwners.set(tool.name, pluginName);
  }

  loadedModules.set(pluginName, {
    toolNames: handles.map((entry) => entry.name),
    handles,
  });

  return handles.map((entry) => entry.name);
}

async function loadPluginFromFile(pluginName, filePath) {
  const module = await importPluginModule(filePath);
  const exportedTools = module.tools ?? module.default?.tools;

  validateModuleTools(pluginName, exportedTools);
  await unloadPlugin(pluginName);

  return registerPluginTools(pluginName, exportedTools);
}

async function ensureToolsDirectory() {
  await fs.mkdir(toolsDirectory, { recursive: true });
}

async function autoLoadToolsDirectory() {
  await ensureToolsDirectory();

  const entries = await fs.readdir(toolsDirectory, { withFileTypes: true });
  const pluginFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".js"))
    .filter((name) => !name.startsWith("_loaded_"))
    .sort();

  const loaded = [];
  for (const fileName of pluginFiles) {
    const pluginName = path.basename(fileName, ".js");
    const filePath = path.join(toolsDirectory, fileName);
    const toolNames = await loadPluginFromFile(pluginName, filePath);
    loaded.push({ pluginName, toolNames });
  }

  return loaded;
}

server.registerTool(
  "load_plugin",
  {
    description:
      "Load a plugin module at runtime by writing its code to disk and registering its exported tools.",
    inputSchema: {
      name: z.string().min(1).describe("Plugin name"),
      code: z.string().min(1).describe("JavaScript module source"),
    },
  },
  async ({ name, code }) => {
    const pluginName = sanitizePluginName(name);
    if (!pluginName) {
      throw new Error("Plugin name resolved to an empty slug after sanitization.");
    }

    await ensureToolsDirectory();

    const filePath = path.join(toolsDirectory, `_loaded_${pluginName}.js`);
    await fs.writeFile(filePath, code, "utf8");

    const toolNames = await loadPluginFromFile(pluginName, filePath);

    return {
      content: [
        {
          type: "text",
          text: `Loaded plugin "${pluginName}" with tools: ${formatToolList(toolNames)}.`,
        },
      ],
      structuredContent: {
        plugin_name: pluginName,
        path: filePath,
        tool_names: toolNames,
      },
    };
  },
);

await autoLoadToolsDirectory();

const transport = new StdioServerTransport();
await server.connect(transport);
