"use server";

import { and, eq, ilike, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { setFlashToast } from "@/lib/flash";
import { defineAction, type Db } from "@/lib/define-action";
import { accountStageOptions } from "@/lib/account-stage";
import { edgeTypeOptions } from "@/lib/edge-type";
import { companyIndustries } from "@/lib/company-industries";
import { normalizeCompanyIndustry } from "@/lib/company-industry-utils";
import { scrapeCompanyWebsite } from "@/lib/enrich";
import { geocodeAddress } from "@/lib/geocode";
import { sourceNearbyBusinesses } from "@/lib/source-nearby";
import { applySuggestion, markSuggestionResolved } from "@/lib/agent/apply-suggestion";
import { SuggestionValidationError } from "@/lib/agent/suggestion-kinds";
import { activities, agentRuns, companies, contacts, deals, payments, placeEnrichment, proposals, relationships, salesTasks, stripeSubscriptions, suggestions, users } from "@/lib/schema";
import { generatePin } from "@/lib/proposal/pin";
import { parsePricingTotals } from "@/lib/proposal/markdown";
import { cleanOptionalText, mergeDateWithTime, normalizeUrl, normalizeUsPhone } from "@/lib/normalize";

const optionalCompanyIndustrySchema = z.enum(companyIndustries).optional().or(z.literal(""));
const accountStageSchema = z.enum(accountStageOptions);

const companySchema = z.object({
  name: z.string().trim().min(2),
  stage: accountStageSchema,
  website: z.string().trim().optional(),
  customerProjectUrl: z.string().trim().optional(),
  industry: optionalCompanyIndustrySchema,
  nextStep: z.string().trim().optional(),
  nextStepDueDate: z.string().optional(),
});

const contactSchema = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  email: z.string().trim().email().optional().or(z.literal("")),
  phone: z.string().trim().optional(),
  linkedinProfileUrl: z.string().trim().optional(),
  title: z.string().trim().optional(),
  companyId: z.coerce.number().int().positive().optional(),
});

const dealSchema = z.object({
  name: z.string().trim().min(2),
  stage: z.enum(["lead", "qualified", "proposal", "negotiation", "won", "lost"]),
  mrrUsd: z.coerce.number().min(0),
  implementationCostUsd: z.coerce.number().min(0),
  ownerName: z.string().trim().optional(),
  nextStep: z.string().trim().min(2),
  nextStepDueDate: z.string().optional(),
  companyId: z.coerce.number().int().positive().optional(),
  expectedCloseDate: z.string().optional(),
});

const dealUpdateSchema = z.object({
  dealId: z.coerce.number().int().positive(),
  name: z.string().trim().min(2),
  mrrUsd: z.coerce.number().min(0),
  implementationCostUsd: z.coerce.number().min(0),
  ownerName: z.string().trim().optional(),
  nextStep: z.string().trim().min(2),
  nextStepDueDate: z.string().optional(),
  expectedCloseDate: z.string().optional(),
  companyId: z.coerce.number().int().positive().optional(),
  primaryContactId: z.coerce.number().int().positive().optional(),
});

const dealStageUpdateSchema = z.object({
  dealId: z.coerce.number().int().positive(),
  stage: z.enum(["lead", "qualified", "proposal", "negotiation", "won", "lost"]),
  reason: z.string().trim().optional(),
});

const dealFieldUpdateSchema = z.object({
  dealId: z.coerce.number().int().positive(),
  field: z.enum([
    "name",
    "mrrUsd",
    "implementationCostUsd",
    "ownerName",
    "nextStep",
    "nextStepDueDate",
    "expectedCloseDate",
    "companyId",
    "primaryContactId",
  ]),
  value: z.string().optional(),
});

const taskSchema = z.object({
  title: z.string().trim().min(2),
  dueDate: z.string().min(4),
  assignedTo: z.string().trim().optional(),
  dealId: z.coerce.number().int().positive().optional(),
  companyId: z.coerce.number().int().positive().optional(),
  returnPath: z.string().optional(),
});

const completeTaskSchema = z.object({
  taskId: z.coerce.number().int().positive(),
  returnPath: z.string().optional(),
});

const activitySchema = z.object({
  type: z.enum(["note", "call", "meeting", "email", "instagram", "linkedin", "task"]),
  notes: z.string().trim().min(2),
  dealId: z.coerce.number().int().positive().optional(),
  contactId: z.coerce.number().int().positive().optional(),
  companyId: z.coerce.number().int().positive().optional(),
  occurredOn: z.string().optional(),
  returnPath: z.string().optional(),
});

const activityDateUpdateSchema = z.object({
  activityId: z.coerce.number().int().positive(),
  occurredOn: z.string().min(4),
  returnPath: z.string().optional(),
});

const contactFieldUpdateSchema = z.object({
  contactId: z.coerce.number().int().positive(),
  field: z.enum(["title", "email", "phone", "linkedinProfileUrl"]),
  value: z.string().optional(),
  returnPath: z.string().optional(),
});

const companyFieldUpdateSchema = z.object({
  companyId: z.coerce.number().int().positive(),
  field: z.enum(["stage", "website", "customerProjectUrl", "industry", "nextStep", "nextStepDueDate"]),
  value: z.string().optional(),
});

const entityTypeSchema = z.enum(["company", "contact"]);

const relationshipSchema = z.object({
  fromType: entityTypeSchema,
  fromId: z.coerce.number().int().positive(),
  toType: entityTypeSchema,
  toId: z.coerce.number().int().positive(),
  edgeType: z.enum(edgeTypeOptions as [string, ...string[]]),
  strength: z.coerce.number().int().min(0).max(100).optional(),
  evidence: z.string().trim().optional(),
  returnPath: z.string().optional(),
});

const relationshipDeleteSchema = z.object({
  relationshipId: z.coerce.number().int().positive(),
  returnPath: z.string().optional(),
});

// Normalization helpers now live in @/lib/normalize — see the import above.
// They were module-private here, which made them impossible to unit test.

