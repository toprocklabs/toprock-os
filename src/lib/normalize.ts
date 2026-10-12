// Pure input-normalization helpers shared by the server actions.
//
// These lived as module-private functions inside `src/app/actions.ts`. That
// file carries the "use server" directive, so nothing non-async can be imported
// out of it and the helpers were untestable. Extracted here unchanged —
// behaviour is identical, only the location moved.

export function cleanOptionalText(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function normalizeUrl(value: string | null) {
  if (!value) {
    return null;
  }

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  return `https://${value}`;
}

// A LinkedIn (or other profile) URL. Blank input is "no URL". Anything else
// must be a real http(s) address with a dotted host, so a placeholder like
// "none" is rejected instead of being stored as "https://none".
export function normalizeContactUrl(value: string | null | undefined) {
  const normalized = normalizeUrl(cleanOptionalText(value));
  if (!normalized) {
    return null;
  }

  if (!isRealHttpUrl(normalized)) {
    throw new Error("Invalid URL");
  }

  return normalized;
}

function isRealHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.includes(".");
  } catch {
    return false;
  }
}

// US-only by design (see AGENTS.md tech debt). Throws rather than silently
// storing an unformatted number, so a bad paste surfaces at write time.
export function normalizeUsPhone(value: string | null | undefined) {
  const cleaned = cleanOptionalText(value);
  if (!cleaned) {
    return null;
  }

  const digits = cleaned.replace(/\D/g, "");
  const tenDigits = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;

  if (!/^\d{10}$/.test(tenDigits)) {
    throw new Error("Phone number must have 10 digits (US format).");
  }

  return `(${tenDigits.slice(0, 3)}) ${tenDigits.slice(3, 6)}-${tenDigits.slice(6)}`;
}

// Takes a `YYYY-MM-DD` date and grafts the time-of-day from `baseDate` onto it,
// so a back-dated activity still sorts sensibly against same-day entries.
// `baseDate` is a parameter (not a bare `new Date()`) purely so this is testable.
export function mergeDateWithTime(dateValue: string | undefined, baseDate: Date | null = new Date()) {
  const cleaned = cleanOptionalText(dateValue);

  if (!cleaned) {
    return null;
  }

  const resolvedBaseDate = baseDate ?? new Date();

  const [year, month, day] = cleaned.split("-").map(Number);

  if (!year || !month || !day) {
    throw new Error("Activity date must be a valid date.");
  }

  return new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      resolvedBaseDate.getUTCHours(),
      resolvedBaseDate.getUTCMinutes(),
      resolvedBaseDate.getUTCSeconds(),
      resolvedBaseDate.getUTCMilliseconds(),
    ),
  );
}
