import { z } from "zod";
import { accountStageOptions } from "@/lib/account-stage";
import { edgeTypeOptions } from "@/lib/edge-type";
import { cleanOptionalText, normalizeUrl, normalizeUsPhone } from "@/lib/normalize";

export const SUGGESTION_KINDS = [
  "new_company",
  "new_contact",
  "new_edge",
  "log_activity",
  "stage_change",
  "new_deal",
  "update_deal",
  "update_account",
] as const;

export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

export const suggestionKindSchema = z.enum(SUGGESTION_KINDS);

const activityTypeSchema = z.enum([
  "note",
  "call",
  "meeting",
  "email",
  "instagram",
  "linkedin",
  "task",
]);

const dealStageSchema = z.enum(["lead", "qualified", "proposal", "negotiation", "won", "lost"]);
const accountStageSchema = z.enum(accountStageOptions);
const entityTypeSchema = z.enum(["company", "contact"]);
const optionalDateSchema = z.string().date().optional().nullable();

export const newCompanyPayloadSchema = z.object({
  name: z.string().trim().min(2),
  category: z.string().trim().optional(),
  address: z.string().trim().optional().nullable(),
  lat: z.number().optional().nullable(),
  lng: z.number().optional().nullable(),
  nearCompanyId: z.number().int().positive().optional(),
  nearCompanyName: z.string().trim().optional(),
  distanceMeters: z.number().optional().nullable(),
  industry: z.string().trim().optional(),
  website: z.string().trim().optional(),
});

export const newContactPayloadSchema = z
  .object({
    firstName: z.string().trim().min(1),
    lastName: z.string().trim().min(1),
    email: z.string().trim().email().optional().or(z.literal("")),
    phone: z.string().trim().optional(),
    title: z.string().trim().optional(),
    linkedinProfileUrl: z.string().trim().optional(),
    companyId: z.number().int().positive().optional(),
  })
  .transform((payload) => {
    const phone = payload.phone ? normalizeUsPhone(payload.phone) : null;
    return {
      firstName: payload.firstName,
      lastName: payload.lastName,
      email: cleanOptionalText(payload.email) ?? null,
      phone,
      title: cleanOptionalText(payload.title),
      linkedinProfileUrl: normalizeUrl(cleanOptionalText(payload.linkedinProfileUrl) ?? null),
      companyId: payload.companyId ?? null,
    };
  });

export const newEdgePayloadSchema = z
  .object({
    fromType: entityTypeSchema,
    fromId: z.number().int().positive(),
    toType: entityTypeSchema,
    toId: z.number().int().positive(),
    edgeType: z.enum(edgeTypeOptions),
    strength: z.number().int().min(0).max(100).optional(),
    evidence: z.string().trim().optional(),
  })
  .refine((payload) => !(payload.fromType === payload.toType && payload.fromId === payload.toId), {
    message: "An entity cannot have a relationship to itself.",
  });

export const logActivityPayloadSchema = z
  .object({
    type: activityTypeSchema,
    notes: z.string().trim().min(2),
    companyId: z.number().int().positive().optional(),
    contactId: z.number().int().positive().optional(),
    dealId: z.number().int().positive().optional(),
    occurredOn: z.string().date().optional(),
  })
  .refine((payload) => payload.companyId || payload.contactId || payload.dealId, {
    message: "Activity must attach to an account, contact, or opportunity.",
  });

export const stageChangePayloadSchema = z.discriminatedUnion("target", [
  z.object({
    target: z.literal("account"),
    id: z.number().int().positive(),
    stage: accountStageSchema,
    reason: z.string().trim().min(8),
  }),
  z.object({
    target: z.literal("opportunity"),
    id: z.number().int().positive(),
    stage: dealStageSchema,
    reason: z.string().trim().min(8),
  }),
]);

