import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldAutoApply } from "@/lib/agent/policy";
import {
  buildSuggestionInsert,
  parseProposeSuggestion,
  SuggestionValidationError,
} from "@/lib/agent/suggestion-kinds";

describe("parseProposeSuggestion", () => {
  it("accepts a log_activity proposal", () => {
    const parsed = parseProposeSuggestion({
      kind: "log_activity",
      title: "Logged intro call with Scuba Dive Utah",
      evidence: "Granola transcript 2026-09-12: 20-minute call with Dana.",
      confidence: 88,
      payload: {
        type: "call",
        notes: "Discussed Q4 site refresh. They will send brand files.",
        companyId: 4,
      },
    });

    assert.equal(parsed.kind, "log_activity");
    assert.equal(parsed.payload.type, "call");
    assert.equal(parsed.payload.companyId, 4);
  });

  it("accepts a new_contact proposal and normalizes phone", () => {
    const parsed = parseProposeSuggestion({
      kind: "new_contact",
      title: "Add Dana as primary contact",
      evidence: "She introduced herself on the 2026-09-12 call.",
      confidence: 80,
      payload: {
        firstName: "Dana",
        lastName: "Miles",
        email: "dana@example.com",
        phone: "8015550123",
        companyId: 4,
      },
    });

    assert.equal(parsed.payload.phone, "(801) 555-0123");
    assert.equal(parsed.payload.email, "dana@example.com");
  });

  it("requires an attachment target on log_activity", () => {
    assert.throws(
      () =>
        parseProposeSuggestion({
          kind: "log_activity",
          title: "Orphan note",
          evidence: "Heard something in a meeting.",
          confidence: 40,
          payload: { type: "note", notes: "No record attached" },
        }),
      (error: unknown) => {
        assert.ok(error instanceof SuggestionValidationError);
        assert.match(error.issues.join(" "), /account, contact, or opportunity/);
        return true;
      },
    );
  });

  it("rejects a self-edge", () => {
    assert.throws(
      () =>
        parseProposeSuggestion({
          kind: "new_edge",
          title: "Invalid loop",
          evidence: "Should not link an account to itself.",
          confidence: 10,
          payload: {
            fromType: "company",
            fromId: 1,
            toType: "company",
            toId: 1,
            edgeType: "knows",
          },
        }),
      SuggestionValidationError,
    );
  });

  it("rejects invented deal values without a cited number", () => {
    assert.throws(
      () =>
        parseProposeSuggestion({
          kind: "new_deal",
          title: "Guess at MRR",
          evidence: "They seemed interested in a rebuild.",
          confidence: 40,
          payload: {
            name: "Website rebuild",
            companyId: 4,
            valueCents: 240000,
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof SuggestionValidationError);
        assert.match(error.issues.join(" "), /Do not invent/);
        return true;
      },
    );
  });

  it("allows deal values when evidence cites a number", () => {
    const parsed = parseProposeSuggestion({
      kind: "update_deal",
      title: "Set MRR from signed SOW",
      evidence: "Signed SOW 2026-04-11 lists $2,400/mo maintenance.",
      confidence: 92,
      payload: {
        dealId: 9,
        fields: { valueCents: 240000 },
      },
    });

    assert.equal(parsed.payload.fields.valueCents, 240000);
  });

  it("requires a reason on stage_change", () => {
    assert.throws(
      () =>
        parseProposeSuggestion({
          kind: "stage_change",
          title: "Move to customer",
          evidence: "short",
          confidence: 50,
          payload: { target: "account", id: 1, stage: "customer", reason: "won" },
        }),
      SuggestionValidationError,
    );
  });

  it("rejects an unknown kind", () => {
    assert.throws(
      () =>
        parseProposeSuggestion({
          kind: "delete_account",
          title: "Not a real kind",
          evidence: "Should never be accepted by the parser.",
          confidence: 10,
          payload: {},
        }),
      SuggestionValidationError,
    );
  });
});

describe("buildSuggestionInsert", () => {
  it("builds a pending agent-sourced row", () => {
    const parsed = parseProposeSuggestion({
      kind: "update_account",
      title: "Set next step after standup",
      evidence: "Austin asked for a follow-up email by Friday.",
      confidence: 70,
      payload: {
        companyId: 3,
        fields: { nextStep: "Send follow-up email", nextStepDueDate: "2026-09-18" },
      },
    });

    const row = buildSuggestionInsert(parsed, 42);
    assert.deepEqual(row, {
      kind: "update_account",
      title: "Set next step after standup",
      payload: parsed.payload,
      confidence: 70,
      evidence: "Austin asked for a follow-up email by Friday.",
      source: "agent",
      status: "pending",
      autoApplied: false,
      agentRunId: 42,
    });
  });
});

describe("shouldAutoApply", () => {
  it("is off by default", () => {
    assert.equal(
      shouldAutoApply({ kind: "log_activity", confidence: 99 }, {}),
      false,
    );
  });

  it("can apply high-confidence log_activity when explicitly enabled", () => {
    assert.equal(
      shouldAutoApply(
        { kind: "log_activity", confidence: 96 },
        { CRM_AGENT_AUTO_APPLY: "true" },
      ),
      true,
    );
  });

  it("stays off when CRM_AGENT_AUTO_APPLY is false even if kinds are listed", () => {
    const env = {
      CRM_AGENT_AUTO_APPLY: "false",
      CRM_AGENT_AUTO_APPLY_KINDS: "stage_change",
    };
    assert.equal(shouldAutoApply({ kind: "stage_change", confidence: 95 }, env), false);
  });

  it("auto-applies high-confidence stage_change when enabled and listed", () => {
    assert.equal(
      shouldAutoApply(
        { kind: "stage_change", confidence: 95 },
        {
          CRM_AGENT_AUTO_APPLY: "true",
          CRM_AGENT_AUTO_APPLY_KINDS: "stage_change",
        },
      ),
      true,
    );
  });

  it("auto-applies listed stage/deal/account kinds at sufficient confidence", () => {
    const env = {
      CRM_AGENT_AUTO_APPLY: "true",
      CRM_AGENT_AUTO_APPLY_KINDS: "stage_change,new_deal,update_deal,update_account",
    };
    assert.equal(shouldAutoApply({ kind: "stage_change", confidence: 95 }, env), true);
    assert.equal(shouldAutoApply({ kind: "new_deal", confidence: 95 }, env), true);
    assert.equal(shouldAutoApply({ kind: "update_deal", confidence: 100 }, env), true);
    assert.equal(shouldAutoApply({ kind: "update_account", confidence: 95 }, env), true);
  });

  it("does not auto-apply a kind that is not in the allowlist", () => {
    assert.equal(
      shouldAutoApply(
        { kind: "update_deal", confidence: 100 },
        { CRM_AGENT_AUTO_APPLY: "true", CRM_AGENT_AUTO_APPLY_KINDS: "stage_change" },
      ),
      false,
    );
  });

  it("does not auto-apply below the confidence floor", () => {
    assert.equal(
      shouldAutoApply(
        { kind: "stage_change", confidence: 94 },
        { CRM_AGENT_AUTO_APPLY: "true", CRM_AGENT_AUTO_APPLY_KINDS: "stage_change" },
      ),
      false,
    );
  });
});
