import { randomUUID } from "node:crypto";
import { agentAuthResponse, emptyWithCors, jsonWithCors, optionsResponse } from "@/lib/agent/http";
import {
  handleMcpBody,
  MCP_DEFAULT_PROTOCOL,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  parseJsonBody,
} from "@/lib/agent/mcp";
import { AgentToolError, dispatchAgentTool } from "@/lib/agent/tools";
import { getDb, getReadOnlyDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function sessionHeaders(request: Request) {
  return {
    "Mcp-Session-Id": request.headers.get("mcp-session-id") ?? randomUUID(),
    "MCP-Protocol-Version": request.headers.get("mcp-protocol-version") ?? MCP_DEFAULT_PROTOCOL,
  };
}

export function OPTIONS() {
  return optionsResponse();
}

export function GET(request: Request) {
  const denied = agentAuthResponse(request);
  if (denied) {
    return denied;
  }

  return jsonWithCors(
    {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      transport: "streamable-http",
      protocolVersion: MCP_DEFAULT_PROTOCOL,
      endpoint: "/api/mcp",
      auth: "Authorization: Bearer <CRM_AGENT_TOKEN>",
    },
    { headers: sessionHeaders(request) },
  );
}

export function DELETE(request: Request) {
  const denied = agentAuthResponse(request);
  if (denied) {
    return denied;
  }
  return emptyWithCors({ status: 200, headers: sessionHeaders(request) });
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
