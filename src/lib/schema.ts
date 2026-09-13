import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const dealStage = pgEnum("deal_stage", [
  "lead",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
]);

export const activityType = pgEnum("activity_type", [
  "note",
  "call",
  "meeting",
  "email",
  "instagram",
  "linkedin",
  "task",
]);

export const accountStage = pgEnum("account_stage", [
  "new_lead",
  "attempting_to_engage",
  "engaged",
  "in_pipeline",
  "customer",
  "closed_lost",
]);

export const taskStatus = pgEnum("task_status", ["open", "done"]);

// Typed relationship edges — the graph that powers warm-path discovery.
export const edgeType = pgEnum("edge_type", [
  "referred_by", // the gold: who sent us this client
  "colocated_with", // same plaza/building/street — the Scuba Riverton play
  "introduced_by", // a person bridged us to another person/company
  "knows", // soft personal tie
  "vendor_of",
  "customer_of",
  "partner_of",
  "competitor_of",
]);

// Polymorphic node type for graph edges and enrichment.
export const entityType = pgEnum("entity_type", ["company", "contact"]);

// Lifecycle of an agent-proposed write in the human-in-the-loop queue.
export const suggestionStatus = pgEnum("suggestion_status", [
  "pending",
  "approved",
  "rejected",
  "auto_applied",
]);

// Where a piece of data originated (manual entry vs. an ingestion source).
export const dataSource = pgEnum("data_source", [
  "manual",
  "drive",
  "gmail",
  "agent",
]);

// Lifecycle of a client-facing proposal / statement of work.
export const proposalStatus = pgEnum("proposal_status", [
  "draft",
  "sent",
  "viewed",
  "signed",
  "declined",
  "superseded",
]);

// Money in. `type` is derived from Stripe (a charge carrying a subscription is
// recurring maintenance; anything else is a one-off build fee) so the two
// reconcile against deals.valueCents and deals.implementationCostCents
// respectively — see planning/003-stripe-payments/.
export const paymentStatus = pgEnum("payment_status", [
  "succeeded",
  "refunded",
  "partially_refunded",
  "failed",
]);

export const paymentType = pgEnum("payment_type", ["one_time", "recurring"]);

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("users_username_unique").on(table.username),
  ],
);

