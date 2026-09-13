import { and, eq } from "drizzle-orm";
import type { Db } from "@/lib/define-action";
import { accountStageOptions } from "@/lib/account-stage";
import { companyIndustries } from "@/lib/company-industries";
import { normalizeCompanyIndustry } from "@/lib/company-industry-utils";
import { mergeDateWithTime, normalizeUrl } from "@/lib/normalize";
import {
  activities,
  companies,
  contacts,
  deals,
  relationships,
  suggestions,
  type SuggestionStatus,
} from "@/lib/schema";
import {
  parseSuggestionPayload,
  type ParsedSuggestionPayload,
  type SuggestionKind,
} from "@/lib/agent/suggestion-kinds";

type SuggestionRow = typeof suggestions.$inferSelect;

export type ApplySuggestionResult = {
  message: string;
  revalidate: string[];
};

function asKind(kind: string): SuggestionKind {
  return kind as SuggestionKind;
}

async function applyNewCompany(db: Db, payload: ParsedSuggestionPayload["new_company"], evidence: string | null) {
  const existing = await db.query.companies.findFirst({
    where: eq(companies.name, payload.name),
  });

  let companyId = existing?.id ?? null;
  if (!companyId) {
    const normalized = normalizeCompanyIndustry(payload.industry ?? payload.category);
    const industry =
      normalized && (companyIndustries as readonly string[]).includes(normalized) ? normalized : null;
    const inserted = await db
      .insert(companies)
      .values({
        name: payload.name,
        stage: "new_lead",
        industry,
        website: normalizeUrl(payload.website ?? null),
        address: payload.address ?? null,
        lat: payload.lat ?? null,
        lng: payload.lng ?? null,
      })
      .returning({ id: companies.id });
    companyId = inserted[0].id;
  }

  if (payload.nearCompanyId && companyId !== payload.nearCompanyId) {
    const [fromId, toId] =
      companyId < payload.nearCompanyId
        ? [companyId, payload.nearCompanyId]
        : [payload.nearCompanyId, companyId];
    await db
      .insert(relationships)
      .values({
        fromType: "company",
        fromId,
        toType: "company",
        toId,
        edgeType: "colocated_with",
        strength: 80,
        evidence: evidence ?? `Sourced near ${payload.nearCompanyName ?? "a customer"}`,
        source: "agent",
      })
      .onConflictDoNothing();
  }

  return {
    message: `Added ${payload.name} as a new lead`,
    revalidate: ["/accounts", "/map", "/"],
  };
}

async function applyNewContact(db: Db, payload: ParsedSuggestionPayload["new_contact"]) {
  if (payload.email) {
    const existing = await db.query.contacts.findFirst({
      where: eq(contacts.email, payload.email),
    });
    if (existing) {
      throw new Error(`Contact with email ${payload.email} already exists (#${existing.id}).`);
    }
  }

  await db.insert(contacts).values({
    firstName: payload.firstName,
    lastName: payload.lastName,
    email: payload.email,
    phone: payload.phone,
    title: payload.title,
    linkedinProfileUrl: payload.linkedinProfileUrl,
    companyId: payload.companyId,
  });

  return {
    message: `Added contact ${payload.firstName} ${payload.lastName}`,
    revalidate: ["/contacts", "/"],
  };
}

async function applyNewEdge(db: Db, payload: ParsedSuggestionPayload["new_edge"]) {
  const existing = await db.query.relationships.findFirst({
    where: and(
      eq(relationships.fromType, payload.fromType),
      eq(relationships.fromId, payload.fromId),
      eq(relationships.toType, payload.toType),
      eq(relationships.toId, payload.toId),
      eq(relationships.edgeType, payload.edgeType),
    ),
  });
  if (existing) {
    throw new Error("That relationship already exists.");
  }

  await db.insert(relationships).values({
    fromType: payload.fromType,
    fromId: payload.fromId,
    toType: payload.toType,
    toId: payload.toId,
    edgeType: payload.edgeType,
    strength: payload.strength ?? 50,
    evidence: payload.evidence ?? null,
    source: "agent",
  });

  return {
    message: "Relationship added",
    revalidate: ["/accounts"],
  };
}

async function applyLogActivity(db: Db, payload: ParsedSuggestionPayload["log_activity"]) {
  await db.insert(activities).values({
    type: payload.type,
    notes: payload.notes,
    companyId: payload.companyId ?? null,
    contactId: payload.contactId ?? null,
    dealId: payload.dealId ?? null,
    source: "agent",
    occurredAt: mergeDateWithTime(payload.occurredOn) ?? undefined,
  });

  const paths = ["/activities", "/"];
  if (payload.companyId) paths.push(`/accounts/${payload.companyId}`);
  if (payload.contactId) paths.push(`/contacts/${payload.contactId}`);
  if (payload.dealId) paths.push(`/opportunities/${payload.dealId}`);
  return { message: "Activity logged", revalidate: paths };
}

