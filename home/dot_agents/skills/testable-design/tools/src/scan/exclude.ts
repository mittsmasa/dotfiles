import { matchesGlob } from 'node:path/posix';
import type { Candidates } from './ir.ts';

/** Number of candidates removed from each check. */
export type ExcludedCounts = Record<keyof Candidates, number>;

/**
 * Removes candidates whose subject file matches one of the globs.
 *
 * The subject is the file the candidate is about: `file` for C1, C2 and C4,
 * and the mocked module (`target`) for C3. Files that merely appear in a
 * candidate, such as the test files that mock a module, are not matched.
 *
 * Exclusion only filters what is reported. The graph the candidates were
 * computed from still contains the excluded files.
 */
export function excludeCandidates(
  candidates: Candidates,
  globs: readonly string[],
): { candidates: Candidates; excluded: ExcludedCounts } {
  const keep = (path: string): boolean =>
    !globs.some((glob) => matchesGlob(path, glob));
  const kept: Candidates = {
    c1: candidates.c1.filter((candidate) => keep(candidate.file)),
    c2: candidates.c2.filter((candidate) => keep(candidate.file)),
    c3: candidates.c3.filter((candidate) => keep(candidate.target)),
    c4: candidates.c4.filter((candidate) => keep(candidate.file)),
  };
  return {
    candidates: kept,
    excluded: {
      c1: candidates.c1.length - kept.c1.length,
      c2: candidates.c2.length - kept.c2.length,
      c3: candidates.c3.length - kept.c3.length,
      c4: candidates.c4.length - kept.c4.length,
    },
  };
}