export const createCompany = defineAction({
  schema: companySchema,
  input: (formData) => ({
    name: formData.get("name"),
    stage: formData.get("stage"),
    website: formData.get("website"),
    customerProjectUrl: formData.get("customerProjectUrl"),
    industry: formData.get("industry"),
    nextStep: formData.get("nextStep"),
    nextStepDueDate: formData.get("nextStepDueDate"),
  }),
  handler: async ({ input: parsed, db }) => {
  await db.insert(companies).values({
    name: parsed.name,
    stage: parsed.stage,
    website: normalizeUrl(cleanOptionalText(parsed.website)),
    customerProjectUrl: normalizeUrl(cleanOptionalText(parsed.customerProjectUrl)),
    industry: normalizeCompanyIndustry(parsed.industry),
    nextStep: cleanOptionalText(parsed.nextStep) ?? "",
    nextStepDueDate: cleanOptionalText(parsed.nextStepDueDate),
  });

  revalidatePath("/");
  revalidatePath("/accounts");
  await setFlashToast("Account created");
  },
});

export const createContact = defineAction({
  schema: contactSchema,
  input: (formData) => {
    const rawCompanyId = formData.get("companyId")?.toString();

    return {
      firstName: formData.get("firstName"),
      lastName: formData.get("lastName"),
      email: formData.get("email"),
      phone: formData.get("phone"),
      linkedinProfileUrl: formData.get("linkedinProfileUrl"),
      title: formData.get("title"),
      companyId: rawCompanyId ? Number(rawCompanyId) : undefined,
    };
  },
  handler: async ({ input: parsed, db }) => {
  await db.insert(contacts).values({
    firstName: parsed.firstName,
    lastName: parsed.lastName,
    email: cleanOptionalText(parsed.email),
    phone: normalizeUsPhone(parsed.phone),
    linkedinProfileUrl: normalizeUrl(cleanOptionalText(parsed.linkedinProfileUrl)),
    title: cleanOptionalText(parsed.title),
    companyId: parsed.companyId ?? null,
  });

  revalidatePath("/");
  revalidatePath("/contacts");
  await setFlashToast("Contact created");
  },
});

export const updateContactField = defineAction({
  schema: contactFieldUpdateSchema,
  input: (formData) => ({
    contactId: formData.get("contactId"),
    field: formData.get("field"),
    value: formData.get("value"),
    returnPath: formData.get("returnPath"),
  }),
  handler: async ({ input: parsed, db }) => {
  const cleaned = cleanOptionalText(parsed.value);

  if (parsed.field === "email" && cleaned) {
    z.string().email().parse(cleaned);
  }

  if (parsed.field === "title") {
    await db.update(contacts).set({ title: cleaned }).where(eq(contacts.id, parsed.contactId));
  }

  if (parsed.field === "email") {
    await db.update(contacts).set({ email: cleaned }).where(eq(contacts.id, parsed.contactId));
  }

  if (parsed.field === "phone") {
    await db.update(contacts).set({ phone: normalizeUsPhone(parsed.value) }).where(eq(contacts.id, parsed.contactId));
  }

  if (parsed.field === "linkedinProfileUrl") {
    await db
      .update(contacts)
      .set({ linkedinProfileUrl: normalizeUrl(cleanOptionalText(parsed.value)) })
      .where(eq(contacts.id, parsed.contactId));
  }

  revalidatePath(`/contacts/${parsed.contactId}`);
  revalidatePath("/contacts");
  if (parsed.returnPath?.startsWith("/")) {
    revalidatePath(parsed.returnPath);
  }
  },
});

export const updateCompanyField = defineAction({
  schema: companyFieldUpdateSchema,
  input: (formData) => ({
    companyId: formData.get("companyId"),
    field: formData.get("field"),
    value: formData.get("value"),
  }),
  handler: async ({ input: parsed, db }) => {
  const cleaned = cleanOptionalText(parsed.value);

  const normalizedUrl = normalizeUrl(cleaned);

  if ((parsed.field === "customerProjectUrl" || parsed.field === "website") && normalizedUrl) {
    z.string().url().parse(normalizedUrl);
  }

  if (parsed.field === "industry") {
    optionalCompanyIndustrySchema.parse(parsed.value ?? "");
  }

  if (parsed.field === "stage") {
    accountStageSchema.parse(parsed.value);
  }

  if (parsed.field === "nextStepDueDate" && cleaned) {
    z.string().date().parse(cleaned);
  }

  const stageValue = parsed.field === "stage" ? accountStageSchema.parse(parsed.value) : undefined;

  await db
    .update(companies)
    .set({
      stage: stageValue,
      website: parsed.field === "website" ? normalizedUrl : undefined,
      customerProjectUrl: parsed.field === "customerProjectUrl" ? normalizedUrl : undefined,
      industry: parsed.field === "industry" ? normalizeCompanyIndustry(parsed.value) : undefined,
      nextStep: parsed.field === "nextStep" ? cleaned ?? "" : undefined,
      nextStepDueDate: parsed.field === "nextStepDueDate" ? cleaned : undefined,
    })
    .where(eq(companies.id, parsed.companyId));

  revalidatePath(`/accounts/${parsed.companyId}`);
  revalidatePath("/accounts");
  },
});

export const createDeal = defineAction({
  schema: dealSchema,
  input: (formData) => {
    const rawCompanyId = formData.get("companyId")?.toString();

    return {
      name: formData.get("name"),
      stage: formData.get("stage"),
      mrrUsd: formData.get("mrrUsd"),
      implementationCostUsd: formData.get("implementationCostUsd"),
      ownerName: formData.get("ownerName"),
      nextStep: formData.get("nextStep"),
      nextStepDueDate: formData.get("nextStepDueDate"),
      companyId: rawCompanyId ? Number(rawCompanyId) : undefined,
      expectedCloseDate: formData.get("expectedCloseDate"),
    };
  },
  handler: async ({ input: parsed, db }) => {
  await db.insert(deals).values({
    name: parsed.name,
    stage: parsed.stage,
    valueCents: Math.round(parsed.mrrUsd * 100),
    implementationCostCents: Math.round(parsed.implementationCostUsd * 100),
    ownerName: cleanOptionalText(parsed.ownerName),
    nextStep: parsed.nextStep,
    nextStepDueDate: cleanOptionalText(parsed.nextStepDueDate),
    companyId: parsed.companyId ?? null,
    expectedCloseDate: cleanOptionalText(parsed.expectedCloseDate),
  });

  revalidatePath("/");
  revalidatePath("/opportunities");
  await setFlashToast("Opportunity created");
  },
});

