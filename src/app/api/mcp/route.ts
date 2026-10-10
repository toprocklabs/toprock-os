import { randomUUID } from "node:crypto";
import { agentAuthResponse, emptyWithCors, jsonWithCors, methodNotAllowed } from "@/lib/agent/http";
import { handleMcpBody, MCP_DEFAULT_PROTOCOL, parseJsonBody } from "@/lib/agent/mcp";
import { AgentToolError, dispatchAgentTool } from "@/lib/agent/tools";
import { getDb, getReadOnlyDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// POST carries JSON-RPC. OPTIONS is the CORS preflight. GET is intentionally
// rejected: this server never pushes server-initiated messages, so it must not
// answer the optional SSE stream with a 200 that ends immediately.
const MCP_ALLOW = "POST, OPTIONS";

function sessionHeaders(request: Request) {
  return {
    "Mcp-Session-Id": request.headers.get("mcp-session-id") ?? randomUUID(),
    "MCP-Protocol-Version": request.headers.get("mcp-protocol-version") ?? MCP_DEFAULT_PROTOCOL,
    // Shared CORS still lists GET for the other agent routes. This endpoint does not.
    "Access-Control-Allow-Methods": MCP_ALLOW,
  };
}

export function OPTIONS() {
  return emptyWithCors({
    status: 204,
    headers: {
      Allow: MCP_ALLOW,
      "Access-Control-Allow-Methods": MCP_ALLOW,
    },
  });
}

// Spec (2025-03-26 Streamable HTTP): a GET either opens `text/event-stream`
// or returns 405. A JSON 200 that closes is a dropped stream. Clients such as
// the TypeScript and Python SDKs then reconnect, and only a 405 stops them.
// Answer 405 before auth so a missing token cannot turn the same loop into 401s.
export function GET() {
  return methodNotAllowed(MCP_ALLOW, "Method not allowed. This server does not offer an SSE stream.");
}

// No session is stored. 405 is the spec's signal that clients cannot terminate
// one. A 200 here also minted a fresh Mcp-Session-Id whenever the header was
// absent, which told clients a session existed.
export function DELETE() {
  return methodNotAllowed(
    MCP_ALLOW,
    "Method not allowed. This server does not support session termination.",
  );
}

export async function POST(request: Request) {
  const denied = agentAuthResponse(request);
  if (denied) {
    return denied;
  }

  const text = await request.text();
  const parsed = parseJsonBody(text);
  if (!parsed.ok) {
    return jsonWithCors(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400, headers: sessionHeaders(request) },
    );
  }

  const db = getDb();
  // Read tools run on the SELECT-only role; writes stay on the read/write
  // connection and remain gated by the /inbox queue (plan 008).
  const readDb = getReadOnlyDb();
  const result = await handleMcpBody(parsed.value, async (name, args) => {
    if (!db) {
      throw new AgentToolError("DATABASE_URL is not set.");
    }
    return dispatchAgentTool(name, args, db, readDb ?? db);
  });
  if (result.kind === "ack") {
    return emptyWithCors({ status: 202, headers: sessionHeaders(request) });
  }

  return jsonWithCors(result.response, {
    status: result.status,
    headers: sessionHeaders(request),
  });
}
