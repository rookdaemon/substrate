/**
 * Detects AUTHORITY INVERSION in proposals targeting PLAN.md.
 *
 * AUTHORITY INVERSION is a governance anti-pattern where the proposal generator
 * produces proposals that subtract from, relocate, or replace PLAN.md sections
 * with pointers to other files — effectively undermining PLAN.md's role as the
 * authoritative governance record.
 *
 * Detection is keyword/phrase based (precision over recall).
 */

export interface AuthorityInversionResult {
  inverted: boolean;
  reason?: string;
  subtype?: "subtractive" | "reference-replacing";
}

export interface AuthorityInversionProposal {
  target: string;
  content: string;
}

/** Patterns that indicate content is being moved or removed from PLAN.md (subtractive). */
const SUBTRACTIVE_PATTERNS = [
  /\bmove\b.{0,60}\b(to|into)\b.{0,60}\b(PROGRESS|memory[/\\]|memory\.md|progress\.md)/i,
  /\belongs\s+in\s+(memory[/\\]|PROGRESS|progress\.md|memory\.md)/i,
  /\bPLAN\.md\s+is\s+too\s+long\b/i,
  /\b(trim|condense|prune|shrink|shorten)\b.{0,40}\bPLAN\b/i,
  /\b(remove|strip|delete)\b.{0,60}\bfrom\s+PLAN\b/i,
  /\b(move|migrate|relocate)\b.{0,80}\b(out\s+of|from)\s+PLAN\b/i,
  /\barchive\b.{0,60}\bPLAN\b/i,
];

/** Patterns that indicate PLAN.md sections are being replaced with pointers/references. */
const REFERENCE_REPLACING_PATTERNS = [
  /\breplace\b.{0,80}\b(with\s+)?(a\s+)?(pointer|reference|link)\b/i,
  /\bpointer\b.{0,60}\b(to|into)\b.{0,60}\b(PROGRESS|memory[/\\]|memory\.md)/i,
  /\bsummar(?:y|iz\w*)\b.{0,60}\b(PLAN|PLAN\.md)\b.{0,60}\b(and\s+)?(point|redirect|link)\b/i,
  /\b(inline|in-place)\s+reference\b/i,
  /\breplace\b.{0,60}\b(sections?|content|tasks?)\b.{0,60}\b(with\s+)?(pointer|reference)\b/i,
];

function targetIsPlan(target: string): boolean {
  return target.trim().toUpperCase() === "PLAN";
}

/**
 * Detects whether a proposal targeting PLAN.md constitutes an AUTHORITY INVERSION.
 *
 * Returns `{ inverted: false }` for proposals that are not targeting PLAN or
 * that represent legitimate additive/refinement changes. Returns
 * `{ inverted: true, subtype, reason }` for subtractive or reference-replacing proposals.
 */
export function detectAuthorityInversion(
  proposal: AuthorityInversionProposal
): AuthorityInversionResult {
  if (!targetIsPlan(proposal.target)) {
    return { inverted: false };
  }

  const text = proposal.content;

  for (const pattern of SUBTRACTIVE_PATTERNS) {
    if (pattern.test(text)) {
      return {
        inverted: true,
        subtype: "subtractive",
        reason: `AUTHORITY INVERSION (subtractive): PLAN.md is the governance record; subtractive restructuring is out of scope for proposal generation.`,
      };
    }
  }

  for (const pattern of REFERENCE_REPLACING_PATTERNS) {
    if (pattern.test(text)) {
      return {
        inverted: true,
        subtype: "reference-replacing",
        reason: `AUTHORITY INVERSION (reference-replacing): PLAN.md is the governance record; subtractive restructuring is out of scope for proposal generation.`,
      };
    }
  }

  return { inverted: false };
}
