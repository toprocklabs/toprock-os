import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyPath, safeNextPath, surfaceMode } from "@/lib/public-surface";

describe("classifyPath", () => {
  it("keeps the agent's endpoints public", () => {
    for (const path of ["/api/mcp", "/api/agent/health", "/api/agent/sync-repos"]) {
      assert.equal(classifyPath(path), "public", path);
    }
  });

  it("keeps client-facing proposal paths public", () => {
    for (const path of ["/p/acme-retainer", "/p/acme-retainer/terms", "/p/acme-retainer/sign"]) {
      assert.equal(classifyPath(path), "public", path);
    }
  });

  it("keeps the static assets a proposal page needs public", () => {
    for (const path of [
      "/_next/static/css/abc123.css",
      "/_next/static/chunks/app/p/%5Bslug%5D/page-1.js",
      "/_next/image?url=%2Flogo.png",
      "/favicon.ico",
      "/robots.txt",
    ]) {
      assert.equal(classifyPath(path), "public", path);
    }
  });

  it("gives the sign-in form its own tier", () => {
    assert.equal(classifyPath("/login"), "login");
    assert.equal(classifyPath("/login/extra"), "private");
  });

  it("puts every CRM page behind a session, signed PDFs included", () => {
    for (const path of [
      "/",
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
      assert.equal(classifyPath(path), "private", path);
    }
  });

  it("does not let /proposals slip through the /p/ prefix", () => {
    // The classic prefix bug: startsWith("/p") would open the entire proposals
    // admin, signed PDFs included.
    assert.equal(classifyPath("/proposals"), "private");
    assert.equal(classifyPath("/payments"), "private");
    assert.equal(classifyPath("/p"), "private");
  });

  it("treats unknown and probing paths as private by default", () => {
    for (const path of ["/api", "/api/health", "/api/mcp/extra", "/admin", "/.env", "/wp-login.php"]) {
      assert.equal(classifyPath(path), "private", path);
    }
  });
});

describe("surfaceMode", () => {
  it("leaves local development open with no configuration", () => {
    assert.equal(surfaceMode({ NODE_ENV: "development" }), "open");
    assert.equal(surfaceMode({}), "open");
  });

  it("locks any production build by default, Vercel or not", () => {
    assert.equal(surfaceMode({ NODE_ENV: "production" }), "locked");
    assert.equal(surfaceMode({ NODE_ENV: "production", VERCEL: undefined }), "locked");
  });

  it("gates behind login only for the exact opt-in", () => {
    assert.equal(surfaceMode({ NODE_ENV: "production", CRM_WEB_UI: "on" }), "gated");
    for (const value of ["true", "1", "ON", "yes", ""]) {
      assert.equal(surfaceMode({ NODE_ENV: "production", CRM_WEB_UI: value }), "locked", value);
    }
  });

  it("ignores the retired all-open switch", () => {
    assert.equal(surfaceMode({ NODE_ENV: "production", CRM_PUBLIC_SURFACE: "all" }), "locked");
  });
});

describe("safeNextPath", () => {
  it("keeps same-origin paths with their query", () => {
    assert.equal(safeNextPath("/accounts"), "/accounts");
    assert.equal(safeNextPath("/accounts/12?tab=notes"), "/accounts/12?tab=notes");
  });

  it("rejects anything that could leave the site", () => {
    for (const value of [
      "//evil.com",
      "/\\evil.com",
      "https://evil.com",
      "javascript:alert(1)",
      "evil.com",
      "/acc\\ounts",
      "/accounts\nSet-Cookie:x",
      "",
      null,
      undefined,
      42,
    ]) {
      assert.equal(safeNextPath(value), null, String(value));
    }
  });

  it("does not bounce back to the login form", () => {
    assert.equal(safeNextPath("/login"), null);
    assert.equal(safeNextPath("/login?error=invalid"), null);
  });
});
