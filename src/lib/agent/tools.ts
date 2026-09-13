import { and, asc, desc, eq, gte, ilike, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/define-action";
import { applySuggestion, markSuggestionResolved } from "@/lib/agent/apply-suggestion";
import { shouldAutoApply } from "@/lib/agent/policy";
import {
  buildSuggestionInsert,
  parseProposeSuggestion,
  SuggestionValidationError,
} from "@/lib/agent/suggestion-kinds";
import { syncProjectRepos } from "@/lib/github/sync-repos";
import {
  activities,
  agentRuns,
  companies,
  contacts,
  deals,
  projectRepos,
  salesTasks,
  suggestions,
} from "@/lib/schema";

const DEFAULT_LIMIT = 50;
const DEFAULT_ACTIVITY_LIMIT = 25;
const MAX_LIMIT = 100;

export class AgentToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentToolError";
  }
}

function clampLimit(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(MAX_LIMIT, Math.floor(parsed));
}

function likePattern(query: string) {
  return `%${query.replace(/[%_\\]/g, "\\$&")}%`;
}

function requireId(value: unknown, label: string) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AgentToolError(`${label} must be a positive integer.`);
  }
  return id;
}

function asArgs(value: unknown): Record<string, unknown> {
  if (value == null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AgentToolError("Tool arguments must be an object.");
  }
  return value as Record<string, unknown>;
}

async function startAgentRun(
  db: Db,
  input: { loop: string; model?: string | null; notes?: string | null },
) {
  const rows = await db
    .insert(agentRuns)
    .values({
      loop: input.loop,
      model: input.model ?? null,
      status: "running",
      notes: input.notes ?? null,
    })
    .returning({ id: agentRuns.id });
  return rows[0]?.id ?? null;
}

async function finishAgentRun(
  db: Db,
  runId: number | null,
  input: {
    status: "ok" | "error";
    itemsSeen?: number;
    itemsProposed?: number;
    notes?: string | null;
  },
) {
  if (!runId) {
    return;
  }
  await db
    .update(agentRuns)
    .set({
      status: input.status,
      itemsSeen: input.itemsSeen ?? 0,
      itemsProposed: input.itemsProposed ?? 0,
      notes: input.notes,
      finishedAt: new Date(),
    })
    .where(eq(agentRuns.id, runId));
}

async function listAccounts(db: Db, args: Record<string, unknown>) {
  const limit = clampLimit(args.limit, DEFAULT_LIMIT);
  const filters: SQL[] = [];
  if (typeof args.query === "string" && args.query.trim()) {
    filters.push(ilike(companies.name, likePattern(args.query.trim())));
  }
  if (typeof args.stage === "string" && args.stage) {
    filters.push(eq(companies.stage, args.stage as typeof companies.$inferSelect.stage));
  }

  return db
    .select({
      id: companies.id,
      name: companies.name,
      stage: companies.stage,
      website: companies.website,
      industry: companies.industry,
      nextStep: companies.nextStep,
      nextStepDueDate: companies.nextStepDueDate,
      address: companies.address,
      createdAt: companies.createdAt,
    })
    .from(companies)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(companies.createdAt))
    .limit(limit);
}

async function getAccount(db: Db, args: Record<string, unknown>) {
  const id = requireId(args.id, "id");
  const account = await db.query.companies.findFirst({
    where: eq(companies.id, id),
  });
  if (!account) {
    throw new AgentToolError(`Account #${id} not found.`);
  }

  const [accountContacts, accountDeals, repos, recentActivities] = await Promise.all([
    db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        phone: contacts.phone,
        title: contacts.title,
      })
      .from(contacts)
      .where(eq(contacts.companyId, id)),
    db
      .select({
        id: deals.id,
        name: deals.name,
        stage: deals.stage,
        valueCents: deals.valueCents,
        implementationCostCents: deals.implementationCostCents,
        nextStep: deals.nextStep,
        nextStepDueDate: deals.nextStepDueDate,
      })
      .from(deals)
      .where(eq(deals.companyId, id)),
    db
      .select({
        id: projectRepos.id,
        fullName: projectRepos.fullName,
        lastPushAt: projectRepos.lastPushAt,
        archived: projectRepos.archived,
        isInternal: projectRepos.isInternal,
        htmlUrl: projectRepos.htmlUrl,
      })
      .from(projectRepos)
      .where(eq(projectRepos.companyId, id)),
    db
      .select({
        id: activities.id,
        type: activities.type,
        notes: activities.notes,
        source: activities.source,
        occurredAt: activities.occurredAt,
      })
      .from(activities)
      .where(eq(activities.companyId, id))
      .orderBy(desc(activities.occurredAt))
      .limit(10),
  ]);

  return {
    account,
    contacts: accountContacts,
    opportunities: accountDeals,
    projectRepos: repos,
    recentActivities,
  };
}

