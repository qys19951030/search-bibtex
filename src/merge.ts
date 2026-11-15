/**
 * merge.ts — Cross-source candidate merging for the same paper.
 *
 * Search sources return independent candidate lists; this module collapses the
 * candidates that describe the same paper into a single record.
 *
 * Two candidates are treated as the same paper when either:
 * 1. a strong identifier matches — normalized DOI equality or version-stripped,
 *    case-insensitive arXiv ID equality; or
 * 2. the weak match holds — highly similar titles AND highly similar author
 *    lists AND non-conflicting years (a year conflict means both years are
 *    present and differ).
 *
 * Each merged record keeps the field-richest contributing candidate as its
 * base, fills any remaining gaps from the other contributors, records the
 * source that supplied every field, lists every contributing source, and
 * retains the highest ranking score. Re-sorting the merged list can never
 * contradict the pre-merge ranking: ties keep the earliest ranked position.
 *
 * @module merge
 */

import { normalizeDoi } from "./bibtex.js";
import { stripArxivVersion } from "./metadata.js";
import { authorSimilarity, textSimilarity, type RankedBibliographicCandidate } from "./ranking.js";
import type { PaperSource, ScoreBreakdown, SearchQueryKind } from "./types.js";

/** Title similarity at or above which two weak-identifier candidates may merge. */
export const WEAK_TITLE_THRESHOLD = 0.85;
/** Author-list similarity at or above which two weak-identifier candidates may merge. */
export const WEAK_AUTHOR_THRESHOLD = 0.6;

/** Scalar bibliographic fields whose provenance is tracked after a merge. */
export type MergedFieldName =
  | "sourceId"
  | "title"
  | "authors"
  | "year"
  | "doi"
  | "arxivId"
  | "venue"
  | "url";

/**
 * A ranked candidate enriched with merge provenance.
 */
export interface MergedBibliographicCandidate extends RankedBibliographicCandidate {
  /** Every source that contributed a folded-in candidate, in ranked encounter order. */
  contributingSources: PaperSource[];
  /** The source that supplied the current value of each populated field. */
  fieldSources: Partial<Record<MergedFieldName, PaperSource>>;
  /** Number of raw candidates that were folded into this record (1 means no merging). */
  mergedCandidateCount: number;
  /** Position of the earliest contributing candidate in the pre-merge ranked list. */
  firstRankedIndex: number;
  /** BibTeX text attached later by the fetch stage; absent until then. */
  bibtex?: string;
}

/**
 * Outcome of merging a ranked candidate list.
 */
export interface MergeOutcome {
  /** Merged records, sorted so the pre-merge preference order is preserved. */
  records: MergedBibliographicCandidate[];
  /** Number of raw candidates removed by merging (raw count minus record count). */
  mergedDuplicateCount: number;
}

/**
 * Merge a ranked (score-descending) candidate list into one record per paper.
 *
 * @param candidates - Candidates as produced by the ranking stage, highest score first.
 * @returns The merged records and the number of duplicates that were folded away.
 */
export function mergeBibliographicCandidates(
  candidates: RankedBibliographicCandidate[]
): MergeOutcome {
  const groups: MergeGroup[] = [];

  candidates.forEach((candidate, index) => {
    const group = groups.find((existing) => candidatesDescribeSamePaper(existing.representative, candidate));
    if (group) {
      group.members.push({ candidate, rankedIndex: index });
      group.representative = buildMergedRecord(group.members);
      return;
    }
    groups.push({
      members: [{ candidate, rankedIndex: index }],
      representative: buildMergedRecord([{ candidate, rankedIndex: index }])
    });
  });

  const records = groups
    .map((group) => group.representative)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.firstRankedIndex - right.firstRankedIndex;
    });

  return {
    records,
    mergedDuplicateCount: Math.max(0, candidates.length - records.length)
  };
}

interface MergeMember {
  candidate: RankedBibliographicCandidate;
  rankedIndex: number;
}

interface MergeGroup {
  members: MergeMember[];
  representative: MergedBibliographicCandidate;
}

/**
 * Decide whether two candidates describe the same paper via a strong identifier
 * or the weak title/author/year rule.
 */
export function candidatesDescribeSamePaper(
  left: RankedBibliographicCandidate,
  right: RankedBibliographicCandidate
): boolean {
  return hasMatchingStrongIdentifier(left, right) || hasWeakMatch(left, right);
}

function hasMatchingStrongIdentifier(
  left: RankedBibliographicCandidate,
  right: RankedBibliographicCandidate
): boolean {
  if (left.doi && right.doi && normalizeDoi(left.doi) === normalizeDoi(right.doi)) {
    return true;
  }
  if (
    left.arxivId &&
    right.arxivId &&
    stripArxivVersion(left.arxivId).toLowerCase() === stripArxivVersion(right.arxivId).toLowerCase()
  ) {
    return true;
  }
  return false;
}

function hasWeakMatch(
  left: RankedBibliographicCandidate,
  right: RankedBibliographicCandidate
): boolean {
  if (!left.title || !right.title || left.authors.length === 0 || right.authors.length === 0) {
    return false;
  }
  if (hasConflictingYear(left.year, right.year)) {
    return false;
  }
  const titleScore = textSimilarity(left.title, right.title);
  const authorScore = authorSimilarity(left.authors, right.authors);
  return titleScore >= WEAK_TITLE_THRESHOLD && authorScore >= WEAK_AUTHOR_THRESHOLD;
}

