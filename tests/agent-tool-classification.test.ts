import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MCP_TOOLS } from "@/lib/agent/catalog";
import { READ_ONLY_TOOLS } from "@/lib/agent/tools";

// The read/write split decides which database connection a tool runs on
// (planning/008-agent-mcp-hardening). Read tools go through a Neon role granted
// nothing but SELECT; everything else uses the read/write connection and is
// gated by the /inbox approval queue.
//
// These tests exist so that adding a tool forces a deliberate decision about
// which side it belongs on, instead of inheriting one by accident.

/** The only tools allowed to mutate anything. Both land in /inbox for approval. */
const WRITE_TOOLS = ["propose_suggestion", "sync_project_repos"];

const catalogNames = MCP_TOOLS.map((tool) => tool.name);

describe("agent tool classification", () => {
  it("classifies every advertised tool as either read-only or write", () => {
    const unclassified = catalogNames.filter(
      (name) => !READ_ONLY_TOOLS.has(name) && !WRITE_TOOLS.includes(name),
    );

    assert.deepEqual(
      unclassified,
      [],
      `unclassified tool(s): ${unclassified.join(", ")}. Add to READ_ONLY_TOOLS in ` +
        "src/lib/agent/tools.ts, or to WRITE_TOOLS here if it mutates.",
    );
  });

  it("never marks a write tool as read-only", () => {
    for (const name of WRITE_TOOLS) {
      assert.equal(
        READ_ONLY_TOOLS.has(name),
        false,
        `${name} mutates and must not run on the SELECT-only connection`,
      );
    }
  });

  it("does not list a read-only tool that no longer exists", () => {
    for (const name of READ_ONLY_TOOLS) {
      assert.ok(
        catalogNames.includes(name),
        `READ_ONLY_TOOLS contains "${name}", which is not in the advertised catalog`,
      );
    }
  });

  it("keeps the write surface to exactly two tools", () => {
    // A third write tool is a real decision, not a refactor: it needs its own
    // review of what it can reach and whether /inbox still gates it.
    const writable = catalogNames.filter((name) => !READ_ONLY_TOOLS.has(name));
    assert.deepEqual(writable.sort(), [...WRITE_TOOLS].sort());
  });
});
