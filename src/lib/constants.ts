/** Shared app constants. */

/** Wastage reasons — values match the backend WastageReason enum. */
export const WASTAGE_REASONS = [
  { value: 'spoilage', label: 'Spoilage' },
  { value: 'damage', label: 'Breakage / damaged' },
  { value: 'other', label: 'Other' },
] as const
