import { desc, eq } from "drizzle-orm";
import { approveSuggestion, dismissSuggestion } from "@/app/actions";
import { suggestionKindLabel, summarizeSuggestionPayload } from "@/lib/agent/suggestion-kinds";
import { CrmShell } from "@/components/crm-shell";
import { EmptyState } from "@/components/empty-state";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { suggestions } from "@/lib/schema";
import { scoreFromPayload, tierLabel } from "@/lib/referral-score";

export const dynamic = "force-dynamic";

type NewCompanyPayload = {
  name?: string;
  category?: string;
  address?: string | null;
  nearCompanyName?: string;
  distanceMeters?: number | null;
};

function scoreTone(combined: number) {
  if (combined >= 66) return "bg-emerald-100 text-emerald-800";
  if (combined >= 40) return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-slate-600";
}

function kindTone(kind: string) {
  switch (kind) {
    case "new_company":
      return "bg-violet-100 text-violet-800";
    case "new_contact":
      return "bg-sky-100 text-sky-800";
    case "log_activity":
      return "bg-slate-100 text-slate-700";
    case "stage_change":
      return "bg-amber-100 text-amber-800";
    case "new_deal":
    case "update_deal":
      return "bg-indigo-100 text-indigo-800";
    case "update_account":
      return "bg-cyan-100 text-cyan-800";
    case "new_edge":
      return "bg-emerald-100 text-emerald-800";
    default:
      return "bg-slate-100 text-slate-600";
  }
}

function SuggestionActions({
  id,
  approveLabel,
}: {
  id: number;
  approveLabel: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <form action={approveSuggestion}>
        <input type="hidden" name="suggestionId" value={id} />
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800"
        >
          {approveLabel}
        </button>
      </form>
      <form action={dismissSuggestion}>
        <input type="hidden" name="suggestionId" value={id} />
        <button
          type="submit"
          className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          Dismiss
        </button>
      </form>
    </div>
  );
}

export default async function InboxPage() {
  const session = await requireUser();
  const db = getDb();

  if (!db) {
    return null;
  }

  const pending = await db
    .select()
    .from(suggestions)
    .where(eq(suggestions.status, "pending"))
    .orderBy(desc(suggestions.createdAt));

  const sourced = pending
    .filter((suggestion) => suggestion.kind === "new_company")
    .map((suggestion) => {
      const payload = (suggestion.payload ?? {}) as NewCompanyPayload;
      return { suggestion, payload, score: scoreFromPayload(payload) };
    })
    .sort((a, b) => b.score.combined - a.score.combined);

  const agentProposed = pending.filter((suggestion) => suggestion.kind !== "new_company");

  return (
    <CrmShell
      username={session.username}
      title="Inbox"
      description="Human-in-the-loop queue. Agents propose writes from meetings and git activity; nothing lands on core records until you approve."
    >
      {agentProposed.length > 0 ? (
        <article className="gong-panel rounded-xl p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Agent proposals</h2>
              <p className="mt-1 text-sm text-slate-600">
                Validated payloads from the PM agent. Review evidence before applying.
              </p>
            </div>
            <span className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700">
              {agentProposed.length} pending
            </span>
          </div>

          <ul className="mt-4 space-y-3">
            {agentProposed.map((suggestion) => {
              const summary = summarizeSuggestionPayload(suggestion.kind, suggestion.payload);
              return (
                <li key={suggestion.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${kindTone(suggestion.kind)}`}>
                          {suggestionKindLabel(suggestion.kind)}
                        </span>
                        <p className="font-medium text-slate-900">{suggestion.title}</p>
                        <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                          {suggestion.confidence}%
                        </span>
                      </div>
                      {summary ? <p className="mt-1 text-sm text-slate-700">{summary}</p> : null}
                      <p className="mt-1 text-sm text-slate-600">{suggestion.evidence}</p>
                    </div>
                    <SuggestionActions id={suggestion.id} approveLabel="Approve" />
                  </div>
                </li>
              );
            })}
          </ul>
        </article>
      ) : null}

      <article className={`gong-panel rounded-xl p-5 ${agentProposed.length > 0 ? "mt-4" : ""}`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Ranked prospects</h2>
            <p className="mt-1 text-sm text-slate-600">
              Nearby businesses sourced around your customers, ranked by referral strength (warmth × fit).
            </p>
          </div>
          <span className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700">
            {sourced.length} pending
          </span>
        </div>

        <ul className="mt-4 space-y-3">
          {sourced.length === 0 ? (
            <li>
              <EmptyState
                icon="task"
                message={
                  pending.length === 0
                    ? "No suggestions in the queue. Agents propose writes here; run npm run source:nearby to find businesses near customers."
                    : "No sourcing prospects right now."
                }
              />
            </li>
          ) : null}

          {sourced.map(({ suggestion, payload, score }) => (
            <li key={suggestion.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-slate-900">{payload.name ?? suggestion.title}</p>
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${scoreTone(score.combined)}`}>
                      {score.combined}
                    </span>
                    {payload.category ? (
                      <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                        {payload.category}
                      </span>
                    ) : null}
                  </div>
                  {payload.address ? (
                    <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-700">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-slate-400">
                        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                        <circle cx="12" cy="10" r="3" />
                      </svg>
                      {payload.address}
                    </p>
                  ) : null}
                  <p className="mt-1 text-sm text-slate-600">{suggestion.evidence}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {tierLabel(score.tier)}
                    {payload.nearCompanyName ? ` · near ${payload.nearCompanyName}` : ""}
                    {" — "}
                    <span className="font-medium text-slate-600">warmth {score.warmth}</span> · <span className="font-medium text-slate-600">fit {score.fit}</span>
                  </p>
                </div>
                <SuggestionActions id={suggestion.id} approveLabel="Add as lead" />
              </div>
            </li>
          ))}
        </ul>
      </article>
    </CrmShell>
  );
}
