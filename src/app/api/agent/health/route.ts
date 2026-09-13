import { agentAuthResponse, jsonWithCors, optionsResponse } from "@/lib/agent/http";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsResponse();
}

export function GET(request: Request) {
  const denied = agentAuthResponse(request);
  if (denied) {
    return denied;
  }

  return jsonWithCors({
    ok: true,
    service: "toprock-crm-agent",
    mcp: "/api/mcp",
    sync: "/api/agent/sync-repos",
  });
}