export const updateDeal = defineAction({
  schema: dealUpdateSchema,
  input: (formData) => {
    const rawCompanyId = formData.get("companyId")?.toString();
    const rawPrimaryContactId = formData.get("primaryContactId")?.toString();

    return {
      dealId: formData.get("dealId"),
      name: formData.get("name"),
      mrrUsd: formData.get("mrrUsd"),
      implementationCostUsd: formData.get("implementationCostUsd"),
      ownerName: formData.get("ownerName"),
      nextStep: formData.get("nextStep"),
      nextStepDueDate: formData.get("nextStepDueDate"),
      expectedCloseDate: formData.get("expectedCloseDate"),
      companyId: rawCompanyId ? Number(rawCompanyId) : undefined,
      primaryContactId: rawPrimaryContactId ? Number(rawPrimaryContactId) : undefined,
    };
  },
  handler: async ({ input: parsed, db }) => {
  await db
    .update(deals)
    .set({
      name: parsed.name,
      valueCents: Math.round(parsed.mrrUsd * 100),
      implementationCostCents: Math.round(parsed.implementationCostUsd * 100),
      ownerName: cleanOptionalText(parsed.ownerName),
      nextStep: parsed.nextStep,
      nextStepDueDate: cleanOptionalText(parsed.nextStepDueDate),
      expectedCloseDate: cleanOptionalText(parsed.expectedCloseDate),
      companyId: parsed.companyId ?? null,
      primaryContactId: parsed.primaryContactId ?? null,
    })
    .where(eq(deals.id, parsed.dealId));

  revalidatePath("/");
  revalidatePath("/opportunities");
  revalidatePath(`/opportunities/${parsed.dealId}`);
  await setFlashToast("Opportunity updated");
  },
});

export const updateDealField = defineAction({
  schema: dealFieldUpdateSchema,
  input: (formData) => ({
    dealId: formData.get("dealId"),
    field: formData.get("field"),
    value: formData.get("value"),
  }),
  handler: async ({ input: parsed, db }) => {
  const cleaned = cleanOptionalText(parsed.value);

  if (parsed.field === "name" || parsed.field === "nextStep") {
    const text = z.string().trim().min(2).parse(parsed.value);
    await db
      .update(deals)
      .set(parsed.field === "name" ? { name: text } : { nextStep: text })
      .where(eq(deals.id, parsed.dealId));
  }

  if (parsed.field === "mrrUsd" || parsed.field === "implementationCostUsd") {
    const amount = z.coerce.number().min(0).parse(parsed.value);
    const cents = Math.round(amount * 100);
    await db
      .update(deals)
      .set(parsed.field === "mrrUsd" ? { valueCents: cents } : { implementationCostCents: cents })
      .where(eq(deals.id, parsed.dealId));
  }

  if (parsed.field === "ownerName") {
    await db.update(deals).set({ ownerName: cleaned }).where(eq(deals.id, parsed.dealId));
  }

  if (parsed.field === "nextStepDueDate" || parsed.field === "expectedCloseDate") {
    if (cleaned) {
      z.string().date().parse(cleaned);
    }
    await db
      .update(deals)
      .set(parsed.field === "nextStepDueDate" ? { nextStepDueDate: cleaned } : { expectedCloseDate: cleaned })
      .where(eq(deals.id, parsed.dealId));
  }

  if (parsed.field === "companyId" || parsed.field === "primaryContactId") {
    const id = cleaned ? z.coerce.number().int().positive().parse(cleaned) : null;
    await db
      .update(deals)
      .set(parsed.field === "companyId" ? { companyId: id } : { primaryContactId: id })
      .where(eq(deals.id, parsed.dealId));
  }

  revalidatePath("/");
  revalidatePath("/opportunities");
  revalidatePath(`/opportunities/${parsed.dealId}`);
  },
});

export const updateDealStage = defineAction({
  schema: dealStageUpdateSchema,
  input: (formData) => ({
    dealId: formData.get("dealId"),
    stage: formData.get("stage"),
    reason: formData.get("reason"),
  }),
  handler: async ({ input: parsed, db }) => {
  const existing = await db.query.deals.findFirst({
    where: eq(deals.id, parsed.dealId),
  });

  if (!existing) {
    throw new Error("Opportunity not found.");
  }

  await db
    .update(deals)
    .set({
      stage: parsed.stage,
    })
    .where(eq(deals.id, parsed.dealId));

  const reasonText =
    cleanOptionalText(parsed.reason) ?? (parsed.stage === "lost" ? "No reason provided." : null);
  const stageHistoryNote = reasonText
    ? `Stage changed: ${existing.stage} -> ${parsed.stage}. Reason: ${reasonText}`
    : `Stage changed: ${existing.stage} -> ${parsed.stage}.`;

  await db.insert(activities).values({
    type: "note",
    notes: stageHistoryNote,
    dealId: existing.id,
    companyId: existing.companyId,
    contactId: existing.primaryContactId,
  });

  revalidatePath("/");
  revalidatePath("/opportunities");
  revalidatePath(`/opportunities/${parsed.dealId}`);
  await setFlashToast(`Opportunity marked ${parsed.stage}`);
  },
});

export const createTask = defineAction({
  schema: taskSchema,
  input: (formData) => {
    const rawDealId = formData.get("dealId")?.toString();
    const rawCompanyId = formData.get("companyId")?.toString();

    return {
      title: formData.get("title"),
      dueDate: formData.get("dueDate"),
      assignedTo: formData.get("assignedTo"),
      dealId: rawDealId ? Number(rawDealId) : undefined,
      companyId: rawCompanyId ? Number(rawCompanyId) : undefined,
      returnPath: formData.get("returnPath"),
    };
  },
  handler: async ({ input: parsed, db }) => {
  let cleanedAssignedTo = cleanOptionalText(parsed.assignedTo);

  if (cleanedAssignedTo) {
    const userRows = await db.select({ username: users.username }).from(users);
    const usernames = new Set(userRows.map((row) => row.username));

    if (!usernames.has(cleanedAssignedTo)) {
      cleanedAssignedTo = null;
    }
  }

  await db.insert(salesTasks).values({
    title: parsed.title,
    dueDate: parsed.dueDate,
    assignedTo: cleanedAssignedTo,
    dealId: parsed.dealId ?? null,
    companyId: parsed.companyId ?? null,
  });

  revalidatePath("/");
  revalidatePath("/tasks");
  if (parsed.returnPath?.startsWith("/")) {
    revalidatePath(parsed.returnPath);
  }
  await setFlashToast("Task created");
  },
});

