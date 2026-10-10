import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DELETE, GET, OPTIONS, POST } from "@/app/api/mcp/route";

const TOKEN = "t".repeat(32);
const ENDPOINT = "https://crm.test/api/mcp";

const saved: Record<string, string | undefined> = {};

before(() => {
  for (const key of ["CRM_AGENT_TOKEN", "DATABASE_URL", "MCP_DATABASE_URL"]) {
    saved[key] = process.env[key];
  }
  process.env.CRM_AGENT_TOKEN = TOKEN;
  delete process.env.DATABASE_URL;
  delete process.env.MCP_DATABASE_URL;
});

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function request(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(ENDPOINT, {
    method,
    headers: {
      Accept: "application/json, text/event-stream",
      ...headers,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function authed(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return request(method, body, { Authorization: `Bearer ${TOKEN}`, ...headers });
}

describe("MCP Streamable HTTP methods", () => {
  it("answers GET with 405 so an SSE client does not reconnect", async () => {
    const response = GET();
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST, OPTIONS");
    assert.equal(response.headers.get("mcp-session-id"), null);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.doesNotMatch(response.headers.get("content-type") ?? "", /text\/event-stream/);

    const body = (await response.json()) as {
      jsonrpc: string;
      id: null;
      error: { code: number; message: string };
    };
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, null);
    assert.equal(body.error.code, -32000);
    assert.match(body.error.message, /does not offer an SSE stream/);
  });

  it("answers DELETE with 405 because no session is stored", async () => {
    const response = DELETE();
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST, OPTIONS");
    assert.equal(response.headers.get("mcp-session-id"), null);
    const body = (await response.json()) as { error: { message: string } };
    assert.match(body.error.message, /does not support session termination/);
  });

  it("answers OPTIONS with the methods the endpoint actually offers", async () => {
    const response = OPTIONS();
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assert.equal(response.headers.get("allow"), "POST, OPTIONS");
    assert.equal(response.headers.get("access-control-allow-methods"), "POST, OPTIONS");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });

  it("still accepts POST initialize, tools/list, and a tool call", async () => {
    const init = await POST(
      authed("POST", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "route-test", version: "1" },
        },
      }),
    );
    assert.equal(init.status, 200);
    const initBody = (await init.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string }; capabilities: { tools: unknown } };
    };
    assert.equal(initBody.result.protocolVersion, "2025-06-18");
    assert.equal(initBody.result.serverInfo.name, "toprock-crm");
    assert.ok(initBody.result.capabilities.tools);
    assert.match(init.headers.get("mcp-session-id") ?? "", /^[0-9a-f-]{36}$/i);
    assert.equal(init.headers.get("access-control-allow-methods"), "POST, OPTIONS");

    const list = await POST(authed("POST", { jsonrpc: "2.0", id: 2, method: "tools/list" }));
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as { result: { tools: { name: string }[] } };
    const names = listBody.result.tools.map((tool) => tool.name);
    for (const name of [
      "list_accounts",
      "get_account",
      "account_timeline",
      "list_activities",
      "propose_suggestion",
      "sync_project_repos",
    ]) {
      assert.ok(names.includes(name), name);
    }

    const call = await POST(
      authed("POST", {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_accounts", arguments: {} },
      }),
    );
    assert.equal(call.status, 200);
    const callBody = (await call.json()) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    assert.equal(callBody.result.isError, true);
    assert.match(callBody.result.content[0].text, /DATABASE_URL is not set/);

    const ack = await POST(
      authed("POST", { jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    assert.equal(ack.status, 202);
  });

  it("still rejects a POST with no bearer token", async () => {
    const response = await POST(request("POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    assert.equal(response.status, 401);
  });
});