function hasConflictingYear(left: number | undefined, right: number | undefined): boolean {
  return left !== undefined && right !== undefined && left !== right;
}

/**
 * Build the merged record for one group: the field-richest member is the base,
 * gaps are filled from the remaining members in ranked order, and the highest
 * score (with its breakdown) is retained.
 */
function buildMergedRecord(members: MergeMember[]): MergedBibliographicCandidate {
  const ordered = [...members].sort((left, right) => {
    const richnessGap = fieldRichness(right.candidate) - fieldRichness(left.candidate);
    if (richnessGap !== 0) {
      return richnessGap;
    }
    if (right.candidate.score !== left.candidate.score) {
      return right.candidate.score - left.candidate.score;
    }
    return left.rankedIndex - right.rankedIndex;
  });

  const base = ordered[0].candidate;
  const firstRankedIndex = Math.min(...members.map((member) => member.rankedIndex));
  const fieldSources: Partial<Record<MergedFieldName, PaperSource>> = {};
  const merged: MergedBibliographicCandidate = {
    ...base,
    contributingSources: [],
    fieldSources,
    mergedCandidateCount: members.length,
    firstRankedIndex,
    score: Math.max(...members.map((member) => member.candidate.score)),
    scoreBreakdown: pickHighestScoringBreakdown(members),
    matchedQuery: pickPreferredMatchedQuery(members)
  };

  // Record the base record as the provenance for every field it supplies.
  for (const field of MERGED_FIELDS) {
    if (hasFieldValue(merged, field)) {
      fieldSources[field] = base.source;
    }
  }

  for (const member of ordered) {
    for (const field of MERGED_FIELDS) {
      if (!hasFieldValue(member.candidate, field)) {
        continue;
      }
      if (isRicherFieldValue(merged, member.candidate, field)) {
        assignField(merged, field, member.candidate);
        fieldSources[field] = member.candidate.source;
        continue;
      }
      if (!hasFieldValue(merged, field)) {
        assignField(merged, field, member.candidate);
        fieldSources[field] = member.candidate.source;
      }
    }
  }

  merged.contributingSources = [...new Set(members.map((member) => member.candidate.source))];
  return merged;
}

const MERGED_FIELDS: MergedFieldName[] = [
  "sourceId",
  "title",
  "authors",
  "year",
  "doi",
  "arxivId",
  "venue",
  "url"
];

function hasFieldValue(
  candidate: RankedBibliographicCandidate,
  field: MergedFieldName
): boolean {
  const value = candidate[field];
  return Array.isArray(value) ? value.length > 0 : value !== undefined;
}

/**
 * Whether a donor's author list is richer (more distinct names) than the
 * current merged list. Scalar fields are never considered "richer": they keep
 * whichever value was chosen first.
 */
function isRicherFieldValue(
  current: RankedBibliographicCandidate,
  donor: RankedBibliographicCandidate,
  field: MergedFieldName
): boolean {
  if (field !== "authors") {
    return false;
  }
  return new Set(donor.authors).size > new Set(current.authors).size;
}

/**
 * Merge two author lists, keeping the current ordering and appending names the
 * current list lacks, without mutating either input.
 */
function mergeAuthorLists(current: string[], donor: string[]): string[] {
  const seen = new Set(current);
  const combined = [...current];
  for (const author of donor) {
    if (!seen.has(author)) {
      seen.add(author);
      combined.push(author);
    }
  }
  return combined;
}

function assignField(
  target: RankedBibliographicCandidate,
  field: MergedFieldName,
  donor: RankedBibliographicCandidate
): void {
  if (field === "authors") {
    Object.assign(target, { authors: mergeAuthorLists(target.authors, donor.authors) });
    return;
  }
  const value = donor[field];
  if (value !== undefined) {
    Object.assign(target, { [field]: value });
  }
}

/**
 * Richness score for choosing a base record. Scalar fields contribute one
 * point when present; the author list contributes its cardinality so a record
 * with more complete authorship wins over one with a truncated list.
 */
function fieldRichness(candidate: RankedBibliographicCandidate): number {
  const scalarFields = MERGED_FIELDS.filter((field) => field !== "authors");
  const scalarScore = scalarFields.reduce(
    (count, field) => count + (hasFieldValue(candidate, field) ? 1 : 0),
    0
  );
  return scalarScore + candidate.authors.length;
}

function pickHighestScoringBreakdown(members: MergeMember[]): ScoreBreakdown {
  return [...members].sort((left, right) => right.candidate.score - left.candidate.score)[0].candidate
    .scoreBreakdown;
}

const QUERY_PREFERENCE: Record<SearchQueryKind, number> = {
  doi: 0,
  arxiv: 1,
  "title-author": 2,
  title: 3
};

function pickPreferredMatchedQuery(members: MergeMember[]): SearchQueryKind {
  return [...members]
    .map((member) => member.candidate.matchedQuery)
    .sort((left, right) => QUERY_PREFERENCE[left] - QUERY_PREFERENCE[right])[0];
}