export const completeTask = defineAction({
  schema: completeTaskSchema,
  input: (formData) => ({
    taskId: formData.get("taskId"),
    returnPath: formData.get("returnPath"),
  }),
  handler: async ({ input: parsed, db }) => {
  await db.update(salesTasks).set({ status: "done" }).where(eq(salesTasks.id, parsed.taskId));

  revalidatePath("/");
  revalidatePath("/tasks");
  if (parsed.returnPath?.startsWith("/")) {
    revalidatePath(parsed.returnPath);
  }
  await setFlashToast("Task completed");
  },
});

export const updateActivityDate = defineAction({
  schema: activityDateUpdateSchema,
  input: (formData) => ({
    activityId: formData.get("activityId"),
    occurredOn: formData.get("occurredOn"),
    returnPath: formData.get("returnPath"),
  }),
  handler: async ({ input: parsed, db }) => {
  const existing = await db.query.activities.findFirst({
    where: eq(activities.id, parsed.activityId),
  });

  if (!existing) {
    throw new Error("Activity not found.");
  }

  const occurredAt = mergeDateWithTime(parsed.occurredOn, existing.occurredAt);
  if (!occurredAt) {
    throw new Error("Activity date must be a valid date.");
  }

  await db
    .update(activities)
    .set({
      occurredAt,
    })
    .where(eq(activities.id, parsed.activityId));

  revalidatePath("/activities");
  if (parsed.returnPath?.startsWith("/")) {
    revalidatePath(parsed.returnPath);
  }
  },
});

export const logActivity = defineAction({
  schema: activitySchema,
  input: (formData) => {
    const rawDealId = formData.get("dealId")?.toString();
    const rawContactId = formData.get("contactId")?.toString();
    const rawCompanyId = formData.get("companyId")?.toString();

    return {
      type: formData.get("type"),
      notes: formData.get("notes"),
      dealId: rawDealId ? Number(rawDealId) : undefined,
      contactId: rawContactId ? Number(rawContactId) : undefined,
      companyId: rawCompanyId ? Number(rawCompanyId) : undefined,
      occurredOn: formData.get("occurredOn"),
      returnPath: formData.get("returnPath"),
    };
  },
  handler: async ({ input: parsed, db, session }) => {
  await db.insert(activities).values({
    type: parsed.type,
    notes: parsed.notes,
    loggedByUserId: session.userId,
    dealId: parsed.dealId ?? null,
    contactId: parsed.contactId ?? null,
    companyId: parsed.companyId ?? null,
    occurredAt: mergeDateWithTime(parsed.occurredOn) ?? undefined,
  });

  revalidatePath("/");
  if (parsed.returnPath?.startsWith("/")) {
    revalidatePath(parsed.returnPath);
  }
  await setFlashToast("Activity logged");
  },
});

const enrichSchema = z.object({
  companyId: z.coerce.number().int().positive(),
  returnPath: z.string().optional(),
});

export const enrichCompanyFromWebsite = defineAction({
  schema: enrichSchema,
  input: (formData) => ({
    companyId: formData.get("companyId"),
    returnPath: formData.get("returnPath"),
  }),
  handler: async ({ input: parsed, db, session }) => {
  const company = await db.query.companies.findFirst({
    where: eq(companies.id, parsed.companyId),
  });
  if (!company) {
    throw new Error("Account not found.");
  }
  if (!company.website) {
    await setFlashToast("Add a website first, then enrich.");
    return;
  }

  const result = await scrapeCompanyWebsite(company.website);

  if (!result.ok) {
    await setFlashToast(`Could not scrape site: ${result.error ?? "unknown error"}`);
    if (parsed.returnPath?.startsWith("/")) {
      revalidatePath(parsed.returnPath);
    }
    return;
  }

  // Fill structured fields only when empty — never clobber human-entered data.
  const updates: Partial<typeof companies.$inferInsert> = {};
  if (!company.address && result.address) {
    updates.address = result.address;
  }
  if (!company.industry && result.industryGuess) {
    updates.industry = result.industryGuess;
  }

  // Geocode the address (scraped or already on file) when we don't have
  // coordinates yet, so the proximity / "plaza neighbors" graph can use it.
  const addressToGeocode = updates.address ?? company.address;
  let geocode: Awaited<ReturnType<typeof geocodeAddress>> = null;
  if (addressToGeocode && company.lat == null && company.lng == null) {
    geocode = await geocodeAddress(addressToGeocode);
    if (geocode) {
      updates.lat = geocode.lat;
      updates.lng = geocode.lng;
    }
  }

  if (Object.keys(updates).length > 0) {
    await db.update(companies).set(updates).where(eq(companies.id, company.id));
  }

  // Cache the geocode so we don't re-hit the provider on every render.
  if (geocode) {
    await db
      .insert(placeEnrichment)
      .values({
        companyId: company.id,
        formattedAddress: geocode.formattedAddress,
        lat: geocode.lat,
        lng: geocode.lng,
        provider: geocode.provider,
      })
      .onConflictDoUpdate({
        target: placeEnrichment.companyId,
        set: {
          formattedAddress: geocode.formattedAddress,
          lat: geocode.lat,
          lng: geocode.lng,
          provider: geocode.provider,
        },
      });
  }

  // Log everything we found as an agent-sourced activity so it is auditable
  // and reversible, and the contact details surface for human follow-up.
  const lines: string[] = [`Website enrichment from ${result.fetchedUrl}`];
  if (result.description) lines.push(`About: ${result.description}`);
  if (result.industryGuess) lines.push(`Industry guess: ${result.industryGuess}`);
  if (result.address) lines.push(`Address: ${result.address}`);
  if (geocode) lines.push(`Geocoded (${geocode.provider}): ${geocode.lat.toFixed(5)}, ${geocode.lng.toFixed(5)}`);
  if (result.emails.length) lines.push(`Emails: ${result.emails.join(", ")}`);
  if (result.phones.length) lines.push(`Phones: ${result.phones.join(", ")}`);
  const socialList = Object.values(result.socials).filter(Boolean);
  if (socialList.length) lines.push(`Social: ${socialList.join(", ")}`);
  if (lines.length === 1) lines.push("No structured contact details found on the homepage.");

  await db.insert(activities).values({
    type: "note",
    notes: lines.join("\n"),
    loggedByUserId: session.userId,
    companyId: company.id,
    source: "agent",
  });

  revalidatePath(`/accounts/${company.id}`);
  revalidatePath("/accounts");
  if (parsed.returnPath?.startsWith("/")) {
    revalidatePath(parsed.returnPath);
  }
  await setFlashToast(
    `Enriched from website — ${result.emails.length} email(s), ${result.phones.length} phone(s) found`,
  );
  },
});

