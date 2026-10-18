import { z } from "zod";

// z.record strips __proto__; metadata keys are literal user data, not properties to merge.
export const metadataPairs = z.custom<Record<string, string>>(
  (value) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length <= 16 &&
    Object.entries(value).every(
      ([key, item]) => key.length <= 64 && typeof item === "string" && item.length <= 512,
    ),
);
