import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clientIp,
  isThrottled,
  MAX_FAILURES_PER_IP,
  MAX_FAILURES_PER_USERNAME,
} from "@/lib/login-throttle";

describe("isThrottled", () => {
  it("allows attempts under both limits", () => {
    assert.equal(isThrottled({ usernameFailures: 0, ipFailures: 0 }), false);
    assert.equal(
      isThrottled({ usernameFailures: MAX_FAILURES_PER_USERNAME - 1, ipFailures: MAX_FAILURES_PER_IP - 1 }),
      false,
    );
  });

  it("locks a username after five failures", () => {
    assert.equal(MAX_FAILURES_PER_USERNAME, 5);
    assert.equal(isThrottled({ usernameFailures: 5, ipFailures: 0 }), true);
  });

  it("locks an IP spraying many usernames", () => {
    assert.equal(MAX_FAILURES_PER_IP, 20);
    assert.equal(isThrottled({ usernameFailures: 0, ipFailures: 20 }), true);
  });
});

describe("clientIp", () => {
  it("takes the first x-forwarded-for hop", () => {
    assert.equal(clientIp("203.0.113.7, 10.0.0.1", null), "203.0.113.7");
  });

  it("falls back to x-real-ip, then a fixed bucket", () => {
    assert.equal(clientIp(null, "198.51.100.2"), "198.51.100.2");
    assert.equal(clientIp("", null), "unknown");
    assert.equal(clientIp(null, null), "unknown");
  });
});
