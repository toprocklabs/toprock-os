# Simple CRM (HubSpot-lite)

## Repository moved

This repository has moved to: `https://github.com/toprocklabs/crm-app`

If you already cloned the old location, update your remote:

```bash
git remote set-url origin https://github.com/toprocklabs/crm-app.git
```

A lightweight CRM starter for small AI-first SMB agencies.

Built with:
- Next.js (App Router)
- Neon Postgres
- Drizzle ORM
- Tailwind CSS

## What this MVP includes

- Company management
- Contact management
- Deal tracking with stages, owners, and required next step
- Follow-up task reminders with due dates and completion
- Activity timeline (notes/calls/meetings/emails/tasks)
- Pipeline summary cards
- Server actions for create flows

## 1) Setup Neon

Create a Neon project and copy the connection string.

## 2) Configure environment

Create `.env.local`:

```bash
DATABASE_URL="postgresql://..."
AUTH_SECRET="at-least-32-random-characters"
CRM_AGENT_TOKEN="at-least-32-random-characters-for-mcp"
# Optional — GitHub org mirror (CLI + agent sync tool)
# GITHUB_TOKEN="ghp_..."
# GITHUB_ORG="toprocklabs"
# Optional — never enable in production without a reviewed policy
# CRM_AGENT_AUTO_APPLY="false"
```

## 3) Install and run migrations

```bash
npm install
npm run db:generate
npm run db:push
```

## 4) Create login users

```bash
npm run user:create -- alice StrongPassword123 "Alice"
npm run user:create -- bob StrongPassword456 "Bob"
```

This creates or updates users in the `users` table.

## 5) Start the app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Data model

- `companies`
- `contacts`
- `deals`
- `activities`
- `sales_tasks`
- `users`

Enums:
- `deal_stage`: lead, qualified, proposal, negotiation, won, lost
- `activity_type`: note, call, meeting, email, task

## PM agent API

Streamable HTTP MCP for an external PM agent (Paul) lives at `POST /api/mcp`. It is machine-authenticated with `Authorization: Bearer <CRM_AGENT_TOKEN>` and does **not** use the human session cookie.

- Reads: accounts, contacts, opportunities, tasks, activities, pending suggestions, `project_repos`
- Writes: `propose_suggestion` only (inbox at `/inbox`). Core tables change after a human approves.
- Sync: `sync_project_repos` or `POST /api/agent/sync-repos` — same logic as `npm run sync:repos`

See `AGENTS.md` for the tool list, suggestion payload shapes, and safety rules (no invented deal values; stage changes need evidence; never contact clients).

## Useful scripts

- `npm run dev` - local dev server
- `npm run lint` - lint checks
- `npm run build` - production build check
- `npm run db:generate` - generate Drizzle migrations
- `npm run db:push` - apply schema to database
- `npm run db:studio` - open Drizzle Studio
- `npm run user:create -- <username> <password> [displayName]` - create/update a login user

## Recommended next features

- Row-level ownership and permissions by account owner
- Notes/tasks timeline per company/contact/deal
- Email sync and AI-assisted follow-up drafting
- Kanban pipeline board
- Reminder automations
