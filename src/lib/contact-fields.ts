import { z } from "zod";
import { normalizeContactUrl } from "@/lib/normalize";

// Shared by the contact form and `new_contact` suggestions. `.optional()`
// alone rejects JSON `null`, which is what the MCP client sends for an
// omitted field. Null, undefined, and blank all mean "no value".
export const optionalBlankTextSchema = z.string().trim().nullish();

export const optionalContactUrlSchema = optionalBlankTextSchema.transform((value, ctx) => {
  try {
    return normalizeContactUrl(value);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid URL",
    });
    return z.NEVER;
  }
});
