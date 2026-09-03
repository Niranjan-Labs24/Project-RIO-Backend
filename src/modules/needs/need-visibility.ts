// RIO-AI-004 — the one rule every read of `needs` has to honour.
//
// A merged need is RETIRED, not deleted: its row stays, its reference keeps
// resolving, and its history is intact (Q51's "no entry overrides another
// one"). The cost of that choice is that every query which counts, lists,
// scores or reports on needs must exclude it, or the platform double-counts
// exactly the duplication the merge was performed to remove.
//
// Kept as a shared constant rather than repeated inline so the rule is
// greppable and has one place to change:
//
//     where: { studyId, ...EXCLUDE_MERGED }
//
// Deliberate exceptions, each of which must say why in a comment at the call
// site:
//   * the Archive — an archive that hides retired records is not an archive
//   * NeedMergeService — it has to read the need it is retiring
//   * reference/alias lookup — resolving a retired number is the point
export const EXCLUDE_MERGED = { mergedIntoNeedId: null } as const;

/** The SQL form, for the raw candidate query in duplicate detection. */
export const EXCLUDE_MERGED_SQL = 'n.merged_into_need_id IS NULL';