export const companies = pgTable(
  "companies",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    stage: accountStage("stage").default("new_lead").notNull(),
    website: text("website"),
    customerProjectUrl: text("customer_project_url"),
    industry: text("industry"),
    nextStep: text("next_step").notNull().default(""),
    nextStepDueDate: date("next_step_due_date"),
    // Address + geocode power the proximity ("plaza neighbors") play.
    address: text("address"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    plazaKey: text("plaza_key"),
    // Links this account to its Stripe customer. Nullable until matched.
    stripeCustomerId: text("stripe_customer_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // `stage` is the default filter on /accounts; `created_at` is the default sort.
    index("companies_stage_idx").on(table.stage),
    index("companies_created_at_idx").on(table.createdAt),
    // Lookup key when matching Stripe customers back to accounts.
    index("companies_stripe_customer_idx").on(table.stripeCustomerId),
    // Proximity ("plaza neighbors") grouping.
    index("companies_plaza_idx").on(table.plazaKey),
  ],
);

export const contacts = pgTable(
  "contacts",
  {
    id: serial("id").primaryKey(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    linkedinProfileUrl: text("linkedin_profile_url"),
    title: text("title"),
    companyId: integer("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("contacts_email_unique").on(table.email),
  ],
);

export const deals = pgTable(
  "deals",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    stage: dealStage("stage").default("lead").notNull(),
    valueCents: integer("value_cents").default(0).notNull(),
    implementationCostCents: integer("implementation_cost_cents").default(0).notNull(),
    ownerName: text("owner_name"),
    nextStep: text("next_step").notNull().default(""),
    nextStepDueDate: date("next_step_due_date"),
    companyId: integer("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    primaryContactId: integer("primary_contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    expectedCloseDate: date("expected_close_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Every account page and the accounts list roll opportunities up by company.
    index("deals_company_idx").on(table.companyId),
    index("deals_stage_idx").on(table.stage),
  ],
);

export const activities = pgTable(
  "activities",
  {
    id: serial("id").primaryKey(),
    type: activityType("type").default("note").notNull(),
    notes: text("notes").notNull(),
    loggedByUserId: integer("logged_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    companyId: integer("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    contactId: integer("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    dealId: integer("deal_id").references(() => deals.id, {
      onDelete: "set null",
    }),
    // Distinguishes human-logged activity from agent-logged activity.
    source: dataSource("source").default("manual").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Timelines filter by one of these three keys and always sort by occurred_at.
    index("activities_company_idx").on(table.companyId),
    index("activities_contact_idx").on(table.contactId),
    index("activities_deal_idx").on(table.dealId),
    index("activities_occurred_at_idx").on(table.occurredAt),
  ],
);

export const salesTasks = pgTable(
  "sales_tasks",
  {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    status: taskStatus("status").default("open").notNull(),
    dueDate: date("due_date").notNull(),
    assignedTo: text("assigned_to"),
    dealId: integer("deal_id").references(() => deals.id, {
      onDelete: "set null",
    }),
    companyId: integer("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("sales_tasks_company_idx").on(table.companyId),
    index("sales_tasks_deal_idx").on(table.dealId),
    // /tasks filters open vs. done and sorts by due date.
    index("sales_tasks_status_due_idx").on(table.status, table.dueDate),
  ],
);

// The graph. One polymorphic edge table: any node -> any node, typed + weighted.
// strength (0-100) decays over time without contact; evidence cites the source.
export const relationships = pgTable(
  "relationships",
  {
    id: serial("id").primaryKey(),
    fromType: entityType("from_type").notNull(),
    fromId: integer("from_id").notNull(),
    toType: entityType("to_type").notNull(),
    toId: integer("to_id").notNull(),
    edgeType: edgeType("edge_type").notNull(),
    strength: integer("strength").default(50).notNull(),
    evidence: text("evidence"),
    source: dataSource("source").default("manual").notNull(),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("relationships_from_idx").on(table.fromType, table.fromId),
    index("relationships_to_idx").on(table.toType, table.toId),
    uniqueIndex("relationships_unique_edge").on(
      table.fromType,
      table.fromId,
      table.toType,
      table.toId,
      table.edgeType,
    ),
  ],
);

// Human-in-the-loop gate: agents write proposals here, never to core tables.
// payload is the exact write to apply on approval.
export const suggestions = pgTable(
  "suggestions",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(), // 'new_company' | 'new_contact' | 'new_edge' | 'log_activity' | 'stage_change' | 'new_deal' | 'update_deal' | 'update_account'
    title: text("title").notNull(), // short human summary for the inbox row
    payload: jsonb("payload").notNull(),
    confidence: integer("confidence").default(0).notNull(), // 0-100 from triage
    evidence: text("evidence"),
    source: dataSource("source").default("agent").notNull(),
    status: suggestionStatus("status").default("pending").notNull(),
    autoApplied: boolean("auto_applied").default(false).notNull(),
    agentRunId: integer("agent_run_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("suggestions_status_idx").on(table.status)],
);

// Audit + token accounting for every standing-loop execution. Keeps autonomy
// honest, debuggable, and budget-bounded.
export const agentRuns = pgTable("agent_runs", {
  id: serial("id").primaryKey(),
  loop: text("loop").notNull(), // 'ingest_drive' | 'ingest_gmail' | 'daily_brief' | 'sourcing' | 'pm_agent' | 'sync_repos'
  model: text("model"),
  status: text("status").default("running").notNull(), // running | ok | error | halted_budget
  tokensIn: integer("tokens_in").default(0).notNull(),
  tokensOut: integer("tokens_out").default(0).notNull(),
  costCents: integer("cost_cents").default(0).notNull(),
  itemsSeen: integer("items_seen").default(0).notNull(),
  itemsProposed: integer("items_proposed").default(0).notNull(),
  notes: text("notes"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

// Client-facing proposals / statements of work, served at /p/[slug].
// Content stays the four-section markdown from the old proposal_creator repo
// (Overview / Pricing table / What's Included / Notes). The signed PDF is
// produced client-side at signing time and stored base64 (tiny volume; avoids
// bytea quirks over the neon-http driver).
export const proposals = pgTable(
  "proposals",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    dealId: integer("deal_id").references(() => deals.id, { onDelete: "set null" }),
    contactId: integer("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    pin: text("pin").notNull(),
    status: proposalStatus("status").default("draft").notNull(),
    clientName: text("client_name").notNull().default(""),
    business: text("business").notNull().default(""),
    // Display date shown in the header, e.g. "April 11, 2026" (old frontmatter `date`).
    proposalDate: text("proposal_date").notNull().default(""),
    contentMd: text("content_md").notNull().default(""),
    signedPdfBase64: text("signed_pdf_base64"),
    signerName: text("signer_name"),
    signerEmail: text("signer_email"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    firstViewedAt: timestamp("first_viewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("proposals_slug_unique").on(table.slug),
    index("proposals_company_idx").on(table.companyId),
    index("proposals_status_idx").on(table.status),
  ],
);

// The signed PDF, kept OFF the proposals row.
//
// It used to live in `proposals.signed_pdf_base64`, guarded only by a rule in
// AGENTS.md ("never select() all proposal columns"). One forgetful `select()`
// in a list view would have pulled multiple megabytes of base64 per row. Moving
// it to a side table turns that convention into a structural guarantee: you
// have to join to get the bytes, so you cannot fetch them by accident.
// See planning/004-architecture-hardening (F04).
//
// One row per proposal. `proposals.signed_pdf_base64` is retained for now and
// read as a fallback; it is dropped in a follow-up once this has run a while.
export const proposalDocuments = pgTable(
  "proposal_documents",
  {
    id: serial("id").primaryKey(),
    proposalId: integer("proposal_id")
      .references(() => proposals.id, { onDelete: "cascade" })
      .notNull(),
    pdfBase64: text("pdf_base64").notNull(),
    byteLength: integer("byte_length").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("proposal_documents_proposal_unique").on(table.proposalId)],
);

// Read-only mirror of Stripe charges — the ledger of every dollar collected.
// Mirrored at the charge level (not invoice) because every successful payment
// produces exactly one charge regardless of whether it came from a
// subscription, a one-off invoice, or a payment link. Rebuildable at any time
// from Stripe, which stays the source of truth.
export const payments = pgTable(
  "payments",
  {
    id: serial("id").primaryKey(),
    stripeChargeId: text("stripe_charge_id").notNull(),
    // Nullable: a payment is never dropped because we couldn't match an
    // account. It shows as unlinked until a human assigns it.
    companyId: integer("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    stripeCustomerId: text("stripe_customer_id"),
    // Payment-link charges carry no Stripe Customer, so the payer's identity
    // lives only in billing_details. Stored so unattributed money can still
    // be matched to an account by a human.
    billingEmail: text("billing_email"),
    billingName: text("billing_name"),
    amountCents: integer("amount_cents").notNull(),
    // Stripe's cut. Material here: ~6% of a $10/mo plan.
    feeCents: integer("fee_cents").default(0).notNull(),
    refundedCents: integer("refunded_cents").default(0).notNull(),
    currency: text("currency").default("usd").notNull(),
    status: paymentStatus("status").default("succeeded").notNull(),
    type: paymentType("type").default("one_time").notNull(),
    description: text("description"),
    receiptUrl: text("receipt_url"),
    stripeInvoiceId: text("stripe_invoice_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    // Keeps sandbox data from ever inflating real revenue totals.
    livemode: boolean("livemode").default(true).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("payments_stripe_charge_unique").on(table.stripeChargeId),
    index("payments_company_idx").on(table.companyId),
    index("payments_company_type_idx").on(table.companyId, table.type),
    index("payments_customer_idx").on(table.stripeCustomerId),
    index("payments_paid_at_idx").on(table.paidAt),
  ],
);

// Read-only mirror of Stripe subscriptions. monthlyAmountCents is normalized
// at write time (annual / 12, quarterly / 3, etc.) so comparing against
// deals.valueCents — already an MRR figure — is a plain SUM.
// Holds the CURRENT amount only, not a rate history (ToS 4.5 permits raises).
export const stripeSubscriptions = pgTable(
  "stripe_subscriptions",
  {
    id: serial("id").primaryKey(),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    companyId: integer("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    stripeCustomerId: text("stripe_customer_id"),
    status: text("status").notNull(), // active | past_due | canceled | trialing | unpaid
    monthlyAmountCents: integer("monthly_amount_cents").default(0).notNull(),
    interval: text("interval"), // month | year — kept for display
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    livemode: boolean("livemode").default(true).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("stripe_subscriptions_unique").on(table.stripeSubscriptionId),
    index("stripe_subscriptions_company_idx").on(table.companyId),
    index("stripe_subscriptions_status_idx").on(table.status),
  ],
);

// Geocode + cluster cache so we don't re-hit the geocoding API every render.
export const placeEnrichment = pgTable(
  "place_enrichment",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    formattedAddress: text("formatted_address"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    plazaKey: text("plaza_key"), // shared key for businesses in the same plaza/block
    provider: text("provider"), // 'google' | 'mapbox' | 'nominatim'
    geocodedAt: timestamp("geocoded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("place_enrichment_company_unique").on(table.companyId),
    index("place_enrichment_plaza_idx").on(table.plazaKey),
  ],
);

// Read-only mirror of the GitHub org's repos (plan 005). Nothing here is ever
// written back to GitHub. `/accounts` reads MAX(last_push_at) per company; the
// request path never calls the GitHub API.
export const projectRepos = pgTable(
  "project_repos",
  {
    id: serial("id").primaryKey(),
    // "owner/name" — the stable identity. A rename produces a new row; the old
    // one is marked archived by the next full sync rather than deleted.
    fullName: text("full_name").notNull(),
    // Nullable on purpose: an unmapped repo is still mirrored so it can show up
    // in the "delivery with no account" view. Same contract as payments.company_id.
    companyId: integer("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    // Internal tooling (the CRM itself, toprock_brain, ...) is mirrored but
    // excluded from the orphan view, which would otherwise be mostly noise.
    isInternal: boolean("is_internal").default(false).notNull(),
    isPrivate: boolean("is_private").default(true).notNull(),
    archived: boolean("archived").default(false).notNull(),
    htmlUrl: text("html_url"),
    // The signal. Nullable: a repo with no commits has no pushed_at.
    lastPushAt: timestamp("last_push_at", { withTimezone: true }),
    lastCommitSha: text("last_commit_sha"),
    lastCommitMessage: text("last_commit_message"),
    lastCommitAuthor: text("last_commit_author"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("project_repos_full_name_unique").on(table.fullName),
    index("project_repos_company_idx").on(table.companyId),
    index("project_repos_last_push_idx").on(table.lastPushAt),
  ],
);

export type DealStage = (typeof dealStage.enumValues)[number];
export type ActivityType = (typeof activityType.enumValues)[number];
export type AccountStage = (typeof accountStage.enumValues)[number];
export type EdgeType = (typeof edgeType.enumValues)[number];
export type EntityType = (typeof entityType.enumValues)[number];
export type DataSource = (typeof dataSource.enumValues)[number];
export type SuggestionStatus = (typeof suggestionStatus.enumValues)[number];
export type ProposalStatus = (typeof proposalStatus.enumValues)[number];
export type PaymentStatus = (typeof paymentStatus.enumValues)[number];
export type PaymentType = (typeof paymentType.enumValues)[number];
