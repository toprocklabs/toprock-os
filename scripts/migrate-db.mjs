import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";

config({ path: ".env.local" });
config();

// Copies an entire CRM database into a fresh one, then checks its own work
// (planning/007-private-deployment).
//
//   npm run db:migrate -- --from "$OLD_URL" --to "$NEW_URL" --dry-run
//   npm run db:migrate -- --from "$OLD_URL" --to "$NEW_URL"
//
// The source is only ever READ. Nothing here writes to, drops, or alters the
// old database, so it stays intact as a fallback.

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const from = arg("from", process.env.FROM_DATABASE_URL);
const to = arg("to", process.env.TO_DATABASE_URL);

if (!from || !to) {
  console.error(
    "Usage: npm run db:migrate -- --from <old connection string> --to <new connection string> [--dry-run] [--force]",
  );
  process.exit(1);
}

if (from === to) {
  console.error("Source and target are the same database. Refusing.");
  process.exit(1);
}

function describe(url) {
  const parsed = new URL(url);
  return { host: parsed.hostname, database: parsed.pathname.replace(/^\//, "") || "neondb" };
}

// Neon's -pooler endpoint is for short serverless queries; a dump or restore
// through it can be cut off mid-transfer. The direct endpoint is the same
// hostname without "-pooler".
function warnIfPooled(label, url) {
  if (new URL(url).hostname.includes("-pooler")) {
    console.warn(
      `  WARNING: ${label} uses Neon's pooled endpoint. Use the direct (non-pooler) host for a dump/restore.`,
    );
  }
}

async function tableCounts(url) {
  const sql = neon(url);
  const tables = await sql`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `;

  const counts = new Map();
  for (const { tablename } of tables) {
    // Table names come from the catalog, not from user input.
    const [row] = await sql.query(`SELECT count(*)::int AS n FROM public."${tablename}"`);
    counts.set(tablename, row.n);
  }

  return counts;
}

function report(before, after) {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();

  if (names.length === 0) {
    console.log("  (no tables)");
    return 0;
  }

  let mismatches = 0;
  console.log("  table                       source    target");
  console.log("  ------------------------------------------------");

  for (const name of names) {
    const source = before.get(name);
    const target = after.get(name);
    const bad = source !== target;
    if (bad) mismatches += 1;

    console.log(
      `  ${name.padEnd(26)}${String(source ?? "-").padStart(6)}    ${String(target ?? "-").padStart(6)}` +
        (bad ? "   <-- MISMATCH" : ""),
    );
  }

  return mismatches;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });

  if (result.error?.code === "ENOENT") {
    console.error(
      `\n${command} is not installed. Install the PostgreSQL client tools (e.g. \`sudo pacman -S postgresql\`) and re-run.`,
    );
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`\n${command} exited with code ${result.status}.`);
    process.exit(result.status ?? 1);
  }
}

const source = describe(from);
const target = describe(to);

console.log(`\nSource: ${source.database} @ ${source.host}  (read-only)`);
warnIfPooled("source", from);
console.log(`Target: ${target.database} @ ${target.host}`);
warnIfPooled("target", to);

console.log("\nCounting rows...");
const sourceCounts = await tableCounts(from);
const targetCountsBefore = await tableCounts(to);

console.log("\nBefore:");
report(sourceCounts, targetCountsBefore);

const sourceRows = [...sourceCounts.values()].reduce((total, n) => total + n, 0);
const targetRows = [...targetCountsBefore.values()].reduce((total, n) => total + n, 0);

if (sourceRows === 0) {
  console.error("\nThe source database has no rows. Nothing to migrate — check the connection string.");
  process.exit(1);
}

if (targetRows > 0 && !force) {
  console.error(
    `\nThe target already holds ${targetRows} row(s). Restoring into a non-empty database` +
      "\nproduces duplicates and broken id sequences. Re-run with --force only if you are sure.",
  );
  process.exit(1);
}

if (dryRun) {
  console.log(
    `\nDry run — would copy ${sourceRows} row(s) across ${sourceCounts.size} table(s). Nothing was executed.`,
  );
  process.exit(0);
}

// --no-owner / --no-acl: roles and grants from the old project must not follow
// the data. The MCP role is created fresh in the new project by `npm run mcp:role`.
const workDir = mkdtempSync(path.join(tmpdir(), "crm-migrate-"));
const dumpFile = path.join(workDir, "crm.dump");

try {
  console.log("\nDumping source...");
  run("pg_dump", ["--no-owner", "--no-acl", "--format=custom", "--file", dumpFile, from]);
  console.log(`  wrote ${(statSync(dumpFile).size / 1024 / 1024).toFixed(1)} MB`);

  console.log("\nRestoring into target...");
  run("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error", "--dbname", to, dumpFile]);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log("\nVerifying...");
const targetCountsAfter = await tableCounts(to);
const mismatches = report(sourceCounts, targetCountsAfter);

if (mismatches) {
  console.error(`\nFAIL: ${mismatches} table(s) differ. The source database is untouched.`);
  process.exit(1);
}

console.log(
  `\nOK: ${sourceRows} row(s) across ${sourceCounts.size} table(s) match.` +
    "\nThe old database was not modified — keep it until you are confident.",
);