async function listContacts(db: Db, args: Record<string, unknown>) {
  const limit = clampLimit(args.limit, DEFAULT_LIMIT);
  const filters: SQL[] = [];
  if (typeof args.query === "string" && args.query.trim()) {
    const pattern = likePattern(args.query.trim());
    const match = or(
      ilike(contacts.firstName, pattern),
      ilike(contacts.lastName, pattern),
      ilike(contacts.email, pattern),
    );
    if (match) {
      filters.push(match);
    }
  }
  if (args.companyId != null) {
    filters.push(eq(contacts.companyId, requireId(args.companyId, "companyId")));
  }

  return db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      title: contacts.title,
      companyId: contacts.companyId,
      createdAt: contacts.createdAt,
    })
    .from(contacts)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(contacts.createdAt))
    .limit(limit);
}

async function getContact(db: Db, args: Record<string, unknown>) {
  const id = requireId(args.id, "id");
  const contact = await db.query.contacts.findFirst({
    where: eq(contacts.id, id),
  });
  if (!contact) {
    throw new AgentToolError(`Contact #${id} not found.`);
  }
  return contact;
}

async function listOpportunities(db: Db, args: Record<string, unknown>) {
  const limit = clampLimit(args.limit, DEFAULT_LIMIT);
  const filters: SQL[] = [];
  if (typeof args.query === "string" && args.query.trim()) {
    filters.push(ilike(deals.name, likePattern(args.query.trim())));
  }
  if (typeof args.stage === "string" && args.stage) {
    filters.push(eq(deals.stage, args.stage as typeof deals.$inferSelect.stage));
  }
  if (args.companyId != null) {
    filters.push(eq(deals.companyId, requireId(args.companyId, "companyId")));
  }

  return db
    .select({
      id: deals.id,
      name: deals.name,
      stage: deals.stage,
      valueCents: deals.valueCents,
      implementationCostCents: deals.implementationCostCents,
      ownerName: deals.ownerName,
      nextStep: deals.nextStep,
      nextStepDueDate: deals.nextStepDueDate,
      expectedCloseDate: deals.expectedCloseDate,
      companyId: deals.companyId,
      primaryContactId: deals.primaryContactId,
      createdAt: deals.createdAt,
    })
    .from(deals)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(deals.createdAt))
    .limit(limit);
}

async function getOpportunity(db: Db, args: Record<string, unknown>) {
  const id = requireId(args.id, "id");
  const deal = await db.query.deals.findFirst({
    where: eq(deals.id, id),
  });
  if (!deal) {
    throw new AgentToolError(`Opportunity #${id} not found.`);
  }
  const recentActivities = await db
    .select({
      id: activities.id,
      type: activities.type,
      notes: activities.notes,
      source: activities.source,
      occurredAt: activities.occurredAt,
    })
    .from(activities)
    .where(eq(activities.dealId, id))
    .orderBy(desc(activities.occurredAt))
    .limit(10);

  return { opportunity: deal, recentActivities };
}