export const newDealPayloadSchema = z.object({
  name: z.string().trim().min(2),
  companyId: z.number().int().positive(),
  stage: dealStageSchema.optional(),
  ownerName: z.string().trim().optional(),
  nextStep: z.string().trim().optional(),
  nextStepDueDate: optionalDateSchema,
  expectedCloseDate: optionalDateSchema,
  primaryContactId: z.number().int().positive().optional(),
  valueCents: z.number().int().min(0).optional(),
  implementationCostCents: z.number().int().min(0).optional(),
});

export const updateDealPayloadSchema = z.object({
  dealId: z.number().int().positive(),
  fields: z
    .object({
      name: z.string().trim().min(2).optional(),
      nextStep: z.string().trim().min(2).optional(),
      nextStepDueDate: optionalDateSchema,
      expectedCloseDate: optionalDateSchema,
      ownerName: z.string().trim().optional().nullable(),
      primaryContactId: z.number().int().positive().optional().nullable(),
      valueCents: z.number().int().min(0).optional(),
      implementationCostCents: z.number().int().min(0).optional(),
    })
    .refine((fields) => Object.values(fields).some((value) => value !== undefined), {
      message: "At least one field is required.",
    }),
});

export const updateAccountPayloadSchema = z.object({
  companyId: z.number().int().positive(),
  fields: z
    .object({
      name: z.string().trim().min(2).optional(),
      stage: accountStageSchema.optional(),
      nextStep: z.string().trim().optional(),
      nextStepDueDate: optionalDateSchema,
      website: z.string().trim().optional().nullable(),
      industry: z.string().trim().optional().nullable(),
    })
    .refine((fields) => Object.values(fields).some((value) => value !== undefined), {
      message: "At least one field is required.",
    }),
});

export const payloadSchemas = {
  new_company: newCompanyPayloadSchema,
  new_contact: newContactPayloadSchema,
  new_edge: newEdgePayloadSchema,
  log_activity: logActivityPayloadSchema,
  stage_change: stageChangePayloadSchema,
  new_deal: newDealPayloadSchema,
  update_deal: updateDealPayloadSchema,
  update_account: updateAccountPayloadSchema,
} as const;

export const proposeSuggestionEnvelopeSchema = z.object({
  kind: suggestionKindSchema,
  title: z.string().trim().min(4).max(240),
  evidence: z.string().trim().min(8).max(4000),
  confidence: z.number().int().min(0).max(100),
  payload: z.unknown(),
  model: z.string().trim().max(80).optional(),
  loop: z.string().trim().max(80).optional(),
});

export type ProposeSuggestionEnvelope = z.infer<typeof proposeSuggestionEnvelopeSchema>;

export type ParsedSuggestionPayload = {
  [K in SuggestionKind]: z.infer<(typeof payloadSchemas)[K]>;
};

export type ProposeSuggestion<K extends SuggestionKind = SuggestionKind> = {
  kind: K;
  title: string;
  evidence: string;
  confidence: number;
  payload: ParsedSuggestionPayload[K];
  model?: string;
  loop?: string;
};

export class SuggestionValidationError extends Error {
  issues: string[];

  constructor(issues: string[]) {
    super(issues[0] ?? "Invalid suggestion.");
    this.name = "SuggestionValidationError";
    this.issues = issues;
  }
}

function zodIssues(error: z.ZodError) {
  return error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "payload";
    return `${path}: ${issue.message}`;
  });
}

export function evidenceCitesAmount(evidence: string) {
  return /\d/.test(evidence);
}

export function payloadHasDealMoney(kind: SuggestionKind, payload: unknown) {
  if (kind === "new_deal") {
    const value = payload as z.infer<typeof newDealPayloadSchema>;
    return value.valueCents != null || value.implementationCostCents != null;
  }
  if (kind === "update_deal") {
    const value = payload as z.infer<typeof updateDealPayloadSchema>;
    return value.fields.valueCents != null || value.fields.implementationCostCents != null;
  }
  return false;
}

