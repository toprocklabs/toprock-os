import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanOptionalText,
  mergeDateWithTime,
  normalizeContactUrl,
  normalizeUrl,
  normalizeUsPhone,
} from "@/lib/normalize";

describe("cleanOptionalText", () => {
  it("returns null for empty and whitespace-only input", () => {
    assert.equal(cleanOptionalText(undefined), null);
    assert.equal(cleanOptionalText(null), null);
    assert.equal(cleanOptionalText(""), null);
    assert.equal(cleanOptionalText("   "), null);
    assert.equal(cleanOptionalText("\n\t "), null);
  });

  it("trims surrounding whitespace", () => {
    assert.equal(cleanOptionalText("  Riverton Chiro  "), "Riverton Chiro");
  });

  it("preserves interior whitespace", () => {
    assert.equal(cleanOptionalText(" Surf  n  Sport "), "Surf  n  Sport");
  });
});

describe("normalizeUrl", () => {
  it("returns null for empty input", () => {
    assert.equal(normalizeUrl(null), null);
    assert.equal(normalizeUrl(""), null);
  });

  it("leaves an explicit scheme untouched", () => {
    assert.equal(normalizeUrl("https://toprock.dev"), "https://toprock.dev");
    assert.equal(normalizeUrl("http://legacy.example"), "http://legacy.example");
  });

  it("prefixes https:// when no scheme is present", () => {
    assert.equal(normalizeUrl("toprock.dev"), "https://toprock.dev");
    assert.equal(normalizeUrl("www.toprock.dev/x?y=1"), "https://www.toprock.dev/x?y=1");
  });

  // Documents current behaviour: the check is a literal prefix test, so other
  // schemes get an https:// glued in front rather than being rejected.
  it("does not recognize schemes other than http/https", () => {
    assert.equal(normalizeUrl("ftp://files.example"), "https://ftp://files.example");
  });
});

describe("normalizeContactUrl", () => {
  it("stores null, undefined, and blank as null", () => {
    assert.equal(normalizeContactUrl(null), null);
    assert.equal(normalizeContactUrl(undefined), null);
    assert.equal(normalizeContactUrl(""), null);
    assert.equal(normalizeContactUrl("   "), null);
  });

  it("keeps a real http(s) URL and prefixes a schemeless host", () => {
    assert.equal(
      normalizeContactUrl("https://www.linkedin.com/in/dana"),
      "https://www.linkedin.com/in/dana",
    );
    assert.equal(normalizeContactUrl("http://legacy.example/in/dana"), "http://legacy.example/in/dana");
    assert.equal(normalizeContactUrl("linkedin.com/in/dana"), "https://linkedin.com/in/dana");
    assert.equal(
      normalizeContactUrl("  www.linkedin.com/in/dana?trk=1  "),
      "https://www.linkedin.com/in/dana?trk=1",
    );
  });

  it("rejects placeholders and other non-URLs instead of prefixing https://", () => {
    assert.throws(() => normalizeContactUrl("none"), /Invalid URL/);
    assert.throws(() => normalizeContactUrl("https://none"), /Invalid URL/);
    assert.throws(() => normalizeContactUrl("not a url"), /Invalid URL/);
    assert.throws(() => normalizeContactUrl("ftp://files.example/in/dana"), /Invalid URL/);
  });
});

describe("normalizeUsPhone", () => {
  it("returns null for empty input", () => {
    assert.equal(normalizeUsPhone(undefined), null);
    assert.equal(normalizeUsPhone(null), null);
    assert.equal(normalizeUsPhone(""), null);
    assert.equal(normalizeUsPhone("   "), null);
  });

  it("formats ten digits regardless of input punctuation", () => {
    const expected = "(801) 555-0123";
    assert.equal(normalizeUsPhone("8015550123"), expected);
    assert.equal(normalizeUsPhone("801-555-0123"), expected);
    assert.equal(normalizeUsPhone("(801) 555-0123"), expected);
    assert.equal(normalizeUsPhone("801.555.0123"), expected);
    assert.equal(normalizeUsPhone(" 801 555 0123 "), expected);
  });

  it("strips a leading US country code", () => {
    assert.equal(normalizeUsPhone("18015550123"), "(801) 555-0123");
    assert.equal(normalizeUsPhone("+1 (801) 555-0123"), "(801) 555-0123");
  });

  it("throws on anything that isn't ten US digits", () => {
    assert.throws(() => normalizeUsPhone("555-0123"), /10 digits/);
    assert.throws(() => normalizeUsPhone("+44 20 7946 0958"), /10 digits/);
    // 11 digits not starting with 1 is not a US country code.
    assert.throws(() => normalizeUsPhone("28015550123"), /10 digits/);
  });
});

describe("mergeDateWithTime", () => {
  it("returns null for empty input", () => {
    assert.equal(mergeDateWithTime(undefined), null);
    assert.equal(mergeDateWithTime("  "), null);
  });

  it("grafts the base date's time-of-day onto the given calendar date", () => {
    const base = new Date(Date.UTC(2026, 7, 2, 14, 30, 15, 250));
    const merged = mergeDateWithTime("2026-04-11", base);

    assert.ok(merged);
    assert.equal(merged.toISOString(), "2026-04-11T14:30:15.250Z");
  });

  it("throws on a malformed date", () => {
    assert.throws(() => mergeDateWithTime("not-a-date"), /valid date/);
    assert.throws(() => mergeDateWithTime("2026-00-11"), /valid date/);
  });
});
