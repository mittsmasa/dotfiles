import { describe, expect, it } from 'vitest';
import { excludeCandidates } from './exclude.ts';
import type { Candidates } from './ir.ts';

function candidates(partial: Partial<Candidates> = {}): Candidates {
  return { c1: [], c2: [], c3: [], c4: [], ...partial };
}

describe('excludeCandidates', () => {
  it('removes C1 candidates whose file matches a glob', () => {
    const input = candidates({
      c1: [
        { file: 'src/mocks/generator.ts', reach: 'story' },
        { file: 'src/domains/score.ts', reach: 'none' },
      ],
    });
    expect(excludeCandidates(input, ['**/mocks/**'])).toEqual({
      candidates: candidates({ c1: [{ file: 'src/domains/score.ts', reach: 'none' }] }),
      excluded: { c1: 1, c2: 0, c3: 0, c4: 0 },
    });
  });

  it('removes C2 candidates by the component, not by its test or story files', () => {
    const input = candidates({
      c2: [
        {
          file: 'src/providers/date-provider.tsx',
          testFiles: ['src/form/hook.test.tsx'],
          storyFiles: ['src/card/index.stories.tsx'],
        },
        {
          file: 'src/card/index.tsx',
          testFiles: ['src/providers/card.test.tsx'],
          storyFiles: ['src/card/index.stories.tsx'],
        },
      ],
    });
    const result = excludeCandidates(input, ['**/providers/**']);
    expect(result.candidates.c2.map((candidate) => candidate.file)).toEqual([
      'src/card/index.tsx',
    ]);
    expect(result.excluded.c2).toBe(1);
  });

  it('removes C3 candidates by the mocked module, not by the test files that mock it', () => {
    const input = candidates({
      c3: [
        { target: 'src/mocks/handlers.ts', testFiles: ['src/a.test.ts'] },
        { target: 'src/db/queries.ts', testFiles: ['src/mocks/b.test.ts'] },
      ],
    });
    expect(excludeCandidates(input, ['**/mocks/**'])).toEqual({
      candidates: candidates({
        c3: [{ target: 'src/db/queries.ts', testFiles: ['src/mocks/b.test.ts'] }],
      }),
      excluded: { c1: 0, c2: 0, c3: 1, c4: 0 },
    });
  });

  it('removes C4 candidates whose file matches a glob', () => {
    const input = candidates({
      c4: [{ file: 'src/app/_components/mock-guard/index.tsx' }, { file: 'src/card/index.tsx' }],
    });
    expect(excludeCandidates(input, ['**/mock-guard/**'])).toEqual({
      candidates: candidates({ c4: [{ file: 'src/card/index.tsx' }] }),
      excluded: { c1: 0, c2: 0, c3: 0, c4: 1 },
    });
  });

  it('removes a candidate that matches any one of several globs', () => {
    const input = candidates({
      c1: [
        { file: 'src/mocks/generator.ts', reach: 'story' },
        { file: 'src/card/story-helpers.ts', reach: 'story' },
        { file: 'src/domains/score.ts', reach: 'none' },
      ],
    });
    const result = excludeCandidates(input, ['**/mocks/**', '**/story-helpers.ts']);
    expect(result.candidates.c1).toEqual([{ file: 'src/domains/score.ts', reach: 'none' }]);
    expect(result.excluded.c1).toBe(2);
  });

  it('keeps every candidate and counts nothing when no glob is given', () => {
    const input = candidates({
      c1: [{ file: 'src/mocks/generator.ts', reach: 'story' }],
      c4: [{ file: 'src/card/index.tsx' }],
    });
    expect(excludeCandidates(input, [])).toEqual({
      candidates: input,
      excluded: { c1: 0, c2: 0, c3: 0, c4: 0 },
    });
  });

  it('keeps a path whose directory name only starts with the excluded name', () => {
    const input = candidates({ c1: [{ file: 'src/mocksy/generator.ts', reach: 'none' }] });
    expect(excludeCandidates(input, ['**/mocks/**']).excluded.c1).toBe(0);
  });

  it('matches a directory at the root and a path with parentheses', () => {
    const input = candidates({
      c4: [{ file: 'mocks/panel.tsx' }, { file: 'src/app/(private)/guard/index.tsx' }],
    });
    expect(excludeCandidates(input, ['**/mocks/**', 'src/app/(private)/**']).excluded.c4).toBe(2);
  });
});