export function parseSuggestionPayload<K extends SuggestionKind>(kind: K, payload: unknown): ParsedSuggestionPayload[K] {
  const parsed = payloadSchemas[kind].safeParse(payload);
  if (!parsed.success) {
    throw new SuggestionValidationError(zodIssues(parsed.error));
  }
  return parsed.data as ParsedSuggestionPayload[K];
}

export function parseProposeSuggestion(input: unknown): ProposeSuggestion {
  const envelopeParsed = proposeSuggestionEnvelopeSchema.safeParse(input);
  if (!envelopeParsed.success) {
    throw new SuggestionValidationError(zodIssues(envelopeParsed.error));
  }

  const envelope = envelopeParsed.data;
  const payload = parseSuggestionPayload(envelope.kind, envelope.payload);

  if (envelope.kind === "stage_change" && envelope.evidence.trim().length < 12) {
    throw new SuggestionValidationError([
      "evidence: stage changes need concrete evidence (what was said or observed, not a guess).",
    ]);
  }

  if (payloadHasDealMoney(envelope.kind, payload) && !evidenceCitesAmount(envelope.evidence)) {
    throw new SuggestionValidationError([
      "evidence: deal values require cited evidence (a number from a meeting, email, or signed SOW). Do not invent MRR or implementation cost.",
    ]);
  }

  return {
    kind: envelope.kind,
    title: envelope.title,
    evidence: envelope.evidence,
    confidence: envelope.confidence,
    payload,
    model: envelope.model,
    loop: envelope.loop,
  };
}

export type SuggestionInsertShape = {
  kind: SuggestionKind;
  title: string;
  payload: ParsedSuggestionPayload[SuggestionKind];
  confidence: number;
  evidence: string;
  source: "agent";
  status: "pending";
  autoApplied: false;
  agentRunId: number | null;
};

export function buildSuggestionInsert(
  input: ProposeSuggestion,
  agentRunId?: number | null,
): SuggestionInsertShape {
  return {
    kind: input.kind,
    title: input.title,
    payload: input.payload,
    confidence: input.confidence,
    evidence: input.evidence,
    source: "agent",
    status: "pending",
    autoApplied: false,
    agentRunId: agentRunId ?? null,
  };
}

export function suggestionKindLabel(kind: string) {
  switch (kind) {
    case "new_company":
      return "New account";
    case "new_contact":
      return "New contact";
    case "new_edge":
      return "Relationship";
    case "log_activity":
      return "Activity";
    case "stage_change":
      return "Stage change";
    case "new_deal":
      return "New opportunity";
    case "update_deal":
      return "Update opportunity";
    case "update_account":
      return "Update account";
    default:
      return kind;
  }
}

export function summarizeSuggestionPayload(kind: string, payload: unknown) {
  const value = (payload ?? {}) as Record<string, unknown>;
  switch (kind) {
    case "new_company":
      return [value.name, value.category, value.nearCompanyName ? `near ${value.nearCompanyName}` : null]
        .filter(Boolean)
        .join(" · ");
    case "new_contact":
      return [`${value.firstName ?? ""} ${value.lastName ?? ""}`.trim(), value.title, value.email]
        .filter(Boolean)
        .join(" · ");
    case "new_edge":
      return `${value.fromType} #${value.fromId} ${value.edgeType} ${value.toType} #${value.toId}`;
    case "log_activity":
      return `${value.type ?? "note"}: ${String(value.notes ?? "").slice(0, 140)}`;
    case "stage_change":
      return `${value.target} #${value.id} → ${value.stage}`;
    case "new_deal":
      return `${value.name ?? "Opportunity"} · account #${value.companyId}`;
    case "update_deal": {
      const fields = (value.fields ?? {}) as Record<string, unknown>;
      return `opportunity #${value.dealId}: ${Object.keys(fields).join(", ")}`;
    }
    case "update_account": {
      const fields = (value.fields ?? {}) as Record<string, unknown>;
      return `account #${value.companyId}: ${Object.keys(fields).join(", ")}`;
    }
    default:
      return "";
  }
}
