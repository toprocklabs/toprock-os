<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This project runs on Next.js 16.x and may differ from older patterns.
Check `node_modules/next/dist/docs/` when changing framework behavior.
<!-- END:nextjs-agent-rules -->

# AGENTS.md

## Project Snapshot
- App: lightweight CRM (accounts, contacts, opportunities, tasks, activities)
- Product label: Toprock CRM
- Stack: Next.js App Router, TypeScript, Tailwind, Drizzle ORM, Neon Postgres
- Auth: custom username/password login with signed JWT cookie session
- Rendering: route pages are server-rendered (`force-dynamic`) with server actions for writes

## Local Runbook
1. Install deps: `npm install`
2. Configure env in `.env.local`:
   - `DATABASE_URL=...`
   - `AUTH_SECRET=...` (>= 32 chars)
   - `CRM_AGENT_TOKEN=...` (>= 32 chars) — machine auth for `/api/mcp` (Paul / PM agents). Do not reuse `AUTH_SECRET`.
   - optional: `GITHUB_TOKEN` + `GITHUB_ORG` (default `toprocklabs`) for `npm run sync:repos` and the agent `sync_project_repos` tool
   - optional: `CRM_AGENT_AUTO_APPLY=true` to auto-apply high-confidence suggestions (off by default; stage/money/account updates never auto-apply)
3. Sync DB schema:
   - `npm run db:generate`
   - `npm run db:push`
4. Create users (if needed):
   - `npm run user:create -- <username> <password> [displayName]`
5. Start app:
   - `npm run dev`
   - optionally `npm run dev -- --port 3001` if `3000` is occupied

## Core Structure
- `src/app/` App Router pages + server actions
- `src/app/actions.ts` primary CRM mutations (create/update/log)
- `src/app/login/` auth actions and login page
- `src/lib/schema.ts` Drizzle schema and enums
- `src/lib/db.ts` shared Neon Drizzle client
- `src/lib/auth.ts` session create/verify helpers
- `src/lib/normalize.ts` pure input normalizers (text/url/phone/date) used by actions
- `src/lib/agent/` PM-agent MCP surface: bearer auth, suggestion payload schemas, apply-on-approve, tool dispatch
- `src/lib/github/sync-repos.ts` shared GitHub org → `project_repos` reconcile (CLI + agent tool)
- `src/app/api/mcp/` Streamable HTTP MCP endpoint
- `src/app/api/agent/` small REST companions (`/health`, `/sync-repos`)
- `src/proxy.ts` public-surface gate (Next 16 renamed `middleware.ts` → `proxy.ts`): session check for private paths; classification in `src/lib/public-surface.ts`
- `src/components/` shared UI helpers (`crm-shell`, autosave fields, call link, collapsible form section)
- `drizzle/` generated migrations
- `tests/` `node:test` suites for pure logic — run with `npm test`
- `scripts/sync-repos.mjs` GitHub org → `project_repos` mirror (`npm run sync:repos [-- --dry-run]`)
- `scripts/map-repos.mjs` links mirrored repos to accounts (`node scripts/map-repos.mjs [--apply]`)
- `scripts/setup-mcp-role.mjs` provisions + audits the SELECT-only Neon role the agent's read tools use (`npm run mcp:role [-- --dry-run|--audit-only]`)
- `scripts/verify-mcp.mjs` end-to-end check of a deployed `/api/mcp` **and** the public-surface wall (`npm run mcp:verify -- --url <url> --token <token>`)
- `scripts/migrate-db.mjs` copies a whole database into a fresh one and verifies row counts (`npm run db:migrate -- --from <url> --to <url> [--dry-run]`)
- `scripts/create-user.mjs` CLI user upsert helper
- `scripts/run-tests.mjs` test discovery shim (Node 20's runner doesn't glob `.ts`)

