import { config } from "dotenv";

config({ path: ".env.local" });
config();

// Thin CLI for the shared sync in src/lib/github/sync-repos.ts.
// Run via `npm run sync:repos` (tsx) so the TypeScript module loads.

const dryRun = process.argv.includes("--dry-run");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing. Add it to .env.local.");
  process.exit(1);
}

const { getDb } = await import("../src/lib/db.ts");
const { resolveGitHubToken, syncProjectRepos } = await import("../src/lib/github/sync-repos.ts");

const db = getDb();
if (!db) {
  console.error("Could not open the database.");
  process.exit(1);
}

const { source } = resolveGitHubToken({ allowCliFallback: true });

try {
  const result = await syncProjectRepos({ db, dryRun, allowCliFallback: true });
  console.log(`Fetched ${result.fetched} repos from ${result.org} (auth: ${source})`);
  console.log(
    `${result.dryRun ? "[dry-run] " : ""}${result.inserted} inserted, ${result.updated} updated, ${result.archived} marked archived`,
  );
  if (result.archivedNames.length > 0) {
    console.log(`  archived: ${result.archivedNames.join(", ")}`);
  }
  console.log(`${result.unlinkedActive} active repos are not linked to an account`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