async function listTasks(db: Db, args: Record<string, unknown>) {
  const limit = clampLimit(args.limit, DEFAULT_LIMIT);
  const filters: SQL[] = [];
  if (typeof args.status === "string" && args.status) {
    filters.push(eq(salesTasks.status, args.status as typeof salesTasks.$inferSelect.status));
  }
  if (args.companyId != null) {
    filters.push(eq(salesTasks.companyId, requireId(args.companyId, "companyId")));
  }

  return db
    .select({
      id: salesTasks.id,
      title: salesTasks.title,
      status: salesTasks.status,
      dueDate: salesTasks.dueDate,
      assignedTo: salesTasks.assignedTo,
      companyId: salesTasks.companyId,
      dealId: salesTasks.dealId,
      createdAt: salesTasks.createdAt,
    })
    .from(salesTasks)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(salesTasks.dueDate)
    .limit(limit);
}

async function listActivities(db: Db, args: Record<string, unknown>) {
  const limit = clampLimit(args.limit, DEFAULT_ACTIVITY_LIMIT);
  const filters: SQL[] = [];
  if (args.companyId != null) {
    filters.push(eq(activities.companyId, requireId(args.companyId, "companyId")));
  }
  if (args.contactId != null) {
    filters.push(eq(activities.contactId, requireId(args.contactId, "contactId")));
  }
  if (args.dealId != null) {
    filters.push(eq(activities.dealId, requireId(args.dealId, "dealId")));
  }

  return db
    .select({
      id: activities.id,
      type: activities.type,
      notes: activities.notes,
      source: activities.source,
      companyId: activities.companyId,
      contactId: activities.contactId,
      dealId: activities.dealId,
      occurredAt: activities.occurredAt,
    })
    .from(activities)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(activities.occurredAt))
    .limit(limit);
}

async function listSuggestions(db: Db, args: Record<string, unknown>) {
  const limit = clampLimit(args.limit, DEFAULT_LIMIT);
  const filters: SQL[] = [];
  const status = typeof args.status === "string" ? args.status : "pending";
  if (status !== "all") {
    filters.push(eq(suggestions.status, status as typeof suggestions.$inferSelect.status));
  }
  if (typeof args.kind === "string" && args.kind) {
    filters.push(eq(suggestions.kind, args.kind));
  }

  return db
    .select({
      id: suggestions.id,
      kind: suggestions.kind,
      title: suggestions.title,
      payload: suggestions.payload,
      confidence: suggestions.confidence,
      evidence: suggestions.evidence,
      source: suggestions.source,
      status: suggestions.status,
      autoApplied: suggestions.autoApplied,
      agentRunId: suggestions.agentRunId,
      createdAt: suggestions.createdAt,
      resolvedAt: suggestions.resolvedAt,
    })
    .from(suggestions)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(suggestions.createdAt))
    .limit(limit);
}

async function listProjectReposTool(db: Db, args: Record<string, unknown>) {
  const limit = clampLimit(args.limit, DEFAULT_LIMIT);
  const filters: SQL[] = [];
  if (args.companyId != null) {
    filters.push(eq(projectRepos.companyId, requireId(args.companyId, "companyId")));
  }
  if (args.includeArchived !== true) {
    filters.push(eq(projectRepos.archived, false));
  }
  if (args.includeInternal === false) {
    filters.push(eq(projectRepos.isInternal, false));
  }

  return db
    .select({
      id: projectRepos.id,
      fullName: projectRepos.fullName,
      companyId: projectRepos.companyId,
      isInternal: projectRepos.isInternal,
      isPrivate: projectRepos.isPrivate,
      archived: projectRepos.archived,
      htmlUrl: projectRepos.htmlUrl,
      lastPushAt: projectRepos.lastPushAt,
      lastCommitSha: projectRepos.lastCommitSha,
      lastCommitMessage: projectRepos.lastCommitMessage,
      lastCommitAuthor: projectRepos.lastCommitAuthor,
      syncedAt: projectRepos.syncedAt,
    })
    .from(projectRepos)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(projectRepos.lastPushAt))
    .limit(limit);
}

const CLOSED_DEAL_STAGES = ["won", "lost"] as const;