## Current Routes
- `/` dashboard
- `/login`
- `/accounts`, `/accounts/[id]`
- `/contacts`, `/contacts/[id]`
- `/opportunities`, `/opportunities/[id]`
- `/proposals`, `/proposals/[id]` (internal proposal management + signed-PDF download at `/proposals/[id]/pdf`)
- `/payments` Stripe payment mirror (ledger + unassigned-payment matching)
- `/tasks`
- `/activities`
- `/inbox` human-in-the-loop queue for agent-proposed writes (`suggestions`)
- **Agent API (bearer token, not the human session cookie):** `POST /api/mcp` Streamable HTTP MCP; `GET /api/agent/health`; `POST /api/agent/sync-repos`
- `/map` geocoded account map + proximity sourcing
- **Public, PIN-gated (no login):** `/p/[slug]` client-facing Statement of Work + signing, `/p/[slug]/terms` Terms of Service, `POST /p/[slug]/sign` signing endpoint
- compatibility redirects: `/customers` and `/customers/[id]`
- Every authenticated route has a `loading.tsx` skeleton; keep that true when adding routes.

## Data Model (Drizzle)
- `users` (local auth users)
- `login_attempts` (per-attempt log for `/login` throttling; pruned after 30 days)
- `companies` (UI term: Accounts)
- `contacts`
- `deals`
- `sales_tasks`
- `activities`
- `proposals` (client-facing statements of work; markdown content, PIN, status lifecycle)
- `proposal_documents` (the signed PDF base64, one row per proposal — kept off the hot proposals row)
- `project_repos` (read-only mirror of the GitHub org's repos; `company_id` links delivery to an account)
- Enums:
  - `account_stage`: new_lead, attempting_to_engage, engaged, in_pipeline, customer
  - `deal_stage`: lead, qualified, proposal, negotiation, won, lost
  - `activity_type`: note, call, meeting, email, instagram, linkedin, task
  - `task_status`: open, done
  - `proposal_status`: draft, sent, viewed, signed, declined, superseded

## Coding Conventions (Repo-Specific)
- Prefer server components for pages and data reads.
- Keep mutations in server actions (`"use server"`) and validate inputs with Zod.
- Define every action in `src/app/actions.ts` with `defineAction({ schema, input, handler })` from `src/lib/define-action.ts`. It runs `requireUser()` and resolves the db before your handler, so authorization can't be forgotten. Keep the `input` mapper explicit — `id: raw ? Number(raw) : undefined` is what keeps a blank `<select>` out of a `z.coerce.number().positive()` field.
- Autosave field components share their machinery via `src/components/auto-save-hooks.ts` (`useAutoSaveInput`, `useAutoSaveEditable`, `useAutoSaveSelect`). Three interaction families exist on purpose — click-to-edit, blur-to-save, and select-on-change — so add to the right hook rather than merging them.
- Keep contact/account terminology consistent in UI:
  - UI label: Account
  - DB table: `companies`
- Keep opportunity terminology consistent in UI:
  - UI label: Opportunity
  - DB table: `deals`
- Phone numbers are normalized to US format in actions (`(###) ###-####`).
- Keep routes dynamic when data should always be fresh.

## UI Direction
- Current approved direction is a Gong-inspired revenue-workspace UI, not a generic SaaS card layout.
- Preserve the dark utility sidebar, bright analytics canvas, crisp white panels, and cyan/blue accent system unless explicitly redesigning again.
- Favor dense but readable information hierarchy: compact KPI blocks, sharp tables, restrained pills, and fewer redundant explainer sections.
- Avoid reintroducing glossy/glassy gradients or duplicative summary panels that repeat the page header or table metadata.
- The shell is full-bleed (no centered `max-w` cap) so wide tables get the whole viewport. Don't reintroduce a max-width wrapper in `crm-shell.tsx` or `SkeletonShell`.
- The desktop sidebar collapses to a 64px icon rail. State lives in `document.documentElement.dataset.sidebar` (`expanded` / `collapsed`), seeded before paint by the inline script in `app/layout.tsx` and persisted to `localStorage["crm.sidebar-collapsed"]`. Collapsed styling is CSS-only (`html[data-sidebar="collapsed"] …` in `globals.css`) — keep it out of React state or it re-introduces a hydration mismatch and a flash of the expanded rail.
- On `/accounts`, the account table is the page. Add account and Closed Lost are secondary: both are compact `CollapsibleFormSection variant="compact"` toggles, not full panels. Do not promote either back into its own headed section.

## Key Workflows Added
- Account stage workflow lives at `/accounts` and `/accounts/[id]`.
- Account create/edit supports:
  - selecting `companies.stage` during account creation
  - inline account stage updates on account detail via `updateCompanyField`
- Opportunity detail workflow lives at `/opportunities/[id]`.
- Opportunity detail supports:
  - editing core fields via `updateDeal`
  - stage updates + stage history notes via `updateDealStage`
  - contextual activity logging via `logActivity` with `returnPath`
- Many create/log forms are wrapped in `CollapsibleFormSection` and default collapsed.
- Collapsible sections auto-close on submit (`onSubmitCapture`) and remain minimized after refresh.

## Proposals / Signed Agreements (merged from proposal_creator — plan 002)
- Proposals are CRM records (`proposals` table) tied to an account (required) and optionally an opportunity/contact. The old standalone `proposal_creator` repo is superseded; do not add new proposals there.
- Content stays the legacy four-section markdown: `## Overview`, `## Pricing` (GFM table: Phase / Item | Description | Cost), `## What's Included` (bullets), `## Notes` (optional). Parsers live in `src/lib/proposal/markdown.ts`.
- **Creating a proposal by prompting Claude Code** (the standard flow): give it a transcript or pricing notes → it drafts the four-section markdown following the brand rules in `src/lib/proposal/toprock_branding.md` (tone: direct, second person, no jargon, no exclamation marks; accent used sparingly) → it inserts the row via SQL or you paste into the `/proposals` create + edit forms → review in-app, then send the client `/p/[slug]` + the PIN.
- **Smart create:** the `/proposals` form accepts a "New account name" — `createProposal` creates the account (case-insensitive match first, stage `in_pipeline`) and, unless an existing opportunity is picked, auto-creates one from the proposal (stage `proposal`, MRR/one-time parsed from the Pricing table via `parsePricingTotals`). Saving proposal content later back-fills the linked opportunity's value only while it's still 0/0.
- **Tying SOWs to opportunities:** the Agreements panel (account + opportunity pages) has a per-proposal dropdown backed by `updateProposalDeal` (validates same-account). Never render these autosave `<form>` components inside a `<p>` — invalid HTML → hydration mismatch that silently kills the panel's interactivity.
- Client flow: `/p/[slug]` is public but PIN-gated server-side (per-proposal `pin`, internal master PIN via `PROPOSAL_INTERNAL_PIN`, default 3067). PIN entry sets a slug-scoped cookie and flips `sent → viewed`. Signing (draw or type) builds the PDF client-side (JPEG-based, ~200KB) and POSTs to `/p/[slug]/sign`, which stores the PDF on the row, flips status to `signed`, logs an account activity, and notifies.
- Notifications on signing (`src/lib/proposal/notify.ts`): `RESEND_API_KEY` → Resend emails (internal + client); else `PROPOSAL_SIGNED_WEBHOOK_URL` → legacy Apps Script payload; else skip (PDF is stored regardless). Optional: `PROPOSAL_NOTIFY_EMAIL`, `PROPOSAL_FROM_EMAIL`.
- Legacy backfill: `node scripts/import-proposals.mjs [--dry-run] [--source <proposal_creator path>] [--pdf-dir <dir of <slug>.pdf signed files>]`. Idempotent (upsert by slug); never downgrades a `signed` status.
- The signed PDF lives in its own table, `proposal_documents` (one row per proposal), so a stray `select()` can no longer drag multiple megabytes of base64 into a list query. Only `/proposals/[id]/pdf` and the signing route touch it. To ask *whether* a PDF exists without fetching bytes, use `hasSignedPdfExpr` from `src/lib/proposal/has-signed-pdf.ts`.
- `proposals.signed_pdf_base64` still exists and is read as a fallback, but nothing writes to it. It is dropped in a follow-up; until then, keep using explicit column lists on proposal queries.
- The client page must stay visually identical to the legacy hosted proposals (CSS ported verbatim in `src/app/p/proposal-public.css`).

## GitHub project activity (plan 005)
- `project_repos` is a **read-only mirror** of the `toprocklabs` GitHub org. Nothing in this app writes to GitHub. The request path never calls the GitHub API — `/accounts` reads Postgres only.
- Refresh with `npm run sync:repos`. One request (`GET /orgs/{org}/repos`) covers every repo because the org listing carries `pushed_at`; a full sync costs 1–2 calls against a 5,000/hour budget. **Not yet scheduled** — until a cron is wired up the column is only as fresh as the last manual run.
- The sync deliberately does **not** touch `company_id` or `is_internal`. Those are curated by hand and must survive every sync. Repos that vanish from the org listing are marked `archived`, never deleted — the account link is the expensive part.
- Auth: `GITHUB_TOKEN` (fine-grained PAT, read-only, Contents + Metadata) with `GITHUB_ORG` defaulting to `toprocklabs`. Locally the script falls back to `gh auth token`, so a developer with `gh auth login` needs no extra setup.
- Mapping new repos: `node scripts/map-repos.mjs` reports, `--apply` writes. The slug matcher gets ~70%; links it can't reach (`scuba-dive-riverton` → *Scuba Dive Utah*) live in `MANUAL_LINKS` inside that script so the mapping is reproducible from an empty database.
- The "Last push" column shows `MAX(last_push_at)` across an account's non-archived repos. An account with **no linked repo renders grey `—` and sorts last in both directions** — it is unmeasured, not stale, and must never be colored like an abandoned account.
- Recency bands live in `src/lib/push-recency.ts` (pure, `now` passed in, covered by `tests/push-recency.test.ts`). Change thresholds there, not in the page.
- Authenticated exception: `sync_project_repos` (MCP) and `POST /api/agent/sync-repos` call GitHub with `GITHUB_TOKEN` to refresh the mirror. `/accounts` still reads Postgres only.

## PM agent API (Paul)

External PM agents keep the CRM current from meetings and git activity **without writing core tables**. They connect to Streamable HTTP MCP at `/api/mcp` (Cursor / Grok Bot compatible). Human cookie login is unchanged.

### Connect
1. Set `CRM_AGENT_TOKEN` in the deployment env (>= 32 chars). Never commit it.
2. MCP URL: `https://<host>/api/mcp`
3. Header: `Authorization: Bearer <CRM_AGENT_TOKEN>`
4. Transport: Streamable HTTP JSON-RPC (`initialize` → `notifications/initialized` → `tools/list` / `tools/call`). `GET /api/mcp` with the same bearer returns server metadata.
5. REST backups: `GET /api/agent/health`, `POST /api/agent/sync-repos` (`{ "dryRun": true }` optional). Same bearer. Useful for curl / a later cron — do not invent an in-app cron.

### Tools
**Read:** `list_accounts`, `get_account`, `list_contacts`, `get_contact`, `list_opportunities`, `get_opportunity`, `list_tasks`, `list_activities`, `list_suggestions`, `list_project_repos`.
**Write (propose only by default):** `propose_suggestion` inserts a `suggestions` row (`source=agent`, `status=pending`) and an `agent_runs` row (`loop=pm_agent`).
**Sync:** `sync_project_repos` runs the same reconcile as `npm run sync:repos` (does not touch `company_id` / `is_internal`).

### `propose_suggestion` envelope
```
{ kind, title, evidence, confidence (0-100), payload, model?, loop? }
```
`evidence` is required. Inbox approval (`approveSuggestion`) applies the payload via `src/lib/agent/apply-suggestion.ts`.

### Suggestion kinds + payloads
- `new_company` — `{ name, category?, address?, lat?, lng?, nearCompanyId?, nearCompanyName?, distanceMeters?, industry?, website? }` (sourcing + agent)
- `new_contact` — `{ firstName, lastName, email?, phone?, title?, linkedinProfileUrl?, companyId? }` (US phone normalized)
- `new_edge` — `{ fromType, fromId, toType, toId, edgeType, strength?, evidence? }`
- `log_activity` — `{ type, notes, companyId?, contactId?, dealId?, occurredOn? }` (must attach to at least one record)
- `stage_change` — `{ target: "account"|"opportunity", id, stage, reason }` (`reason` + evidence required)
- `new_deal` — `{ name, companyId, stage?, ownerName?, nextStep?, nextStepDueDate?, expectedCloseDate?, primaryContactId?, valueCents?, implementationCostCents? }`
- `update_deal` — `{ dealId, fields: { name?, nextStep?, nextStepDueDate?, expectedCloseDate?, ownerName?, primaryContactId?, valueCents?, implementationCostCents? } }`
- `update_account` — `{ companyId, fields: { name?, stage?, nextStep?, nextStepDueDate?, website?, industry? } }`

Money fields (`valueCents` / `implementationCostCents`) are rejected unless `evidence` cites a number.

### Safety rules (also sent as MCP `instructions`)
- **Propose, don't apply.** Default path is `/inbox`. Auto-apply requires `CRM_AGENT_AUTO_APPLY=true` and high confidence (`CRM_AGENT_AUTO_APPLY_MIN_CONFIDENCE`, default 95). Allowlist default is `log_activity` only (`CRM_AGENT_AUTO_APPLY_KINDS`). `stage_change`, `new_deal`, `update_deal`, and `update_account` never auto-apply.
- **Do not invent deal values.** Omit MRR / implementation cost unless a meeting, email, or signed SOW stated the number.
- **Stage changes need evidence.** No speculative pipeline movement.
- **Never contact clients.** This API does not send mail, place calls, or message anyone.
- **Do not weaken human auth.** Cookie JWT (`AUTH_SECRET`) and agent bearer (`CRM_AGENT_TOKEN`) are separate.

### Read/write connection split (plan 008)
- The ten read tools are dispatched against `getReadOnlyDb()` (`MCP_DATABASE_URL`), a Neon role granted **only `SELECT`** on the seven tables they touch: `companies`, `contacts`, `deals`, `activities`, `sales_tasks`, `suggestions`, `project_repos`. `propose_suggestion`, `sync_project_repos`, and `agent_runs` bookkeeping keep the read/write connection.
- `READ_ONLY_TOOLS` in `src/lib/agent/tools.ts` is the classification. `tests/agent-tool-classification.test.ts` fails the build if a catalog tool is unclassified, if a write tool is marked read-only, or if the write surface grows beyond the two approved tools — so adding a tool forces a deliberate decision rather than inheriting a connection by accident.
- Provision the role with `npm run mcp:role` (admin `DATABASE_URL` required). It audits the role against **every** table in the schema and fails if it can read anything outside the seven or write anything at all. Re-runnable as `npm run mcp:role -- --audit-only`.
- **No `ALTER DEFAULT PRIVILEGES`** — a new table must be granted deliberately in `READABLE_TABLES`, never inherited.
- `MCP_DATABASE_URL` falls back to `DATABASE_URL` with a warning, so the endpoint works before the role exists. The role is a deploy step, not an optional one.

### Tests
Auth rejection, payload validation, suggestion insert shape, MCP initialize/list, and repo-sync planning live under `tests/agent-*.test.ts` and `tests/github-sync-repos.test.ts`. Tool classification lives in `tests/agent-tool-classification.test.ts`.

## Web UI behind login (plan 009, supersedes plan 007's lockdown)
- The CRM is usable at the Vercel URL behind the existing username/password session. `src/proxy.ts` classifies every path with `classifyPath()` in `src/lib/public-surface.ts`:
  - **public** — `/api/mcp`, `/api/agent/*`, `/p/*`, `/_next/*`, `/favicon.ico`, `/robots.txt`. Served to anyone; each has its own gate (bearer / PIN).
  - **login** — `/login`. Served to anyone; rate-limited in the action.
  - **private** — everything else, **including any route added later**. The proxy verifies the `crm_session` JWT before the route runs: anonymous GET → 307 to `/login?next=…`, anything else → 401. Pages and actions still call `requireUser()` / `defineAction` too — both layers must pass.
- **Default deny.** A new route is signed-in-only until someone adds it to the public list on purpose — change `src/lib/public-surface.ts` *and* `tests/public-surface.test.ts`.
- **The switch:** `surfaceMode()` is `open` in development (proxy stays out of the way), `gated` in production only when `CRM_WEB_UI=on` (exact value), and `locked` otherwise — plan 007's bodiless 404 for every non-public path, `/login` included. Set `CRM_WEB_UI` on Vercel **production only**; removing it + redeploying is the kill switch. `CRM_PUBLIC_SURFACE=all` is retired and ignored.
- The session check lives in `src/lib/session-token.ts` (no `next/headers`), shared by the proxy and `getSession()`.
- **Login throttling** (`src/lib/login-throttle.ts`, table `login_attempts`): 5 failures per username (since its last success) or 20 per IP within 15 minutes → `error=throttled`. Counts are in Postgres because Fluid Compute runs several instances. Unknown usernames still pay a bcrypt compare against a dummy hash. Rows older than 30 days are pruned by the login action. `login_attempts` is deliberately **not** granted to the MCP read-only role.
- `user:create` requires passwords ≥ 12 characters.
- The proxy adds `X-Robots-Tag: noindex, nofollow` everywhere, plus `X-Frame-Options: DENY` and `Referrer-Policy: same-origin` on login and private responses.
- `?next=` is sanitized by `safeNextPath()` (same-origin paths only) — never redirect to a raw query value.
- Sign out everyone = rotate `AUTH_SECRET` in Vercel and redeploy.
- Allowing `/_next/*` leaks nothing: those bundles build from a public repo and contain no CRM rows. Server-rendered data is fetched at the page's own path (`/accounts?_rsc=…`) and is gated with the page.
- **Do not run `npm run db:push` against the shared database without reading its prompts.** The live DB has tables this schema doesn't define (`brain_documents`, `brain_document_links`, `meetings`, `meeting_companies`, `meeting_action_items`); push will offer to drop or rename them. Apply reviewed `drizzle/*.sql` instead.

## When Editing Existing Features
- If touching contact profile editing, preserve blur autosave behavior.
- If touching phone display, preserve `Call` button (`tel:` link behavior).
- If adding activity logging context, set `returnPath` so the page revalidates after submit.
- If adding/renaming routes, update top nav in `src/components/crm-shell.tsx`.
- If editing create/log forms, preserve the collapsible interaction pattern.
- If editing account stage selection, preserve immediate client-side feedback and the direct server-action update pattern in `AutoSaveCompanySelectField`.
- If editing the account create form on `/accounts`, keep the expanded form spacious and readable (2-column grid, full-width URL/next-step fields); only its collapsed toggle is compact.

## Database Change Workflow
1. Update `src/lib/schema.ts`
2. Run `npm run db:generate`
3. Review generated SQL in `drizzle/`
4. Run `npm run db:push`
5. Run `npm run build` and verify affected pages

## Validation Checklist Before Hand-off
- `npm run lint`
- `npm test`
- `npm run build`
- If auth touched: verify `/login` flow and guarded pages redirect as expected
- If schema touched: verify migration generated and applied
- If account stage touched: verify `/accounts` create flow and `/accounts/[id]` stage updates
- If opportunity workflow touched: verify `/opportunities/[id]` save + stage updates + timeline logging
- If proposals touched: verify `/proposals` create/edit, the public `/p/[slug]` PIN gate + render, and (for signing changes) an end-to-end test signature against a throwaway proposal row
- If `proxy.ts` or the public surface touched: `npm run build`, then check both modes. `npm start`: `/accounts` and `/login` 404. `CRM_WEB_UI=on npm start`: anonymous `/accounts` 307s to `/login?next=%2Faccounts`, anonymous `POST /accounts` 401s, login works. In both, `/p/<slug>` renders **with styling** and `/api/mcp` answers (401/503, not 404)
- If the agent API touched: `npm run mcp:verify -- --url <deployed>/api/mcp --token <token>` must pass every check, and `npm run mcp:role -- --audit-only` must still report write access nowhere
- If project repos touched: run `npm run sync:repos -- --dry-run`, then confirm `/accounts` sorts by Last push in both directions with unlinked accounts pinned last

## Safety Notes
- Do not store plaintext passwords; always hash with bcrypt (`bcryptjs`).
- Keep `AUTH_SECRET` and DB credentials in `.env.local` only.
- Keep `CRM_AGENT_TOKEN` and `MCP_DATABASE_URL` out of the repo (host env only), and keep the production MCP URL and call examples out of `README.md`.
- Preserve existing redirects from `/customers` to `/accounts` unless explicitly removing backward compatibility.

## Known Issues / Tech Debt
- Single-tenant data model: all authenticated users see all data; no per-user/org authorization boundaries yet.
- Contact-to-opportunity linking is partial: `deals.primaryContactId` is editable, but not consistently set in all create flows.
- Minimal error UX: server action validation failures generally throw; no structured inline form error states yet.
- Stage change guard for `lost` reason is soft (auto-fills "No reason provided."); no hard UI enforcement yet.
- Phone normalization assumes US numbers only; non-US formats are rejected.
- No test suite yet (unit/integration/e2e); quality relies on lint/build and manual verification.
