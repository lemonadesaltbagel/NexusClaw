// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) — manages connections to MCP servers and
// exposes their tools as agent-callable tools.
//
// Config format (in ~/.claude/settings.json or .claude/settings.json):
//
//   {
//     "mcpServers": {
//       "filesystem": {
//         "command": "npx",
//         "args": ["@modelcontextprotocol/server-filesystem", "/tmp"],
//         "env": {}
//       }
//     }
//   }
// ---------------------------------------------------------------------------

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
  serverName: string;
}

// ---------------------------------------------------------------------------
// McpConnection — manages a single MCP server subprocess.
// Communicates via JSON-RPC 2.0 over stdin/stdout.
// ---------------------------------------------------------------------------

export class McpConnection {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private rl: Interface | null = null;

  constructor(
    private serverName: string,
    private config: McpServerConfig,
  ) {}

  // -----------------------------------------------------------------------
  // Transport — JSON-RPC 2.0 over stdin/stdout
  // -----------------------------------------------------------------------

  /** Send a request and wait for a response. */
  private sendRequest(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        return reject(new Error(`MCP server '${this.serverName}' is not connected`));
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.process.stdin.write(msg);
    });
  }

  /** Send a notification — don't wait for a response. */
  private sendNotification(method: string, params: any = {}): void {
    if (!this.process?.stdin?.writable) return;
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.process.stdin.write(msg);
  }

  // -----------------------------------------------------------------------
  // Lifecycle — spawn, handshake, teardown
  // -----------------------------------------------------------------------

  /** Spawn the server process and set up the JSON-RPC message loop. */
  async connect(): Promise<void> {
    const env = { ...process.env, ...(this.config.env || {}) };
    this.process = spawn(this.config.command, this.config.args || [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    this.process.on("error", (err) => {
      console.error(`[MCP/${this.serverName}] process error: ${err.message}`);
    });

    this.process.on("exit", (code) => {
      for (const [, { reject }] of this.pending) {
        reject(new Error(`MCP server "${this.serverName}" exited with code ${code}`));
      }
      this.pending.clear();
    });

    // Parse stdout line-by-line for JSON-RPC responses
    this.rl = createInterface({ input: this.process.stdout! });
    this.rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
          } else {
            resolve(msg.result);
          }
        }
      } catch {
        // Ignore non-JSON lines (server logs, etc.)
      }
    });

    // Run the MCP initialization handshake
    await this.initialize();
  }

  /** Disconnect from the MCP server. */
  async disconnect(): Promise<void> {
    this.rl?.close();
    this.rl = null;

    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }

    for (const [, { reject }] of this.pending) {
      reject(new Error(`MCP server "${this.serverName}" disconnected`));
    }
    this.pending.clear();
  }

  // -----------------------------------------------------------------------
  // Handshake, Discovery, and Invocation
  // -----------------------------------------------------------------------

  /** MCP initialization handshake. */
  async initialize(): Promise<void> {
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "nexus-claude", version: "1.0.0" },
    });
    // Send notification to confirm after successful handshake
    this.sendNotification("notifications/initialized");
  }

  /** Discover tools provided by the server. */
  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.sendRequest("tools/list");
    if (!result?.tools || !Array.isArray(result.tools)) return [];
    return result.tools.map((t: any) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema,
      serverName: this.serverName,
    }));
  }

  /** Call a tool and return the text result. */
  async callTool(name: string, args: any): Promise<string> {
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    if (result?.content && Array.isArray(result.content)) {
      return result.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
    }
    return JSON.stringify(result);
  }

  get name(): string {
    return this.serverName;
  }
}

// ---------------------------------------------------------------------------
// McpManager — loads config, manages connections, exposes unified tool list.
// ---------------------------------------------------------------------------

export class McpManager {
  private connections = new Map<string, McpConnection>();
  /** Maps prefixed tool name ("mcp__server__tool") → { connection, originalName } */
  private toolMap = new Map<
    string,
    { connection: McpConnection; originalName: string }
  >();

  /** Load MCP server configs from user + project settings. */
  static loadConfigs(): Record<string, McpServerConfig> {
    const configs: Record<string, McpServerConfig> = {};

    const paths = [
      join(homedir(), ".claude", "settings.json"),
      join(process.cwd(), ".claude", "settings.json"),
    ];

    for (const path of paths) {
      try {
        const text = readFileSync(path, "utf-8");
        const settings = JSON.parse(text);
        if (settings?.mcpServers && typeof settings.mcpServers === "object") {
          Object.assign(configs, settings.mcpServers);
        }
      } catch {
        // File doesn't exist or isn't valid JSON — skip
      }
    }

    return configs;
  }

  /** Connect to all configured MCP servers and discover their tools. */
  async connectAll(
    configs?: Record<string, McpServerConfig>,
  ): Promise<void> {
    const serverConfigs = configs ?? McpManager.loadConfigs();
    if (Object.keys(serverConfigs).length === 0) return;

    const results = await Promise.allSettled(
      Object.entries(serverConfigs).map(async ([name, config]) => {
        const conn = new McpConnection(name, config);
        try {
          await conn.connect();
          this.connections.set(name, conn);

          // Discover tools
          const tools = await conn.listTools();
          for (const tool of tools) {
            const prefixedName = `mcp__${name}__${tool.name}`;
            this.toolMap.set(prefixedName, {
              connection: conn,
              originalName: tool.name,
            });
          }

          console.error(
            `  ✓ MCP server "${name}" connected (${tools.length} tools)`,
          );
        } catch (err) {
          console.error(
            `  ✗ MCP server "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          await conn.disconnect().catch(() => {});
        }
      }),
    );
  }

  /** Discover tools from all connected servers and return agent-compatible definitions. */
  async discoverTools(): Promise<
    Array<{
      name: string;
      description: string;
      input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
    }>
  > {
    const defs: Array<{
      name: string;
      description: string;
      input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
    }> = [];

    for (const [, conn] of this.connections) {
      const tools = await conn.listTools();
      for (const tool of tools) {
        const prefixedName = `mcp__${conn.name}__${tool.name}`;
        defs.push({
          name: prefixedName,
          description: tool.description
            ? `[MCP/${tool.serverName}] ${tool.description}`
            : `[MCP/${tool.serverName}] ${tool.name}`,
          input_schema: {
            type: "object" as const,
            properties: tool.inputSchema?.properties ?? {},
            required: tool.inputSchema?.required,
          },
        });
      }
    }

    return defs;
  }

  /** Call an MCP tool by its prefixed name. */
  async callTool(
    prefixedName: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const entry = this.toolMap.get(prefixedName);
    if (!entry) {
      return `Unknown MCP tool: ${prefixedName}`;
    }
    try {
      return await entry.connection.callTool(entry.originalName, input);
    } catch (err) {
      return `MCP tool error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Check if a tool name belongs to MCP. */
  isMcpTool(name: string): boolean {
    return this.toolMap.has(name);
  }

  /** Disconnect all MCP servers. */
  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.connections.values()).map((c) =>
      c.disconnect().catch(() => {}),
    );
    await Promise.all(promises);
    this.connections.clear();
    this.toolMap.clear();
  }

  /** Number of connected servers. */
  get serverCount(): number {
    return this.connections.size;
  }

  /** Number of available MCP tools. */
  get toolCount(): number {
    return this.toolMap.size;
  }
}
