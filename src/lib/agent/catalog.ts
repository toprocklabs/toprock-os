export type AgentToolName =
  | "list_accounts"
  | "get_account"
  | "list_contacts"
  | "get_contact"
  | "list_opportunities"
  | "get_opportunity"
  | "list_tasks"
  | "list_activities"
  | "list_suggestions"
  | "list_project_repos"
  | "account_timeline"
  | "list_stalled_opportunities"
  | "propose_suggestion"
  | "sync_project_repos";

export type McpToolDefinition = {
  name: AgentToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

const limitProperty = {
  type: "integer",
  minimum: 1,
  maximum: 100,
  description: "Max rows to return (default 50, max 100).",
};

export const MCP_INSTRUCTIONS = [
  "You are connected to Toprock CRM as a PM agent (Paul). Read freely; write only by proposing inbox suggestions.",
  "UI terms: Account = companies table, Opportunity = deals table.",
  "Never invent deal values (MRR / implementation cost). Only include money fields when evidence cites a real number from a meeting, email, or signed SOW.",
  "Stage changes need concrete evidence of what was said or observed. Do not guess pipeline movement.",
  "Never contact clients. This API does not send email, call, or message anyone.",
  "Writes go to /inbox as suggestions (source=agent). A human approves them. Auto-apply is off unless operators enable it, and never for stage/money/account updates.",
  "Do not call the GitHub API yourself against this product's request path — use sync_project_repos when the mirror is stale. /accounts reads Postgres only.",
].join(" ");

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "list_accounts",
    description: "Search/list CRM accounts (companies). Filter by name query and/or account stage.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive name search." },
        stage: {
          type: "string",
          enum: ["new_lead", "attempting_to_engage", "engaged", "in_pipeline", "customer", "closed_lost"],
        },
        limit: limitProperty,
      },
    },
  },
  {
    name: "get_account",
    description: "Get one account by id, plus its contacts, opportunities, linked repos, and recent activities.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer", minimum: 1 } },
      required: ["id"],
    },
  },
  {
    name: "list_contacts",
    description: "Search/list contacts. Filter by name/email query and/or account id.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive search on name or email." },
        companyId: { type: "integer", minimum: 1 },
        limit: limitProperty,
      },
    },
  },
  {
    name: "get_contact",
    description: "Get one contact by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer", minimum: 1 } },
      required: ["id"],
    },
  },
  {
    name: "list_opportunities",
    description: "Search/list opportunities (deals). Filter by name query, stage, and/or account id.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        stage: {
          type: "string",
          enum: ["lead", "qualified", "proposal", "negotiation", "won", "lost"],
        },
        companyId: { type: "integer", minimum: 1 },
        limit: limitProperty,
      },
    },
  },
  {
    name: "get_opportunity",
    description: "Get one opportunity by id, plus recent activities on that deal.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer", minimum: 1 } },
      required: ["id"],
    },
  },
  {
    name: "list_tasks",
    description: "List follow-up tasks. Filter by status and/or account id.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "done"] },
        companyId: { type: "integer", minimum: 1 },
        limit: limitProperty,
      },
    },
  },
  {
    name: "list_activities",
    description: "List recent timeline activities. Filter by account, contact, or opportunity.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "integer", minimum: 1 },
        contactId: { type: "integer", minimum: 1 },
        dealId: { type: "integer", minimum: 1 },
        limit: { ...limitProperty, description: "Max rows (default 25, max 100)." },
      },
    },
  },
  {
    name: "list_suggestions",
    description: "List human-in-the-loop inbox suggestions. Defaults to pending.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "approved", "rejected", "auto_applied", "all"] },
        kind: {
          type: "string",
          enum: [
            "new_company",
            "new_contact",
            "new_edge",
            "log_activity",
            "stage_change",
            "new_deal",
            "update_deal",
            "update_account",
          ],
        },
        limit: limitProperty,
      },
    },
  },
  {
    name: "list_project_repos",
    description:
      "List the GitHub org repo mirror (Postgres only — does not call GitHub). Optionally filter by account.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "integer", minimum: 1, description: "Only repos linked to this account." },
        includeArchived: { type: "boolean", description: "Include archived rows. Default false." },
        includeInternal: { type: "boolean", description: "Include internal tooling repos. Default true." },
        limit: limitProperty,
      },
    },
  },
  {
    name: "account_timeline",
    description:
      "One merged timeline for an account: activity logged on the account itself, on any of its opportunities, and on any of its contacts, newest first. Use this instead of list_activities when asked what is happening with a client — list_activities only matches activity tagged directly to the account and will miss the rest.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "integer", minimum: 1 },
        since: { type: "string", description: "Only activity on or after this date (YYYY-MM-DD)." },
        limit: limitProperty,
      },
      required: ["accountId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_stalled_opportunities",
    description:
      "Open opportunities (not won, not lost) ordered by how long they have been silent, with days since the last logged activity. Answers \"who is stuck in negotiation?\" — deals with no activity at all sort first.",
    inputSchema: {
      type: "object",
      properties: {
        stage: {
          type: "string",
          enum: ["lead", "qualified", "proposal", "negotiation"],
        },
        limit: limitProperty,
      },
      additionalProperties: false,
    },
  },
  {
    name: "propose_suggestion",
    description:
      "Create a pending inbox suggestion. Does not write core CRM tables. Required: kind, title, evidence, confidence (0-100), payload. Safety: never invent deal values; stage changes need evidence; never contact clients.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [
            "new_company",
            "new_contact",
            "new_edge",
            "log_activity",
            "stage_change",
            "new_deal",
            "update_deal",
            "update_account",
          ],
        },
        title: { type: "string", description: "Short human summary for the inbox row." },
        evidence: {
          type: "string",
          description: "Why this write is justified (meeting quote, commit, email). Required.",
        },
        confidence: { type: "integer", minimum: 0, maximum: 100 },
        payload: { type: "object", description: "Kind-specific JSON. See AGENTS.md for shapes." },
        model: { type: "string", description: "Optional model name for agent_runs audit." },
        loop: { type: "string", description: "Optional agent_runs.loop label. Default pm_agent." },
      },
      required: ["kind", "title", "evidence", "confidence", "payload"],
    },
  },
  {
    name: "sync_project_repos",
    description:
      "Refresh the project_repos mirror from the GitHub org listing. Same logic as npm run sync:repos. Does not change company_id or is_internal. Use dryRun to preview.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", description: "Plan the sync without writing. Default false." },
      },
    },
  },
];
