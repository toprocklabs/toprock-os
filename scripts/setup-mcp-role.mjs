import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";

config({ path: ".env.local" });
config();

// Provisions the SELECT-only Neon role the MCP endpoint reads through
// (planning/006-mcp-read-api, phase 2), then PROVES it is read-only by asking
// Postgres what the role can actually do to every table in the schema.
//
// The proof is a catalog query (has_table_privilege), not a trial INSERT: if the
// grants were somehow wrong, a trial write would succeed and leave a row behind.
// Asking the catalog can never mutate anything.
//
//   node scripts/setup-mcp-role.mjs --dry-run
//   node scripts/setup-mcp-role.mjs
//   node scripts/setup-mcp-role.mjs --role crm_mcp_ro --password '...'
//   node scripts/setup-mcp-role.mjs --audit-only
//
// DATABASE_URL must be the ADMIN connection (neondb_owner) — the role that owns
// the tables, since only an owner can grant SELECT on them.

// The seven tables the READ_ONLY_TOOLS in src/lib/agent/tools.ts touch.
// Everything else in the schema — users, proposals, proposal_documents,
// payments, stripe_subscriptions, agent_runs, relationships, place_enrichment —
// must stay unreadable through this role.
//
// agent_runs is deliberately absent: it is only ever written (run bookkeeping),
// and writes go through the read/write connection, never this role.
const READABLE_TABLES = [
  "companies",
  "contacts",
  "deals",
  "activities",
  "sales_tasks",
  "suggestions",
  "project_repos",
];

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dryRun = process.argv.includes("--dry-run");
const auditOnly = process.argv.includes("--audit-only");
const role = arg("role", "crm_mcp_ro");

if (!/^[a-z_][a-z0-9_]{2,62}$/.test(role)) {
  console.error(`Refusing role name "${role}" — use lowercase letters, digits and underscores.`);
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is missing. Add the ADMIN Neon connection string to .env.local, or run:\n" +
      "  DATABASE_URL='postgresql://…' node scripts/setup-mcp-role.mjs",
  );
  process.exit(1);
}

const adminUrl = new URL(process.env.DATABASE_URL);
const database = adminUrl.pathname.replace(/^\//, "") || "neondb";

// base64url: no quoting or percent-encoding surprises in a connection string.
const password = arg("password", randomBytes(24).toString("base64url"));
const quoted = (value) => `'${String(value).replaceAll("'", "''")}'`;

// Deliberately NOT `ALTER DEFAULT PRIVILEGES … GRANT SELECT ON TABLES`: that
// would silently hand the role every table added in the future, which is the
// opposite of an allowlist. New tables must be granted here, on purpose.
const grantStatements = [
  `GRANT CONNECT ON DATABASE "${database}" TO "${role}"`,
  `GRANT USAGE ON SCHEMA public TO "${role}"`,
  ...READABLE_TABLES.map((table) => `GRANT SELECT ON public."${table}" TO "${role}"`),
];

const sql = neon(process.env.DATABASE_URL);

async function ensureRole() {
  // Dry run stays offline so the exact SQL can be reviewed without credentials.
  if (dryRun) {
    console.log(`-- new role:\nCREATE ROLE "${role}" WITH LOGIN PASSWORD '<password>';`);
    console.log(`-- or, if it already exists:\nALTER ROLE "${role}" WITH LOGIN PASSWORD '<password>';`);
    for (const grant of grantStatements) console.log(`${grant};`);
    return false;
  }

  const existing = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`;

  const statement = existing.length
    ? `ALTER ROLE "${role}" WITH LOGIN PASSWORD ${quoted(password)}`
    : `CREATE ROLE "${role}" WITH LOGIN PASSWORD ${quoted(password)}`;

  await sql.query(statement);
  for (const grant of grantStatements) {
    await sql.query(grant);
  }

  return existing.length;
}

// What can this role ACTUALLY do, according to Postgres? Covers every table in
// the schema, so a table that should be invisible showing `select: yes` is
// impossible to miss.
async function audit() {
  const rows = await sql`
    SELECT
      tablename,
      has_table_privilege(${role}, format('public.%I', tablename), 'SELECT') AS can_select,
      has_table_privilege(${role}, format('public.%I', tablename), 'INSERT') AS can_insert,
      has_table_privilege(${role}, format('public.%I', tablename), 'UPDATE') AS can_update,
      has_table_privilege(${role}, format('public.%I', tablename), 'DELETE') AS can_delete
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `;

  let failures = 0;
  console.log(`\nPrivileges of "${role}" on every table in public:\n`);
  console.log("  table                     select  insert  update  delete");
  console.log("  ----------------------------------------------------------");

  for (const row of rows) {
    const expectSelect = READABLE_TABLES.includes(row.tablename);
    const writable = row.can_insert || row.can_update || row.can_delete;
    const wrong = row.can_select !== expectSelect || writable;
    if (wrong) failures += 1;

    const mark = (value) => (value ? "  yes " : "  --  ");
    console.log(
      `  ${row.tablename.padEnd(24)}${mark(row.can_select)}  ${mark(row.can_insert)}  ` +
        `${mark(row.can_update)}  ${mark(row.can_delete)}${wrong ? "   <-- UNEXPECTED" : ""}`,
    );
  }

  console.log("");

  if (failures) {
    console.error(
      `FAIL: ${failures} table(s) have privileges this role should not have. Do not deploy.`,
    );
    process.exit(1);
  }

  console.log(`OK: "${role}" can SELECT exactly ${READABLE_TABLES.length} tables and write none.`);
  return rows;
}

if (auditOnly) {
  await audit();
  process.exit(0);
}

const rotated = await ensureRole();

if (dryRun) {
  console.log("\nDry run — nothing was executed.");
  process.exit(0);
}

console.log(rotated ? `Rotated the password on existing role "${role}".` : `Created role "${role}".`);

await audit();

// Same host and database, different credentials.
const mcpUrl = new URL(adminUrl.toString());
mcpUrl.username = role;
mcpUrl.password = password;

console.log("\nSet these in Vercel (Production only) and nowhere else:\n");
console.log(`MCP_DATABASE_URL=${mcpUrl.toString()}`);
console.log(`MCP_BEARER_TOKEN=${randomBytes(32).toString("base64url")}`);
console.log(
  "\nThe password above is shown once. Vercel is the only place it needs to live;" +
    "\nre-run this script to rotate it.",
);
