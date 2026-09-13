import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import type { Db } from "@/lib/define-action";
import { projectRepos } from "@/lib/schema";

export const DEFAULT_GITHUB_ORG = "toprocklabs";

export type GitHubRepoMirror = {
  fullName: string;
  isPrivate: boolean;
  archived: boolean;
  htmlUrl: string | null;
  lastPushAt: Date | null;
};

export type ExistingRepoRow = {
  fullName: string;
  archived: boolean;
};

export type RepoSyncPlan = {
  upserts: GitHubRepoMirror[];
  archive: string[];
};

export type RepoSyncResult = {
  org: string;
  dryRun: boolean;
  fetched: number;
  inserted: number;
  updated: number;
  archived: number;
  archivedNames: string[];
  unlinkedActive: number;
};

type GitHubRepoJson = {
  full_name?: string;
  private?: boolean;
  archived?: boolean;
  html_url?: string | null;
  pushed_at?: string | null;
};

export function resolveGitHubToken(options?: { allowCliFallback?: boolean; env?: NodeJS.ProcessEnv }) {
  const env = options?.env ?? process.env;
  if (env.GITHUB_TOKEN) {
    return { token: env.GITHUB_TOKEN, source: "GITHUB_TOKEN" as const };
  }

  if (options?.allowCliFallback) {
    try {
      const token = execFileSync("gh", ["auth", "token"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        shell: process.platform === "win32",
      }).trim();
      if (token) {
        return { token, source: "gh auth token" as const };
      }
    } catch {
      // gh missing or not logged in
    }
  }

  throw new Error("No GitHub credentials. Set GITHUB_TOKEN, or run `gh auth login` for local CLI sync.");
}

export function mapGitHubRepo(repo: GitHubRepoJson): GitHubRepoMirror | null {
  if (!repo.full_name) {
    return null;
  }
  return {
    fullName: repo.full_name,
    isPrivate: Boolean(repo.private),
    archived: Boolean(repo.archived),
    htmlUrl: repo.html_url ?? null,
    lastPushAt: repo.pushed_at ? new Date(repo.pushed_at) : null,
  };
}

export function planRepoSync(existing: ExistingRepoRow[], fetched: GitHubRepoMirror[]): RepoSyncPlan {
  const seen = new Set(fetched.map((repo) => repo.fullName));
  return {
    upserts: fetched,
    archive: existing
      .filter((row) => !seen.has(row.fullName) && !row.archived)
      .map((row) => row.fullName),
  };
}

export async function fetchOrgRepos(options: {
  org: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<GitHubRepoMirror[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const repos: GitHubRepoMirror[] = [];

  for (let page = 1; page <= 10; page += 1) {
    const url = `https://api.github.com/orgs/${options.org}/repos?per_page=100&type=all&sort=pushed&page=${page}`;
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "toprock-crm-sync",
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub ${response.status} ${response.statusText}: ${await response.text()}`);
    }

    const batch = (await response.json()) as GitHubRepoJson[];
    for (const repo of batch) {
      const mapped = mapGitHubRepo(repo);
      if (mapped) {
        repos.push(mapped);
      }
    }
    if (batch.length < 100) {
      break;
    }
  }

  return repos;
}

export async function applyRepoSyncPlan(
  db: Db,
  plan: RepoSyncPlan,
  options?: { dryRun?: boolean },
): Promise<Omit<RepoSyncResult, "org" | "dryRun" | "fetched" | "unlinkedActive">> {
  const existing = await db
    .select({
      fullName: projectRepos.fullName,
      archived: projectRepos.archived,
    })
    .from(projectRepos);
  const known = new Set(existing.map((row) => row.fullName));

  let inserted = 0;
  let updated = 0;

  if (!options?.dryRun) {
    for (const repo of plan.upserts) {
      const isNew = !known.has(repo.fullName);
      await db
        .insert(projectRepos)
        .values({
          fullName: repo.fullName,
          isPrivate: repo.isPrivate,
          archived: repo.archived,
          htmlUrl: repo.htmlUrl,
          lastPushAt: repo.lastPushAt,
          syncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: projectRepos.fullName,
          set: {
            isPrivate: repo.isPrivate,
            archived: repo.archived,
            htmlUrl: repo.htmlUrl,
            lastPushAt: repo.lastPushAt,
            syncedAt: new Date(),
          },
        });
      if (isNew) {
        inserted += 1;
      } else {
        updated += 1;
      }
    }

    for (const fullName of plan.archive) {
      await db
        .update(projectRepos)
        .set({ archived: true, syncedAt: new Date() })
        .where(eq(projectRepos.fullName, fullName));
    }
  } else {
    for (const repo of plan.upserts) {
      if (known.has(repo.fullName)) {
        updated += 1;
      } else {
        inserted += 1;
      }
    }
  }

  return {
    inserted,
    updated,
    archived: plan.archive.length,
    archivedNames: plan.archive,
  };
}

export async function countUnlinkedActiveRepos(db: Db) {
  const rows = await db
    .select({
      companyId: projectRepos.companyId,
      isInternal: projectRepos.isInternal,
      archived: projectRepos.archived,
    })
    .from(projectRepos);

  return rows.filter((row) => row.companyId == null && !row.isInternal && !row.archived).length;
}

export async function syncProjectRepos(options: {
  db: Db;
  org?: string;
  token?: string;
  dryRun?: boolean;
  allowCliFallback?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<RepoSyncResult> {
  const org = options.org ?? process.env.GITHUB_ORG ?? DEFAULT_GITHUB_ORG;
  const resolved = options.token
    ? { token: options.token, source: "argument" as const }
    : resolveGitHubToken({ allowCliFallback: options.allowCliFallback ?? false });

  const fetched = await fetchOrgRepos({
    org,
    token: resolved.token,
    fetchImpl: options.fetchImpl,
  });

  const existing = await options.db
    .select({
      fullName: projectRepos.fullName,
      archived: projectRepos.archived,
    })
    .from(projectRepos);

  const plan = planRepoSync(existing, fetched);
  const applied = await applyRepoSyncPlan(options.db, plan, { dryRun: options.dryRun });
  const unlinkedActive = await countUnlinkedActiveRepos(options.db);

  return {
    org,
    dryRun: Boolean(options.dryRun),
    fetched: fetched.length,
    unlinkedActive,
    ...applied,
  };
}
