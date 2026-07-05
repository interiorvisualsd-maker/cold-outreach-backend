// ─────────────────────────────────────────────────────────────────────────────
// A/B/C MESSAGE VARIANTS
// ─────────────────────────────────────────────────────────────────────────────
//
// Step subjects/bodies can contain up to 3 variants separated by "|||".
// Example: "Hey {{first}}|||Hi {{first}}|||Quick question, {{first}}"
//
// pickVariant() splits on "|||" and returns ONE random non-empty variant.
// Single-variant strings (no "|||") pass through unchanged — fully backward
// compatible with steps that only have one message.

export function pickVariant(combined: string | null | undefined): string {
  if (!combined) return ''
  const parts = combined.split('|||').map((p) => p.trim()).filter((p) => p.length > 0)
  if (parts.length === 0) return combined
  if (parts.length === 1) return parts[0]
  // Pick a random variant — this is frozen into the ScheduledEmail row at
  // scheduling time (in routes/campaigns.ts) so retries send the same variant.
  // For follow-ups scheduled by scheduleNextStep, the variant is picked here
  // at scheduling time and stored in the ScheduledEmail.body/subject fields.
  return parts[Math.floor(Math.random() * parts.length)]
}

// Return the count of variants in a combined string (for UI badges)
export function variantCount(combined: string | null | undefined): number {
  if (!combined) return 0
  const parts = combined.split('|||').map((p) => p.trim()).filter((p) => p.length > 0)
  return parts.length || 0
}