async function applyStageChange(db: Db, payload: ParsedSuggestionPayload["stage_change"]) {
  if (payload.target === "account") {
    const existing = await db.query.companies.findFirst({
      where: eq(companies.id, payload.id),
    });
    if (!existing) {
      throw new Error("Account not found.");
    }
    if (!accountStageOptions.includes(payload.stage)) {
      throw new Error("Invalid account stage.");
    }
    await db.update(companies).set({ stage: payload.stage }).where(eq(companies.id, payload.id));
    await db.insert(activities).values({
      type: "note",
      notes: `Stage changed: ${existing.stage} -> ${payload.stage}. Reason: ${payload.reason}`,
      companyId: existing.id,
      source: "agent",
    });
    return {
      message: `Account marked ${payload.stage}`,
      revalidate: [`/accounts/${existing.id}`, "/accounts", "/"],
    };
  }

  const existing = await db.query.deals.findFirst({
    where: eq(deals.id, payload.id),
  });
  if (!existing) {
    throw new Error("Opportunity not found.");
  }
  await db.update(deals).set({ stage: payload.stage }).where(eq(deals.id, payload.id));
  await db.insert(activities).values({
    type: "note",
    notes: `Stage changed: ${existing.stage} -> ${payload.stage}. Reason: ${payload.reason}`,
    dealId: existing.id,
    companyId: existing.companyId,
    contactId: existing.primaryContactId,
    source: "agent",
  });
  return {
    message: `Opportunity marked ${payload.stage}`,
    revalidate: [`/opportunities/${existing.id}`, "/opportunities", "/"],
  };
}

async function applyNewDeal(db: Db, payload: ParsedSuggestionPayload["new_deal"]) {
  const company = await db.query.companies.findFirst({
    where: eq(companies.id, payload.companyId),
  });
  if (!company) {
    throw new Error("Account not found.");
  }

  const inserted = await db
    .insert(deals)
    .values({
      name: payload.name,
      stage: payload.stage ?? "lead",
      valueCents: payload.valueCents ?? 0,
      implementationCostCents: payload.implementationCostCents ?? 0,
      ownerName: payload.ownerName ?? null,
      nextStep: payload.nextStep ?? "",
      nextStepDueDate: payload.nextStepDueDate ?? null,
      expectedCloseDate: payload.expectedCloseDate ?? null,
      companyId: payload.companyId,
      primaryContactId: payload.primaryContactId ?? null,
    })
    .returning({ id: deals.id });

  return {
    message: `Added opportunity ${payload.name}`,
    revalidate: ["/opportunities", `/opportunities/${inserted[0].id}`, `/accounts/${payload.companyId}`, "/"],
  };
}

async function applyUpdateDeal(db: Db, payload: ParsedSuggestionPayload["update_deal"]) {
  const existing = await db.query.deals.findFirst({
    where: eq(deals.id, payload.dealId),
  });
  if (!existing) {
    throw new Error("Opportunity not found.");
  }

  const fields = payload.fields;
  await db
    .update(deals)
    .set({
      name: fields.name,
      nextStep: fields.nextStep,
      nextStepDueDate: fields.nextStepDueDate === undefined ? undefined : fields.nextStepDueDate,
      expectedCloseDate: fields.expectedCloseDate === undefined ? undefined : fields.expectedCloseDate,
      ownerName: fields.ownerName === undefined ? undefined : fields.ownerName,
      primaryContactId: fields.primaryContactId === undefined ? undefined : fields.primaryContactId,
      valueCents: fields.valueCents,
      implementationCostCents: fields.implementationCostCents,
    })
    .where(eq(deals.id, payload.dealId));

  return {
    message: `Updated opportunity ${existing.name}`,
    revalidate: [`/opportunities/${existing.id}`, "/opportunities", "/"],
  };
}

async function applyUpdateAccount(db: Db, payload: ParsedSuggestionPayload["update_account"]) {
  const existing = await db.query.companies.findFirst({
    where: eq(companies.id, payload.companyId),
  });
  if (!existing) {
    throw new Error("Account not found.");
  }

  const fields = payload.fields;
  const industry =
    fields.industry === undefined ? undefined : normalizeCompanyIndustry(fields.industry);
  await db
    .update(companies)
    .set({
      name: fields.name,
      stage: fields.stage,
      nextStep: fields.nextStep === undefined ? undefined : (fields.nextStep ?? ""),
      nextStepDueDate: fields.nextStepDueDate === undefined ? undefined : fields.nextStepDueDate,
      website: fields.website === undefined ? undefined : normalizeUrl(fields.website),
      industry,
    })
    .where(eq(companies.id, payload.companyId));

  return {
    message: `Updated account ${fields.name ?? existing.name}`,
    revalidate: [`/accounts/${existing.id}`, "/accounts", "/"],
  };
}

export async function applySuggestion(db: Db, suggestion: SuggestionRow): Promise<ApplySuggestionResult> {
  const kind = asKind(suggestion.kind);
  const payload = parseSuggestionPayload(kind, suggestion.payload);

  switch (kind) {
    case "new_company":
      return applyNewCompany(db, payload as ParsedSuggestionPayload["new_company"], suggestion.evidence);
    case "new_contact":
      return applyNewContact(db, payload as ParsedSuggestionPayload["new_contact"]);
    case "new_edge":
      return applyNewEdge(db, payload as ParsedSuggestionPayload["new_edge"]);
    case "log_activity":
      return applyLogActivity(db, payload as ParsedSuggestionPayload["log_activity"]);
    case "stage_change":
      return applyStageChange(db, payload as ParsedSuggestionPayload["stage_change"]);
    case "new_deal":
      return applyNewDeal(db, payload as ParsedSuggestionPayload["new_deal"]);
    case "update_deal":
      return applyUpdateDeal(db, payload as ParsedSuggestionPayload["update_deal"]);
    case "update_account":
      return applyUpdateAccount(db, payload as ParsedSuggestionPayload["update_account"]);
    default:
      throw new Error(`Unsupported suggestion kind: ${suggestion.kind}`);
  }
}

export async function markSuggestionResolved(
  db: Db,
  suggestionId: number,
  status: Extract<SuggestionStatus, "approved" | "auto_applied">,
) {
  await db
    .update(suggestions)
    .set({
      status,
      autoApplied: status === "auto_applied",
      resolvedAt: new Date(),
    })
    .where(eq(suggestions.id, suggestionId));
}
