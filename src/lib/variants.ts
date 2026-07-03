// ─────────────────────────────────────────────────────────────────────────────
// A/B/C MESSAGE VARIANTS HELPER
// ─────────────────────────────────────────────────────────────────────────────
// Steps can store up to 3 subject/body variants joined by the `|||` separator.
// When a lead has no custom CSV message (no outreachSubject / initialOutreach /
// followupDay3 / followupDay7), the dispatcher calls pickVariant() to randomly
// choose one of the configured variants. Empty variants are filtered out, so a
// step with only Variant A defined behaves exactly as before (single message).
//
// Storage format:
//   subject: "Variant A subject|||Variant B subject|||Variant C subject"
//   body:    "Variant A body|||Variant B body|||Variant C body"
//
// If a step has only Variant A, the field is just "Variant A subject" (no
// separator) — fully backward-compatible with existing data.

const VARIANT_SEPARATOR = '|||'

/**
 * Split a combined variant string into its non-empty parts.
 * Returns an array of 1+ strings (or [] if the input is empty/null).
 */
export function splitVariants(combined: string | null | undefined): string[] {
  if (!combined) return []
  return combined
    .split(VARIANT_SEPARATOR)
    .map((p) => p ?? '')
    .filter((p) => p.trim().length > 0)
}

/**
 * Pick a random variant from a combined `|||`-separated string.
 * If the string has no separator (single variant), returns it as-is.
 * If the string is null/empty, returns an empty string.
 *
 * Used by the dispatcher when scheduling campaign emails: each lead with no
 * custom CSV message gets one randomly-assigned variant frozen into their
 * ScheduledEmail row at scheduling time (so retries send the same variant).
 */
export function pickVariant(combined: string | null | undefined): string {
  const parts = splitVariants(combined)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  return parts[Math.floor(Math.random() * parts.length)]
}

/**
 * Count how many variants are configured in a combined `|||`-separated string.
 * Used for display/UI badges.
 */
export function countVariants(combined: string | null | undefined): number {
  return splitVariants(combined).length
}