// --- Sourcing suggestion queue (nearby-business leads) ---

const suggestionActionSchema = z.object({
  suggestionId: z.coerce.number().int().positive(),
});

// Apply a pending inbox suggestion to core tables. Kind-specific writes live in
// `@/lib/agent/apply-suggestion` so the PM agent API and this button share one path.
export const approveSuggestion = defineAction({
  schema: suggestionActionSchema,
  input: (formData) => ({ suggestionId: formData.get("suggestionId") }),
  handler: async ({ input: { suggestionId }, db }) => {
  const suggestion = await db.query.suggestions.findFirst({
    where: eq(suggestions.id, suggestionId),
  });
  if (!suggestion || suggestion.status !== "pending") {
    await setFlashToast("That suggestion was already handled.");
    revalidatePath("/inbox");
    return;
  }

  try {
    const result = await applySuggestion(db, suggestion);
    await markSuggestionResolved(db, suggestionId, "approved");
    revalidatePath("/inbox");
    revalidatePath("/map");
    for (const path of result.revalidate) {
      revalidatePath(path);
    }
    await setFlashToast(result.message);
  } catch (error) {
    const message =
      error instanceof SuggestionValidationError
        ? error.issues.join(" ")
        : error instanceof Error
          ? error.message
          : "Could not apply suggestion.";
    await setFlashToast(message);
  }
  },
});

// --- Live sourcing: "Find more businesses nearby" from the map ---

const scanSchema = z.object({
  companyId: z.coerce.number().int().positive(),
});

// Adaptive radius: OSM is sparse, so a tight ring often only re-surfaces the
// businesses we already have. Widen until we turn up enough genuinely-new ones.
const SCAN_RADII_M = [300, 1000];
const MIN_NEW_TARGET = 6;
// Cap how many new prospects one scan can queue — a simple budget guard until
// the LLM analyst phase introduces a real token ceiling.
const MAX_NEW_PER_SCAN = 20;
const normName = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export const scanCustomerForReferrals = defineAction({
  schema: scanSchema,
  input: (formData) => ({ companyId: formData.get("companyId") }),
  handler: async ({ input: { companyId }, db }) => {
  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company) {
    throw new Error("Account not found.");
  }
  if (company.lat == null || company.lng == null) {
    await setFlashToast("Geocode this account first (Enrich from website), then scan.");
    return;
  }

  // Audit the run so every sweep is accountable (and budget-guardable later).
  const runRows = await db
    .insert(agentRuns)
    .values({ loop: "sourcing", status: "running", notes: `Find businesses near ${company.name}` })
    .returning({ id: agentRuns.id });
  const runId = runRows[0]?.id;

  // De-dupe sets first, so the adaptive radius can measure how many businesses
  // are genuinely new (not already an account or already in the queue).
  const [companyRows, suggestionRows] = await Promise.all([
    db.select({ name: companies.name }).from(companies),
    db.select({ payload: suggestions.payload, kind: suggestions.kind, status: suggestions.status }).from(suggestions),
  ]);
  const existing = new Set(companyRows.map((c) => normName(c.name)));
  const queued = new Set(
    suggestionRows
      .filter((s) => s.kind === "new_company" && (s.status === "pending" || s.status === "approved"))
      .map((s) => normName(((s.payload ?? {}) as { name?: string }).name ?? ""))
      .filter(Boolean),
  );
  const isFresh = (name: string) => {
    const key = normName(name);
    return !existing.has(key) && !queued.has(key);
  };

  // Widen the radius until we surface enough new businesses (or run out of tiers).
  let raw: Awaited<ReturnType<typeof sourceNearbyBusinesses>> = [];
  let radiusUsed = SCAN_RADII_M[0];
  for (const r of SCAN_RADII_M) {
    radiusUsed = r;
    raw = await sourceNearbyBusinesses(company.lat, company.lng, r);
    if (raw.filter((c) => isFresh(c.name)).length >= MIN_NEW_TARGET) break;
  }

  // Closest first — warmer prospects lead — then cap the batch.
  const fresh = raw
    .filter((c) => isFresh(c.name))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, MAX_NEW_PER_SCAN);

  let inserted = 0;
  for (const c of fresh) {
    const confidence = Math.max(5, Math.min(100, Math.round(100 - (c.distanceMeters / radiusUsed) * 60)));
    await db.insert(suggestions).values({
      kind: "new_company",
      title: `${c.name} — ${c.category} near ${company.name}`,
      payload: {
        name: c.name,
        category: c.category,
        address: c.address,
        lat: c.lat,
        lng: c.lng,
        nearCompanyId: company.id,
        nearCompanyName: company.name,
        distanceMeters: c.distanceMeters,
      },
      confidence,
      evidence: `Found via OpenStreetMap ~${c.distanceMeters}m from ${company.name} (customer)`,
      source: "agent",
      status: "pending",
    });
    inserted++;
  }

  if (runId) {
    await db
      .update(agentRuns)
      .set({
        status: "ok",
        itemsSeen: raw.length,
        itemsProposed: inserted,
        notes: `Find businesses near ${company.name} (radius ${radiusUsed}m)`,
        finishedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));
  }

  revalidatePath("/map");
  revalidatePath("/inbox");
  const message =
    inserted > 0
      ? `Found ${inserted} new business${inserted === 1 ? "" : "es"} near ${company.name}`
      : raw.length > 0
        ? `Every business OpenStreetMap maps near ${company.name} is already in your CRM`
        : `OpenStreetMap has no businesses mapped near ${company.name} yet`;
  await setFlashToast(message);
  },
});

