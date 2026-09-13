import { agentAuthResponse, jsonWithCors, optionsResponse } from "@/lib/agent/http";
import { AgentToolError, dispatchAgentTool } from "@/lib/agent/tools";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export function OPTIONS() {
  return optionsResponse();
}

export async function POST(request: Request) {
  const denied = agentAuthResponse(request);
  if (denied) {
    return denied;
  }

  const db = getDb();
  if (!db) {
    return jsonWithCors({ error: "not_configured", message: "DATABASE_URL is not set." }, { status: 503 });
  }

  let dryRun = false;
  const text = await request.text();
  if (text.trim()) {
    try {
      const body = JSON.parse(text) as { dryRun?: unknown };
      dryRun = body.dryRun === true;
    } catch {
      return jsonWithCors({ error: "invalid_json", message: "Body must be JSON." }, { status: 400 });
    }
  }

  try {
    const result = await dispatchAgentTool("sync_project_repos", { dryRun }, db);
    return jsonWithCors({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed.";
    const status = error instanceof AgentToolError ? 400 : 502;
    return jsonWithCors({ error: "sync_failed", message }, { status });
  }
}
