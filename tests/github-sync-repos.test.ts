import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapGitHubRepo, planRepoSync } from "@/lib/github/sync-repos";

describe("mapGitHubRepo", () => {
  it("maps a GitHub org listing row", () => {
    const mapped = mapGitHubRepo({
      full_name: "toprocklabs/scuba-dive-riverton",
      private: true,
      archived: false,
      html_url: "https://github.com/toprocklabs/scuba-dive-riverton",
      pushed_at: "2026-09-01T12:00:00Z",
    });

    assert.ok(mapped);
    assert.equal(mapped.fullName, "toprocklabs/scuba-dive-riverton");
    assert.equal(mapped.isPrivate, true);
    assert.equal(mapped.archived, false);
    assert.equal(mapped.lastPushAt?.toISOString(), "2026-09-01T12:00:00.000Z");
  });

  it("skips rows without a full_name", () => {
    assert.equal(mapGitHubRepo({ private: true }), null);
  });
});

describe("planRepoSync", () => {
  it("upserts every fetched repo and archives vanished ones", () => {
    const plan = planRepoSync(
      [
        { fullName: "toprocklabs/old-client", archived: false },
        { fullName: "toprocklabs/already-gone", archived: true },
        { fullName: "toprocklabs/kept", archived: false },
      ],
      [
        {
          fullName: "toprocklabs/kept",
          isPrivate: true,
          archived: false,
          htmlUrl: "https://github.com/toprocklabs/kept",
          lastPushAt: null,
        },
        {
          fullName: "toprocklabs/new-client",
          isPrivate: true,
          archived: false,
          htmlUrl: "https://github.com/toprocklabs/new-client",
          lastPushAt: null,
        },
      ],
    );

    assert.deepEqual(
      plan.upserts.map((repo) => repo.fullName),
      ["toprocklabs/kept", "toprocklabs/new-client"],
    );
    assert.deepEqual(plan.archive, ["toprocklabs/old-client"]);
  });
});