export const dismissSuggestion = defineAction({
  schema: suggestionActionSchema,
  input: (formData) => ({ suggestionId: formData.get("suggestionId") }),
  handler: async ({ input: { suggestionId }, db }) => {
  await db
    .update(suggestions)
    .set({ status: "rejected", resolvedAt: new Date() })
    .where(and(eq(suggestions.id, suggestionId), eq(suggestions.status, "pending")));

  revalidatePath("/inbox");
  revalidatePath("/map");
  await setFlashToast("Suggestion dismissed");
  },
});

export const createRelationship = defineAction({
  schema: relationshipSchema,
  input: (formData) => ({
    fromType: formData.get("fromType"),
    fromId: formData.get("fromId"),
    toType: formData.get("toType"),
    toId: formData.get("toId"),
    edgeType: formData.get("edgeType"),
    strength: formData.get("strength") ?? undefined,
    evidence: formData.get("evidence"),
    returnPath: formData.get("returnPath"),
  }),
  handler: async ({ input: parsed, db }) => {
  if (parsed.fromType === parsed.toType && parsed.fromId === parsed.toId) {
    throw new Error("An entity cannot have a relationship to itself.");
  }

  await db
    .insert(relationships)
    .values({
      fromType: parsed.fromType,
      fromId: parsed.fromId,
      toType: parsed.toType,
      toId: parsed.toId,
      edgeType: parsed.edgeType as (typeof edgeTypeOptions)[number],
      strength: parsed.strength ?? 50,
      evidence: cleanOptionalText(parsed.evidence),
      source: "manual",
    })
    .onConflictDoUpdate({
      target: [
        relationships.fromType,
        relationships.fromId,
        relationships.toType,
        relationships.toId,
        relationships.edgeType,
      ],
      set: {
        strength: parsed.strength ?? 50,
        evidence: cleanOptionalText(parsed.evidence),
        lastConfirmedAt: new Date(),
      },
    });

  if (parsed.returnPath?.startsWith("/")) {
    revalidatePath(parsed.returnPath);
  }
  await setFlashToast("Relationship saved");
  },
});

export const deleteRelationship = defineAction({
  schema: relationshipDeleteSchema,
  input: (formData) => ({
    relationshipId: formData.get("relationshipId"),
    returnPath: formData.get("returnPath"),
  }),
  handler: async ({ input: parsed, db }) => {
  await db.delete(relationships).where(eq(relationships.id, parsed.relationshipId));

  if (parsed.returnPath?.startsWith("/")) {
    revalidatePath(parsed.returnPath);
  }
  await setFlashToast("Relationship removed");
  },
});

// ── Payments ─────────────────────────────────────────────────────────────────

const paymentAssignSchema = z.object({
  paymentId: z.coerce.number().int().positive(),
  companyId: z.coerce.number().int().positive().optional(),
  returnPath: z.string().optional(),
});

/**
 * Attribute a Stripe payment to an account. Because payment-link charges carry
 * no Stripe customer, sibling payments are matched by billing email — so
 * assigning one payment from a payer claims the rest of that payer's
 * unattributed payments too.
 */
export const assignPaymentAccount = defineAction({
  schema: paymentAssignSchema,
  input: (formData) => {
    const rawCompanyId = formData.get("companyId")?.toString();

    return {
      paymentId: formData.get("paymentId"),
      companyId: rawCompanyId ? Number(rawCompanyId) : undefined,
      returnPath: formData.get("returnPath")?.toString() ?? undefined,
    };
  },
  handler: async ({ input: parsed, db }) => {
  const existing = await db.query.payments.findFirst({
    columns: { id: true, billingEmail: true, companyId: true, stripeCustomerId: true },
    where: eq(payments.id, parsed.paymentId),
  });
  if (!existing) {
    throw new Error("Payment not found.");
  }

  const targetCompanyId = parsed.companyId ?? null;
  let alsoUpdated = 0;

  await db
    .update(payments)
    .set({ companyId: targetCompanyId })
    .where(eq(payments.id, parsed.paymentId));

  // Claim this payer's other unattributed payments in the same stroke.
  if (targetCompanyId && existing.billingEmail) {
    const siblings = await db
      .update(payments)
      .set({ companyId: targetCompanyId })
      .where(and(eq(payments.billingEmail, existing.billingEmail), isNull(payments.companyId)))
      .returning({ id: payments.id });
    alsoUpdated = siblings.length;
  }

  // If this payer does have a Stripe customer, remember it on the account so
  // future syncs attribute automatically.
  if (targetCompanyId && existing.stripeCustomerId) {
    await db
      .update(companies)
      .set({ stripeCustomerId: existing.stripeCustomerId })
      .where(eq(companies.id, targetCompanyId));
    await db
      .update(stripeSubscriptions)
      .set({ companyId: targetCompanyId })
      .where(eq(stripeSubscriptions.stripeCustomerId, existing.stripeCustomerId));
  }

  revalidatePath("/payments");
  revalidatePath("/");
  if (targetCompanyId) {
    revalidatePath(`/accounts/${targetCompanyId}`);
  }
  if (existing.companyId) {
    revalidatePath(`/accounts/${existing.companyId}`);
  }
  if (parsed.returnPath?.startsWith("/")) {
    revalidatePath(parsed.returnPath);
  }

  await setFlashToast(
    targetCompanyId
      ? alsoUpdated > 0
        ? `Payment assigned (+${alsoUpdated} more from the same payer)`
        : "Payment assigned"
      : "Payment unassigned",
  );
  },
});

// ── Proposals ────────────────────────────────────────────────────────────────

const proposalStatusSchema = z.enum(["draft", "sent", "viewed", "signed", "declined", "superseded"]);