/**
 * The whole story on one account, which `list_activities` cannot tell.
 *
 * That tool filters on `activities.company_id`, so it misses activity logged
 * against one of the account's opportunities or one of its people — rows whose
 * company_id is null. Asking "what is happening with this client?" and getting
 * a partial answer is worse than getting none, because it reads as complete.
 */
async function accountTimeline(db: Db, args: Record<string, unknown>) {
  const companyId = requireId(args.accountId ?? args.companyId, "accountId");
  const limit = clampLimit(args.limit, DEFAULT_ACTIVITY_LIMIT);

  const dealIds = db.select({ id: deals.id }).from(deals).where(eq(deals.companyId, companyId));
  const contactIds = db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.companyId, companyId));

  const filters: SQL[] = [
    or(
      eq(activities.companyId, companyId),
      inArray(activities.dealId, dealIds),
      inArray(activities.contactId, contactIds),
    ) as SQL,
  ];

  if (args.since != null) {
    const since = String(args.since);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      throw new AgentToolError("since must be a YYYY-MM-DD date.");
    }
    filters.push(gte(activities.occurredAt, new Date(`${since}T00:00:00.000Z`)));
  }

  return db
    .select({
      id: activities.id,
      type: activities.type,
      notes: activities.notes,
      source: activities.source,
      companyId: activities.companyId,
      contactId: activities.contactId,
      dealId: activities.dealId,
      dealName: deals.name,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      occurredAt: activities.occurredAt,
    })
    .from(activities)
    .leftJoin(deals, eq(activities.dealId, deals.id))
    .leftJoin(contacts, eq(activities.contactId, contacts.id))
    .where(and(...filters))
    .orderBy(desc(activities.occurredAt))
    .limit(limit);
}

/**
 * Open opportunities ordered by how long they have been silent.
 *
 * "Who is stuck in negotiation?" is a question about staleness, and staleness
 * is a fact about the *absence* of recent activity — which no flat list of
 * deals or activities can express. The correlated subquery computes it per deal
 * so the agent does not have to fetch a timeline for each one and subtract dates.
 */
async function listStalledOpportunities(db: Db, args: Record<string, unknown>) {
  const limit = clampLimit(args.limit, DEFAULT_LIMIT);
  const filters: SQL[] = [notInArray(deals.stage, [...CLOSED_DEAL_STAGES]) as SQL];

  if (args.stage != null) {
    filters.push(eq(deals.stage, String(args.stage) as (typeof deals.stage.enumValues)[number]));
  }

  const lastActivityAt = sql<
    string | null
  >`(select max(${activities.occurredAt}) from ${activities} where ${activities.dealId} = ${deals.id})`;

  return db
    .select({
      id: deals.id,
      name: deals.name,
      stage: deals.stage,
      valueCents: deals.valueCents,
      ownerName: deals.ownerName,
      nextStep: deals.nextStep,
      nextStepDueDate: deals.nextStepDueDate,
      expectedCloseDate: deals.expectedCloseDate,
      companyId: deals.companyId,
      companyName: companies.name,
      lastActivityAt,
      // Nulls first: a deal with no activity at all is the most stalled of all.
      daysSinceLastActivity: sql<
        number | null
      >`case when ${lastActivityAt} is null then null
             else floor(extract(epoch from (now() - ${lastActivityAt})) / 86400)::int end`,
    })
    .from(deals)
    .leftJoin(companies, eq(deals.companyId, companies.id))
    .where(and(...filters))
    .orderBy(sql`${lastActivityAt} asc nulls first`, asc(deals.id))
    .limit(limit);
}

