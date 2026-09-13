import { config } from "dotenv";

config({ path: ".env.local" });
config();

// End-to-end check of a deployed agent MCP endpoint + the public-surface wall
// (planning/007-private-deployment, planning/008-agent-mcp-hardening).
//
// This is the AGENTS.md hand-off checklist as a command: run it against the
// deployment before pointing the agent at it, and again after any change.
//
//   npm run mcp:verify -- --url https://<host>/api/mcp --token "$CRM_AGENT_TOKEN"
//   MCP_URL=… CRM_AGENT_TOKEN=… npm run mcp:verify
//
// Every request it makes is a read. It never proposes a suggestion, never syncs
// repos, and never prints CRM rows — only shapes and counts.

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const url = arg("url", process.env.MCP_URL);
const token = arg("token", process.env.CRM_AGENT_TOKEN);

if (!url || !token) {
  console.error(
    "Usage: npm run mcp:verify -- --url <https://host/api/mcp> --token <CRM_AGENT_TOKEN>",
  );
  process.exit(1);
}

const origin = new URL(url).origin;

// The full catalog, split by what each tool is allowed to do. The split is the
// point: anything that can mutate must be one of exactly two names, and both
// land in the /inbox queue rather than writing CRM rows directly.
const READ_TOOLS = [
  "list_accounts",
  "get_account",
  "list_contacts",
  "get_contact",
  "list_opportunities",
  "get_opportunity",
  "list_tasks",
  "list_activities",
  "list_suggestions",
  "list_project_repos",
  "account_timeline",
  "list_stalled_opportunities",
];
const WRITE_TOOLS = ["propose_suggestion", "sync_project_repos"];
const EXPECTED_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS].sort();

// Paths that must NOT answer from the internet (plan 007).
const MUST_BE_404 = ["/", "/login", "/accounts", "/proposals", "/payments", "/inbox"];

let id = 0;
let failures = 0;

async function rpc(body, { auth = true } = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(auth ? { Authorization: `Bearer ${auth === true ? token : auth}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* leave null; the check reports the raw status */
  }

  return { status: response.status, body: parsed, text };
}

function check(label, passed, detail = "") {
  if (!passed) failures += 1;
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const call = (name, args) =>
  rpc({ jsonrpc: "2.0", id: (id += 1), method: "tools/call", params: { name, arguments: args } });

const rows = (response) => {
  const data = response.body?.result?.structuredContent;
  return Array.isArray(data) ? data : null;
};

console.log(`\nVerifying ${url}\n`);

// --- the public-surface wall ------------------------------------------------
console.log("  Public surface (plan 007)");
for (const path of MUST_BE_404) {
  const response = await fetch(`${origin}${path}`, { redirect: "manual" });
  check(`${path} is not reachable`, response.status === 404, `got ${response.status}`);
}

// --- auth -------------------------------------------------------------------
console.log("\n  Auth");
const noAuth = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { auth: false });
check("no Authorization header is rejected", noAuth.status === 401, `got ${noAuth.status}`);

const badAuth = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { auth: "wrong-token" });
check("a wrong bearer token is rejected", badAuth.status === 401, `got ${badAuth.status}`);

// --- handshake --------------------------------------------------------------
console.log("\n  Protocol");
const init = await rpc({
  jsonrpc: "2.0",
  id: (id += 1),
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "verify", version: "1" },
  },
});
check("initialize succeeds", init.status === 200 && Boolean(init.body?.result?.serverInfo));

const list = await rpc({ jsonrpc: "2.0", id: (id += 1), method: "tools/list" });
const names = (list.body?.result?.tools ?? []).map((tool) => tool.name).sort();
check(
  `tools/list advertises exactly the ${EXPECTED_TOOLS.length} known tools`,
  JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS),
  names.length ? names.join(", ") : "none returned",
);
check(
  "no tool outside the two approved write tools can mutate",
  names.every((name) => READ_TOOLS.includes(name) || WRITE_TOOLS.includes(name)),
  `unexpected: ${names.filter((n) => !EXPECTED_TOOLS.includes(n)).join(", ") || "none"}`,
);

// --- guard rails ------------------------------------------------------------
console.log("\n  Guard rails");
const rawSql = await call("run_sql", { sql: "select * from users" });
check(
  "a run_sql tool does not exist and is refused",
  rawSql.body?.result?.isError === true || Boolean(rawSql.body?.error),
  (rawSql.body?.result?.content?.[0]?.text ?? rawSql.body?.error?.message ?? "").slice(0, 60),
);

const overLimit = await call("list_accounts", { limit: 9999 });
const returned = rows(overLimit)?.length;
check(
  "an over-large limit is clamped, not honoured",
  typeof returned === "number" && returned <= 100,
  `returned ${returned} rows`,
);

// --- a real read ------------------------------------------------------------
console.log("\n  Reads");
const stuck = await call("list_stalled_opportunities", { stage: "negotiation" });
check(
  '"who is stuck in negotiation?" answers',
  Array.isArray(rows(stuck)),
  Array.isArray(rows(stuck)) ? `${rows(stuck).length} open negotiation(s)` : stuck.text?.slice(0, 80),
);

console.log(
  failures
    ? `\n${failures} check(s) failed.\n`
    : "\nAll checks passed. Safe to point the agent at this endpoint.\n",
);

process.exit(failures ? 1 : 0);