const proposalCreateSchema = z.object({
  companyId: z.coerce.number().int().positive().optional(),
  newAccountName: z.string().trim().optional(),
  dealId: z.coerce.number().int().positive().optional(),
  autoCreateDeal: z.boolean(),
  contactId: z.coerce.number().int().positive().optional(),
  title: z.string().trim().min(2),
  clientName: z.string().trim().optional(),
  business: z.string().trim().optional(),
  proposalDate: z.string().trim().optional(),
  slug: z.string().trim().optional(),
  pin: z.string().trim().optional(),
  contentMd: z.string().optional(),
  returnPath: z.string().optional(),
});

const proposalUpdateSchema = z.object({
  proposalId: z.coerce.number().int().positive(),
  dealId: z.coerce.number().int().positive().optional(),
  contactId: z.coerce.number().int().positive().optional(),
  title: z.string().trim().min(2),
  clientName: z.string().trim().optional(),
  business: z.string().trim().optional(),
  proposalDate: z.string().trim().optional(),
  pin: z.string().trim().min(3),
  status: proposalStatusSchema,
  contentMd: z.string().optional(),
  returnPath: z.string().optional(),
});

function slugifyProposal(value: string) {
  return value
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function uniqueProposalSlug(db: Db, base: string) {
  const root = slugifyProposal(base) || "proposal";
  let candidate = root;
  for (let i = 2; ; i++) {
    const existing = await db.query.proposals.findFirst({ where: eq(proposals.slug, candidate) });
    if (!existing) {
      return candidate;
    }
    candidate = `${root}_${i}`;
  }
}

export const createProposal = defineAction({
  schema: proposalCreateSchema,
  input: (formData) => {
    const rawDealId = formData.get("dealId")?.toString() ?? "";
    const rawCompanyId = formData.get("companyId")?.toString();
    const rawContactId = formData.get("contactId")?.toString();
    // formData.get() returns null for fields not present in the form; zod
    // .optional() only accepts undefined.
    const opt = (name: string) => formData.get(name)?.toString() ?? undefined;

    return {
      companyId: rawCompanyId ? Number(rawCompanyId) : undefined,
      newAccountName: opt("newAccountName"),
      dealId: rawDealId && rawDealId !== "auto" ? Number(rawDealId) : undefined,
      autoCreateDeal: rawDealId === "auto",
      contactId: rawContactId ? Number(rawContactId) : undefined,
      title: formData.get("title"),
      clientName: opt("clientName"),
      business: opt("business"),
      proposalDate: opt("proposalDate"),
      slug: opt("slug"),
      pin: opt("pin"),
      contentMd: opt("contentMd"),
      returnPath: opt("returnPath"),
    };
  },
  handler: async ({ input: parsed, db }) => {
  // Resolve the account: an explicit new-account name wins (created on the
  // spot, matched case-insensitively first so we never duplicate), otherwise
  // the selected existing account.
  const newAccountName = cleanOptionalText(parsed.newAccountName);
  let company: { id: number; name: string };
  let createdAccount = false;

  if (newAccountName) {
    const existing = await db.query.companies.findFirst({
      where: ilike(companies.name, newAccountName),
    });
    if (existing) {
      company = existing;
    } else {
      const [inserted] = await db
        .insert(companies)
        .values({ name: newAccountName, stage: "in_pipeline" })
        .returning({ id: companies.id, name: companies.name });
      company = inserted;
      createdAccount = true;
    }
  } else {
    if (!parsed.companyId) {
      throw new Error("Select an account or enter a new account name.");
    }
    const existing = await db.query.companies.findFirst({ where: eq(companies.id, parsed.companyId) });
    if (!existing) {
      throw new Error("Account not found.");
    }
    company = existing;
  }

  const business = cleanOptionalText(parsed.business) ?? company.name;
  const slug = await uniqueProposalSlug(db, cleanOptionalText(parsed.slug) ?? business);
  const proposalDate =
    cleanOptionalText(parsed.proposalDate) ??
    new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const contentMd = parsed.contentMd ?? "";

  // Resolve the opportunity: picked one, or auto-create from the proposal
  // (stage "proposal", value pulled from the pricing table when present).
  let dealId: number | null = parsed.dealId ?? null;
  let createdDeal = false;
  if (dealId) {
    const selectedDeal = await db.query.deals.findFirst({
      columns: { id: true, companyId: true },
      where: eq(deals.id, dealId),
    });
    if (!selectedDeal || selectedDeal.companyId !== company.id) {
      throw new Error("Selected opportunity belongs to a different account.");
    }
  }
  if (!dealId && parsed.autoCreateDeal) {
    const totals = parsePricingTotals(contentMd);
    const [insertedDeal] = await db
      .insert(deals)
      .values({
        name: parsed.title,
        stage: "proposal",
        valueCents: totals.mrrCents,
        implementationCostCents: totals.oneTimeCents,
        nextStep: "Follow up on proposal",
        companyId: company.id,
        primaryContactId: parsed.contactId ?? null,
      })
      .returning({ id: deals.id });
    dealId = insertedDeal.id;
    createdDeal = true;
  }

  await db.insert(proposals).values({
    companyId: company.id,
    dealId,
    contactId: parsed.contactId ?? null,
    title: parsed.title,
    slug,
    pin: cleanOptionalText(parsed.pin) ?? generatePin(),
    clientName: cleanOptionalText(parsed.clientName) ?? "",
    business,
    proposalDate,
    contentMd,
  });

  revalidatePath("/proposals");
  revalidatePath("/accounts");
  revalidatePath(`/accounts/${company.id}`);
  revalidatePath("/opportunities");
  if (parsed.returnPath?.startsWith("/")) {
    revalidatePath(parsed.returnPath);
  }
  const extras = [createdAccount ? "account" : null, createdDeal ? "opportunity" : null].filter(Boolean);
  await setFlashToast(extras.length ? `Proposal created (+ new ${extras.join(" & ")})` : "Proposal created");
  },
});

const proposalDealUpdateSchema = z.object({
  proposalId: z.coerce.number().int().positive(),
  dealId: z.coerce.number().int().positive().optional(),
  returnPath: z.string().optional(),
});

// Tie (or untie) a Statement of Work to an opportunity. Used by the dropdown
// in the Agreements panel on account/opportunity pages.
export const updateProposalDeal = defineAction({
  schema: proposalDealUpdateSchema,
  input: (formData) => {
    const rawDealId = formData.get("dealId")?.toString();

    return {
      proposalId: formData.get("proposalId"),
      dealId: rawDealId ? Number(rawDealId) : undefined,
      returnPath: formData.get("returnPath")?.toString() ?? undefined,
    };
  },
  handler: async ({ input: parsed, db }) => {
  const existing = await db.query.proposals.findFirst({
    columns: { id: true, companyId: true, dealId: true },
    where: eq(proposals.id, parsed.proposalId),
  });
  if (!existing) {
    throw new Error("Proposal not found.");
  }

  if (parsed.dealId) {
    const deal = await db.query.deals.findFirst({
      columns: { id: true, companyId: true },
      where: eq(deals.id, parsed.dealId),
    });
    if (!deal) {
      throw new Error("Opportunity not found.");
    }
    if (deal.companyId !== existing.companyId) {
      throw new Error("Opportunity belongs to a different account.");
    }
  }

  await db
    .update(proposals)
    .set({ dealId: parsed.dealId ?? null, updatedAt: new Date() })
    .where(eq(proposals.id, parsed.proposalId));

  revalidatePath("/proposals");
  revalidatePath(`/accounts/${existing.companyId}`);
  for (const affectedDealId of [existing.dealId, parsed.dealId]) {
    if (affectedDealId) {
      revalidatePath(`/opportunities/${affectedDealId}`);
    }
  }
  if (parsed.returnPath?.startsWith("/")) {
    revalidatePath(parsed.returnPath);
  }
  await setFlashToast(parsed.dealId ? "Proposal tied to opportunity" : "Proposal untied from opportunity");
  },
});

const proposalPinUpdateSchema = z.object({
  proposalId: z.coerce.number().int().positive(),
  pin: z
    .string()
    .trim()
    .regex(/^\d{3,6}$/, "PIN must be 3-6 digits."),
  returnPath: z.string().optional(),
});

export const updateProposalPin = defineAction({
  schema: proposalPinUpdateSchema,
  input: (formData) => ({
    proposalId: formData.get("proposalId"),
    pin: formData.get("pin"),
    returnPath: formData.get("returnPath")?.toString() ?? undefined,
  }),
  handler: async ({ input: parsed, db }) => {
  const existing = await db.query.proposals.findFirst({
    columns: { id: true, slug: true },
    where: eq(proposals.id, parsed.proposalId),
  });
  if (!existing) {
    throw new Error("Proposal not found.");
  }

  await db
    .update(proposals)
    .set({ pin: parsed.pin, updatedAt: new Date() })
    .where(eq(proposals.id, parsed.proposalId));

  revalidatePath("/proposals");
  revalidatePath(`/proposals/${parsed.proposalId}`);
  revalidatePath(`/p/${existing.slug}`);
  if (parsed.returnPath?.startsWith("/")) {
    revalidatePath(parsed.returnPath);
  }
  await setFlashToast("PIN updated");
  },
});

export const updateProposal = defineAction({
  schema: proposalUpdateSchema,
  input: (formData) => {
    const rawDealId = formData.get("dealId")?.toString();
    const rawContactId = formData.get("contactId")?.toString();
    const opt = (name: string) => formData.get(name)?.toString() ?? undefined;

    return {
      proposalId: formData.get("proposalId"),
      dealId: rawDealId ? Number(rawDealId) : undefined,
      contactId: rawContactId ? Number(rawContactId) : undefined,
      title: formData.get("title"),
      clientName: opt("clientName"),
      business: opt("business"),
      proposalDate: opt("proposalDate"),
      pin: formData.get("pin"),
      status: formData.get("status"),
      contentMd: opt("contentMd"),
      returnPath: opt("returnPath"),
    };
  },
  handler: async ({ input: parsed, db }) => {
  const existing = await db.query.proposals.findFirst({
    columns: { id: true, slug: true, business: true, proposalDate: true, contentMd: true, sentAt: true },
    where: eq(proposals.id, parsed.proposalId),
  });
  if (!existing) {
    throw new Error("Proposal not found.");
  }

  await db
    .update(proposals)
    .set({
      dealId: parsed.dealId ?? null,
      contactId: parsed.contactId ?? null,
      title: parsed.title,
      clientName: cleanOptionalText(parsed.clientName) ?? "",
      business: cleanOptionalText(parsed.business) ?? existing.business,
      proposalDate: cleanOptionalText(parsed.proposalDate) ?? existing.proposalDate,
      pin: parsed.pin,
      status: parsed.status,
      contentMd: parsed.contentMd ?? existing.contentMd,
      sentAt: parsed.status !== "draft" && !existing.sentAt ? new Date() : existing.sentAt,
      updatedAt: new Date(),
    })
    .where(eq(proposals.id, parsed.proposalId));

  // If the linked opportunity has never had a value set, fill it from the
  // proposal's pricing table (never overwrites manually-entered numbers).
  const linkedDealId = parsed.dealId ?? null;
  if (linkedDealId && parsed.contentMd) {
    const totals = parsePricingTotals(parsed.contentMd);
    if (totals.mrrCents || totals.oneTimeCents) {
      const deal = await db.query.deals.findFirst({
        columns: { id: true, valueCents: true, implementationCostCents: true },
        where: eq(deals.id, linkedDealId),
      });
      if (deal && deal.valueCents === 0 && deal.implementationCostCents === 0) {
        await db
          .update(deals)
          .set({ valueCents: totals.mrrCents, implementationCostCents: totals.oneTimeCents })
          .where(eq(deals.id, linkedDealId));
        revalidatePath(`/opportunities/${linkedDealId}`);
      }
    }
  }

  revalidatePath("/proposals");
  revalidatePath(`/proposals/${parsed.proposalId}`);
  revalidatePath(`/p/${existing.slug}`);
  if (parsed.returnPath?.startsWith("/")) {
    revalidatePath(parsed.returnPath);
  }
  await setFlashToast("Proposal saved");
  },
});
