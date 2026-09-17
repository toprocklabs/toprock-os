import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MCP_TOOLS } from "@/lib/agent/catalog";
import { handleMcpBody, handleMcpMessage, negotiateProtocolVersion, toStructuredContent } from "@/lib/agent/mcp";
import { AgentToolError } from "@/lib/agent/tools";

describe("negotiateProtocolVersion", () => {
  it("echoes a supported client version", () => {
    assert.equal(negotiateProtocolVersion("2025-06-18"), "2025-06-18");
  });

  it("falls back to Streamable HTTP 2025-03-26", () => {
    assert.equal(negotiateProtocolVersion("1999-01-01"), "2025-03-26");
  });
});

describe("toStructuredContent", () => {
  it("wraps a string as { text }", () => {
    assert.deepEqual(toStructuredContent("hello"), { text: "hello" });
  });

  it("wraps an array as { items } so Cursor's MCP client accepts list_* results", () => {
    const items = [{ id: 1 }, { id: 2 }];
    assert.deepEqual(toStructuredContent(items), { items });
    assert.deepEqual(toStructuredContent([]), { items: [] });
  });

  it("passes a plain object through", () => {
    const account = { id: 7, name: "Acme" };
    assert.equal(toStructuredContent(account), account);
  });

  it("wraps null, numbers, and booleans as { value }", () => {
    assert.deepEqual(toStructuredContent(null), { value: null });
    assert.deepEqual(toStructuredContent(42), { value: 42 });
    assert.deepEqual(toStructuredContent(true), { value: true });
  });
});

describe("handleMcpMessage", () => {
  it("initializes with tool capability and safety instructions", async () => {
    const response = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      },
      async () => null,
    );

    assert.ok(response);
    assert.equal(response.error, undefined);
    const result = response.result as {
      protocolVersion: string;
      capabilities: { tools: unknown };
      instructions: string;
    };
    assert.equal(result.protocolVersion, "2025-03-26");
    assert.ok(result.capabilities.tools);
    assert.match(result.instructions, /Never invent deal values/);
    assert.match(result.instructions, /Never contact clients/);
  });

  it("lists the PM agent tools", async () => {
    const response = await handleMcpMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      async () => null,
    );
    assert.ok(response);
    const tools = (response.result as { tools: { name: string }[] }).tools;
    const names = tools.map((tool) => tool.name);
    assert.deepEqual(
      names,
      MCP_TOOLS.map((tool) => tool.name),
    );
    assert.ok(names.includes("propose_suggestion"));
    assert.ok(names.includes("sync_project_repos"));
    assert.ok(names.includes("list_accounts"));
  });

  it("wraps a list tool array in structuredContent without changing the text payload", async () => {
    const accounts = [{ id: 1, name: "Acme" }, { id: 2, name: "Beta" }];
    const response = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_accounts", arguments: {} },
      },
      async () => accounts,
    );
    assert.ok(response);
    const result = response.result as {
      content: { type: string; text: string }[];
      structuredContent: unknown;
      isError: boolean;
    };
    assert.equal(result.isError, false);
    assert.equal(result.content[0].text, JSON.stringify(accounts, null, 2));
    assert.deepEqual(result.structuredContent, { items: accounts });
    assert.equal(typeof result.structuredContent, "object");
    assert.equal(Array.isArray(result.structuredContent), false);
  });

  it("returns a tool error payload for AgentToolError", async () => {
    const response = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "propose_suggestion", arguments: {} },
      },
      async () => {
        throw new AgentToolError("kind: Invalid option");
      },
    );
    assert.ok(response);
    const result = response.result as { isError: boolean; content: { text: string }[] };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /kind: Invalid option/);
  });

  it("acks initialized notifications without a body", async () => {
    const handled = await handleMcpBody(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      async () => null,
    );
    assert.equal(handled.kind, "ack");
    assert.equal(handled.status, 202);
  });

  it("rejects a non-JSON-RPC payload", async () => {
    const handled = await handleMcpBody({ hello: "world" }, async () => null);
    assert.equal(handled.kind, "error");
    assert.equal(handled.status, 400);
  });
});
