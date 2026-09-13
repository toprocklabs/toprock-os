import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorizeAgentToken,
  extractBearerToken,
  getAgentTokenIssue,
  tokensEqual,
} from "@/lib/agent/auth";

const VALID_TOKEN = "a".repeat(32);
const OTHER_TOKEN = "b".repeat(32);

describe("extractBearerToken", () => {
  it("reads a Bearer token", () => {
    assert.equal(extractBearerToken("Bearer secret-token"), "secret-token");
    assert.equal(extractBearerToken("bearer secret-token"), "secret-token");
  });

  it("rejects missing or non-bearer headers", () => {
    assert.equal(extractBearerToken(null), null);
    assert.equal(extractBearerToken(""), null);
    assert.equal(extractBearerToken("Basic abc"), null);
    assert.equal(extractBearerToken("Bearer"), null);
  });
});

describe("tokensEqual", () => {
  it("accepts matching tokens", () => {
    assert.equal(tokensEqual(VALID_TOKEN, VALID_TOKEN), true);
  });

  it("rejects mismatches and length differences", () => {
    assert.equal(tokensEqual(VALID_TOKEN, OTHER_TOKEN), false);
    assert.equal(tokensEqual("short", VALID_TOKEN), false);
  });
});

describe("authorizeAgentToken", () => {
  it("returns 503 when the server token is missing", () => {
    const result = authorizeAgentToken("Bearer anything", {});
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 503);
      assert.match(result.error, /CRM_AGENT_TOKEN is not set/);
    }
  });

  it("returns 503 when the server token is too short", () => {
    const result = authorizeAgentToken("Bearer short", { CRM_AGENT_TOKEN: "too-short" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 503);
    }
  });

  it("returns 401 when the Authorization header is missing", () => {
    const result = authorizeAgentToken(null, { CRM_AGENT_TOKEN: VALID_TOKEN });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 401);
    }
  });

  it("returns 401 for the wrong bearer token", () => {
    const result = authorizeAgentToken(`Bearer ${OTHER_TOKEN}`, { CRM_AGENT_TOKEN: VALID_TOKEN });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 401);
      assert.match(result.error, /invalid agent token/);
    }
  });

  it("accepts the configured bearer token", () => {
    const result = authorizeAgentToken(`Bearer ${VALID_TOKEN}`, { CRM_AGENT_TOKEN: VALID_TOKEN });
    assert.equal(result.ok, true);
  });
});

describe("getAgentTokenIssue", () => {
  it("describes configuration problems without leaking the token", () => {
    assert.equal(getAgentTokenIssue({}), "CRM_AGENT_TOKEN is not set.");
    assert.match(getAgentTokenIssue({ CRM_AGENT_TOKEN: "abc" }) ?? "", /at least 32/);
    assert.equal(getAgentTokenIssue({ CRM_AGENT_TOKEN: VALID_TOKEN }), null);
  });
});
