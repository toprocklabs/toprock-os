import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLockedDown, isPubliclyAllowed } from "@/lib/public-surface";

describe("isPubliclyAllowed", () => {
  it("allows the agent's MCP endpoint", () => {
    assert.equal(isPubliclyAllowed("/api/mcp"), true);
  });

  it("allows client-facing proposal paths", () => {
    for (const path of [
      "/p/acme-retainer",
      "/p/acme-retainer/terms",
      "/p/acme-retainer/sign",
    ]) {
      assert.equal(isPubliclyAllowed(path), true, path);
    }
  });

  it("allows the static assets a proposal page needs to render", () => {
    for (const path of [
      "/_next/static/css/abc123.css",
      "/_next/static/chunks/app/p/%5Bslug%5D/page-1.js",
      "/_next/image?url=%2Flogo.png",
      "/favicon.ico",
    ]) {
      assert.equal(isPubliclyAllowed(path), true, path);
    }
  });

  it("blocks every CRM page, including the login form", () => {
    for (const path of [
      "/",
      "/login",
      "/accounts",
      "/accounts/12",
      "/contacts",
      "/opportunities/3",
      "/tasks",
      "/activities",
      "/inbox",
      "/map",
      "/payments",
      "/proposals",
      "/proposals/8",
      "/proposals/8/pdf",
      "/customers",
    ]) {
      assert.equal(isPubliclyAllowed(path), false, path);
    }
  });

  it("does not let /proposals slip through the /p/ prefix", () => {
    // The classic prefix bug: startsWith("/p") would open the entire proposals
    // admin, signed PDFs included.
    assert.equal(isPubliclyAllowed("/proposals"), false);
    assert.equal(isPubliclyAllowed("/payments"), false);
    assert.equal(isPubliclyAllowed("/p"), false);
  });

  it("blocks unknown and probing paths by default", () => {
    for (const path of ["/api", "/api/health", "/api/mcp/extra", "/admin", "/.env", "/wp-login.php"]) {
      assert.equal(isPubliclyAllowed(path), false, path);
    }
  });
});

describe("isLockedDown", () => {
  it("leaves local development wide open with no configuration", () => {
    assert.equal(isLockedDown({ NODE_ENV: "development" }), false);
    assert.equal(isLockedDown({}), false);
  });

  it("locks any production build, Vercel or not", () => {
    assert.equal(isLockedDown({ NODE_ENV: "production" }), true);
    assert.equal(isLockedDown({ NODE_ENV: "production", VERCEL: undefined }), true);
  });

  it("opens only for the explicit opt-out", () => {
    assert.equal(isLockedDown({ NODE_ENV: "production", CRM_PUBLIC_SURFACE: "all" }), false);
    // Anything other than the exact value keeps the wall up.
    for (const value of ["true", "1", "ALL", "yes", ""]) {
      assert.equal(
        isLockedDown({ NODE_ENV: "production", CRM_PUBLIC_SURFACE: value }),
        true,
        value,
      );
    }
  });
});
