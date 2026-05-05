import { test, expect, describe, beforeEach } from "bun:test";
import { McpManager, McpConnection, type McpServerConfig, type McpToolInfo } from "@/core/mcp";

// ---------------------------------------------------------------------------
// McpManager — tool definitions and routing (unit-testable without subprocesses)
// ---------------------------------------------------------------------------

describe("McpManager", () => {
  describe("isMcpTool", () => {
    test("returns true for mcp__ prefixed names", () => {
      const mgr = new McpManager();
      expect(mgr.isMcpTool("mcp__filesystem__read")).toBe(true);
      expect(mgr.isMcpTool("mcp__github__list_repos")).toBe(true);
    });

    test("returns false for non-MCP tool names", () => {
      const mgr = new McpManager();
      expect(mgr.isMcpTool("read_file")).toBe(false);
      expect(mgr.isMcpTool("write_file")).toBe(false);
      expect(mgr.isMcpTool("mcpread")).toBe(false);
      expect(mgr.isMcpTool("")).toBe(false);
    });
  });

  describe("callTool — name parsing", () => {
    test("throws for names with fewer than 3 parts", async () => {
      const mgr = new McpManager();
      await expect(mgr.callTool("mcp__server", {})).rejects.toThrow("Invalid MCP tool name");
    });

    test("throws for single-part name", async () => {
      const mgr = new McpManager();
      await expect(mgr.callTool("something", {})).rejects.toThrow("Invalid MCP tool name");
    });

    test("throws when server is not connected", async () => {
      const mgr = new McpManager();
      await expect(mgr.callTool("mcp__unknown__tool", {})).rejects.toThrow("not connected");
    });

    test("handles tool names containing double underscores", async () => {
      const mgr = new McpManager();
      // Should parse "mcp__server__tool__with__underscores" → server="server", tool="tool__with__underscores"
      await expect(mgr.callTool("mcp__server__tool__with__underscores", {})).rejects.toThrow("not connected");
      // The error message proves it parsed serverName as "server" correctly
    });
  });

  describe("getToolDefinitions", () => {
    test("returns empty array when no servers connected", () => {
      const mgr = new McpManager();
      const defs = mgr.getToolDefinitions();
      expect(defs).toEqual([]);
    });
  });

  describe("serverCount and toolCount", () => {
    test("initially zero", () => {
      const mgr = new McpManager();
      expect(mgr.serverCount).toBe(0);
      expect(mgr.toolCount).toBe(0);
    });
  });

  describe("closeAll", () => {
    test("resets state to empty", () => {
      const mgr = new McpManager();
      mgr.closeAll();
      expect(mgr.serverCount).toBe(0);
      expect(mgr.toolCount).toBe(0);
      expect(mgr.getToolDefinitions()).toEqual([]);
    });
  });

  describe("loadAndConnect — idempotency", () => {
    test("second call is a no-op when no config files exist", async () => {
      const mgr = new McpManager();
      await mgr.loadAndConnect();
      await mgr.loadAndConnect(); // Should not throw or double-connect
      expect(mgr.serverCount).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// McpConnection — unit tests for close behavior
// ---------------------------------------------------------------------------

describe("McpConnection", () => {
  test("close does not throw when never connected", () => {
    const conn = new McpConnection("test-server", { command: "echo" });
    // Should be safe to close without connecting
    expect(() => conn.close()).not.toThrow();
  });

  test("name getter returns server name", () => {
    const conn = new McpConnection("my-server", { command: "echo" });
    expect(conn.name).toBe("my-server");
  });
});
