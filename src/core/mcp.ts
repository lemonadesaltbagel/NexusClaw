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
import { readFileSync, existsSync } from "node:fs";

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
  }

  /** Tear down the connection — kill process, reject pending requests. */
  close(): void {
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
  private tools: McpToolInfo[] = [];
  private connected = false;

  // -----------------------------------------------------------------------
  // Configuration Loading
  // -----------------------------------------------------------------------

  /** Load and merge MCP server configs from all config sources. */
  private loadConfigs(): Record<string, McpServerConfig> {
    const merged: Record<string, McpServerConfig> = {};

    // 1. User-level: ~/.claude/settings.json
    const globalPath = join(homedir(), ".claude", "settings.json");
    this.mergeConfigFile(globalPath, merged);

    // 2. Project-level: .claude/settings.json
    const projectPath = join(process.cwd(), ".claude", "settings.json");
    this.mergeConfigFile(projectPath, merged);

    // 3. MCP-specific: .mcp.json
    const mcpJsonPath = join(process.cwd(), ".mcp.json");
    this.mergeConfigFile(mcpJsonPath, merged);

    return merged;
  }

  /** Merge MCP server entries from a single config file into the target. */
  private mergeConfigFile(
    filePath: string,
    target: Record<string, McpServerConfig>,
  ): void {
    if (!existsSync(filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      const servers = raw.mcpServers || raw; // .mcp.json may be a flat server mapping
      for (const [name, config] of Object.entries(servers)) {
        if (this.isValidConfig(config)) {
          target[name] = config as McpServerConfig;
        }
      }
    } catch {
      // Silently skip malformed config files
    }
  }

  /** Validate that a config object has the required shape. */
  private isValidConfig(config: unknown): config is McpServerConfig {
    if (!config || typeof config !== "object") return false;
    const c = config as Record<string, unknown>;
    return typeof c.command === "string";
  }

  // -----------------------------------------------------------------------
  // Connection and Discovery
  // -----------------------------------------------------------------------

  private static readonly TIMEOUT_MS = 15_000;

  /** Load configs, connect to all servers, and discover tools. Idempotent. */
  async loadAndConnect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;

    const configs = this.loadConfigs();
    if (Object.keys(configs).length === 0) return;

    for (const [name, config] of Object.entries(configs)) {
      const conn = new McpConnection(name, config);
      try {
        await conn.connect();

        // Handshake with timeout
        await Promise.race([
          conn.initialize(),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error("timeout")), McpManager.TIMEOUT_MS),
          ),
        ]);

        // Tool discovery with timeout
        const serverTools = await Promise.race([
          conn.listTools(),
          new Promise<McpToolInfo[]>((_, rej) =>
            setTimeout(() => rej(new Error("timeout")), McpManager.TIMEOUT_MS),
          ),
        ]);

        this.connections.set(name, conn);
        this.tools.push(...serverTools);

        console.error(
          `[mcp] Connected to '${name}' — ${serverTools.length} tools`,
        );
      } catch (err: any) {
        console.error(
          `[mcp] Failed to connect to '${name}': ${err.message}`,
        );
        conn.close();
      }
    }
  }

  /** Return agent-compatible tool definitions for all discovered MCP tools. */
  getToolDefinitions(): Array<{ name: string; description: string; input_schema: any }> {
    return this.tools.map((t) => ({
      name: `mcp__${t.serverName}__${t.name}`,
      description: t.description || `MCP tool ${t.name} from ${t.serverName}`,
      input_schema: t.inputSchema || { type: "object", properties: {} },
    }));
  }

  /** Check if a tool name belongs to MCP. */
  isMcpTool(name: string): boolean {
    return name.startsWith("mcp__");
  }

  /** Route a prefixed tool call to the correct server connection. */
  async callTool(prefixedName: string, args: any): Promise<string> {
    // mcp__serverName__toolName → serverName, toolName
    const parts = prefixedName.split("__");
    if (parts.length < 3) throw new Error(`Invalid MCP tool name: ${prefixedName}`);
    const serverName = parts[1]!;
    const toolName = parts.slice(2).join("__"); // Tool name might contain __
    const conn = this.connections.get(serverName);
    if (!conn) throw new Error(`MCP server '${serverName}' not connected`);
    return conn.callTool(toolName, args);
  }

  /** Close all MCP server connections. */
  closeAll(): void {
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
    this.tools = [];
  }

  /** Number of connected servers. */
  get serverCount(): number {
    return this.connections.size;
  }

  /** Number of available MCP tools. */
  get toolCount(): number {
    return this.tools.length;
  }
}
