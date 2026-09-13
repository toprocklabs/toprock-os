import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "@/lib/schema";

let cachedDb: ReturnType<typeof drizzle<typeof schema>> | null = null;

export type CrmDb = ReturnType<typeof drizzle<typeof schema>>;

export function getDb() {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  if (!cachedDb) {
    cachedDb = drizzle(process.env.DATABASE_URL, { schema });
  }

  return cachedDb;
}

// The connection the agent's READ tools go through (planning/008-agent-mcp-hardening).
// MCP_DATABASE_URL should point at a Neon role granted nothing but SELECT on the
// seven tables those tools touch, so a bug in a read tool cannot become a write.
// Writes (propose_suggestion, sync_project_repos, agent_runs bookkeeping) keep
// using getDb() and stay gated by the /inbox approval queue.
//
// Falls back to DATABASE_URL so the endpoint works before the role exists —
// loudly, because then only the code-level guarantees are in force.
let cachedReadOnlyDb: CrmDb | null = null;

export function getReadOnlyDb() {
  const url = process.env.MCP_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!url) {
    return null;
  }

  if (!cachedReadOnlyDb) {
    if (!process.env.MCP_DATABASE_URL) {
      console.warn(
        "[agent] MCP_DATABASE_URL is not set \u2014 read tools are using the read/write DATABASE_URL.",
      );
    }

    cachedReadOnlyDb = drizzle(url, { schema });
  }

  return cachedReadOnlyDb;
}