async function proposeSuggestionTool(db: Db, args: Record<string, unknown>) {
  let parsed;
  try {
    parsed = parseProposeSuggestion(args);
  } catch (error) {
    if (error instanceof SuggestionValidationError) {
      throw new AgentToolError(error.issues.join(" "));
    }
    throw error;
  }

  const runId = await startAgentRun(db, {
    loop: parsed.loop ?? "pm_agent",
    model: parsed.model,
    notes: parsed.title,
  });

  try {
    const insert = buildSuggestionInsert(parsed, runId);
    const rows = await db.insert(suggestions).values(insert).returning({
      id: suggestions.id,
      kind: suggestions.kind,
      status: suggestions.status,
    });
    const created = rows[0];

    let applied = false;
    if (created && shouldAutoApply({ kind: parsed.kind, confidence: parsed.confidence })) {
      const row = await db.query.suggestions.findFirst({
        where: eq(suggestions.id, created.id),
      });
      if (row) {
        await applySuggestion(db, row);
        await markSuggestionResolved(db, row.id, "auto_applied");
        applied = true;
      }
    }

    await finishAgentRun(db, runId, {
      status: "ok",
      itemsSeen: 1,
      itemsProposed: applied ? 0 : 1,
      notes: applied ? `${parsed.title} (auto-applied)` : parsed.title,
    });

    return {
      suggestionId: created?.id ?? null,
      kind: parsed.kind,
      status: applied ? "auto_applied" : "pending",
      autoApplied: applied,
      title: parsed.title,
    };
  } catch (error) {
    await finishAgentRun(db, runId, {
      status: "error",
      notes: error instanceof Error ? error.message : "propose_suggestion failed",
    });
    throw error;
  }
}

async function syncProjectReposTool(db: Db, args: Record<string, unknown>) {
  const dryRun = args.dryRun === true;
  const runId = await startAgentRun(db, {
    loop: "sync_repos",
    notes: dryRun ? "project_repos sync (dry-run)" : "project_repos sync",
  });

  try {
    const result = await syncProjectRepos({
      db,
      dryRun,
      allowCliFallback: process.env.NODE_ENV !== "production",
    });
    await finishAgentRun(db, runId, {
      status: "ok",
      itemsSeen: result.fetched,
      itemsProposed: 0,
      notes: `${result.inserted} inserted, ${result.updated} updated, ${result.archived} archived`,
    });
    return result;
  } catch (error) {
    await finishAgentRun(db, runId, {
      status: "error",
      notes: error instanceof Error ? error.message : "sync_project_repos failed",
    });
    throw error;
  }
}

/**
 * Tools that only ever SELECT. These are dispatched against `readDb` — a
 * connection whose Neon role is granted nothing but SELECT on the seven tables
 * they touch (planning/008-agent-mcp-hardening). Everything else runs on the
 * read/write connection and stays gated by the /inbox approval queue.
 *
 * Adding a tool here without confirming it is read-only would route a write
 * through a role that cannot perform it, and the tool would fail loudly rather
 * than silently gaining privileges — the safe direction for a mistake.
 */
export const READ_ONLY_TOOLS = new Set([
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
]);

export async function dispatchAgentTool(
  name: string,
  rawArgs: unknown,
  db: Db,
  readDb: Db = db,
) {
  const args = asArgs(rawArgs);
  // Reads get the SELECT-only connection; writes keep the read/write one.
  const readOnly = READ_ONLY_TOOLS.has(name) ? readDb : db;
  switch (name) {
    case "list_accounts":
      return listAccounts(readOnly, args);
    case "get_account":
      return getAccount(readOnly, args);
    case "list_contacts":
      return listContacts(readOnly, args);
    case "get_contact":
      return getContact(readOnly, args);
    case "list_opportunities":
      return listOpportunities(readOnly, args);
    case "get_opportunity":
      return getOpportunity(readOnly, args);
    case "list_tasks":
      return listTasks(readOnly, args);
    case "list_activities":
      return listActivities(readOnly, args);
    case "list_suggestions":
      return listSuggestions(readOnly, args);
    case "list_project_repos":
      return listProjectReposTool(readOnly, args);
    case "account_timeline":
      return accountTimeline(readOnly, args);
    case "list_stalled_opportunities":
      return listStalledOpportunities(readOnly, args);
    case "propose_suggestion":
      return proposeSuggestionTool(db, args);
    case "sync_project_repos":
      return syncProjectReposTool(db, args);
    default:
      throw new AgentToolError(`Unknown tool: ${name}`);
  }
}
