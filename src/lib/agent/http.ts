import { authorizeAgentRequest } from "@/lib/agent/auth";

export const AGENT_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
};

export function jsonWithCors(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(AGENT_CORS_HEADERS)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function emptyWithCors(init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(AGENT_CORS_HEADERS)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }
  return new Response(null, { ...init, headers });
}

export function agentAuthResponse(request: Request) {
  const result = authorizeAgentRequest(request);
  if (result.ok) {
    return null;
  }
  return jsonWithCors(
    { error: result.status === 503 ? "not_configured" : "unauthorized", message: result.error },
    { status: result.status },
  );
}

export function optionsResponse() {
  return emptyWithCors({ status: 204 });
}
