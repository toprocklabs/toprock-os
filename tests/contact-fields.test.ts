import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { optionalBlankTextSchema, optionalContactUrlSchema } from "@/lib/contact-fields";

describe("optional contact field schemas", () => {
  it("treats null, undefined, and blank text as empty", () => {
    assert.equal(optionalBlankTextSchema.parse(null), null);
    assert.equal(optionalBlankTextSchema.parse(undefined), undefined);
    assert.equal(optionalBlankTextSchema.parse(""), "");
    assert.equal(optionalBlankTextSchema.parse("  Owner  "), "Owner");
  });

  it("accepts null and blank LinkedIn URLs and validates a real one", () => {
    assert.equal(optionalContactUrlSchema.parse(null), null);
    assert.equal(optionalContactUrlSchema.parse(undefined), null);
    assert.equal(optionalContactUrlSchema.parse(""), null);
    assert.equal(optionalContactUrlSchema.parse("   "), null);
    assert.equal(
      optionalContactUrlSchema.parse("https://www.linkedin.com/in/dana"),
      "https://www.linkedin.com/in/dana",
    );
    assert.equal(optionalContactUrlSchema.parse("linkedin.com/in/dana"), "https://linkedin.com/in/dana");
  });

  it("rejects a LinkedIn placeholder", () => {
    assert.throws(() => optionalContactUrlSchema.parse("none"), /Invalid URL/);
    assert.throws(() => optionalContactUrlSchema.parse("https://none"), /Invalid URL/);
  });
});
