import { describe, expect, it } from 'vitest';
import { runChecks } from './checks.ts';
import { buildGraph, buildIr } from './graph.ts';
import type { Candidates, ExportFact, FileFacts, RawImport } from './ir.ts';

function facts(partial: Partial<FileFacts> = {}): FileFacts {
  return {
    kind: 'source',
    imports: [],
    exports: [],
    jsx: false,
    importsReact: false,
    hookCalls: 0,
    plays: 0,
    ...partial,
  };
}

function uses(source: string, name: string, rest: Partial<RawImport> = {}): RawImport {
  return { source, names: [name], typeOnly: false, via: 'import', ...rest };
}

function mocks(source: string): RawImport {
  return { source, names: [], typeOnly: false, via: 'mock' };
}

function fn(name: string): ExportFact {
  return { name, kind: 'function' };
}

const logic = (name: string, rest: Partial<FileFacts> = {}): FileFacts =>
  facts({ exports: [fn(name)], ...rest });
const component = (name: string, rest: Partial<FileFacts> = {}): FileFacts =>
  facts({ exports: [fn(name)], jsx: true, importsReact: true, ...rest });
const test = (...imports: RawImport[]): FileFacts => facts({ kind: 'test', imports });
const story = (plays: number, ...imports: RawImport[]): FileFacts =>
  facts({ kind: 'story', plays, imports });

function check(files: Record<string, FileFacts>): Candidates {
  const ir = buildIr(new Map(Object.entries(files)), {
    files: new Set(Object.keys(files)),
    tsconfigs: [],
    packages: [],
    generatedDirectories: [],
  });
  return runChecks(ir, buildGraph(ir));
}

describe('C1: pure logic that no test imports directly', () => {
  it('lists a pure function module without a test', () => {
    expect(check({ 'score.ts': logic('score') }).c1).toEqual([
      { file: 'score.ts', reach: 'none' },
    ]);
  });

  it('does not list a module that a test imports directly', () => {
    const { c1 } = check({
      'score.ts': logic('score'),
      'score.test.ts': test(uses('./score', 'score')),
    });
    expect(c1).toEqual([]);
  });

  it('marks a module that only a story reaches, through a component', () => {
    const { c1 } = check({
      'score.ts': logic('score'),
      'card.tsx': component('Card', { imports: [uses('./score', 'score')] }),
      'card.stories.tsx': story(0, uses('./card', 'Card')),
    });
    expect(c1).toEqual([{ file: 'score.ts', reach: 'story' }]);
  });

  it('marks a module that a test reaches only through another module', () => {
    const { c1 } = check({
      'round.ts': logic('round'),
      'score.ts': logic('score', { imports: [uses('./round', 'round')] }),
      'score.test.ts': test(uses('./score', 'score')),
    });
    expect(c1).toEqual([{ file: 'round.ts', reach: 'test' }]);
  });

  it('still lists a module whose only test import is a type', () => {
    const { c1 } = check({
      'score.ts': logic('score'),
      'score.test.ts': test(uses('./score', 'Score', { typeOnly: true })),
    });
    expect(c1).toEqual([{ file: 'score.ts', reach: 'none' }]);
  });

  it('still lists a module that a test only mocks', () => {
    const { c1 } = check({
      'db.ts': logic('find'),
      'page.test.ts': test(mocks('./db')),
    });
    expect(c1).toEqual([{ file: 'db.ts', reach: 'none' }]);
  });

  it.each([
    ['a file with JSX', facts({ exports: [fn('render')], jsx: true })],
    ['a file importing react', facts({ exports: [fn('helper')], importsReact: true })],
    ['a file calling a hook', facts({ exports: [fn('useThing')], hookCalls: 1 })],
    ['a file exporting only constants', facts({ exports: [{ name: 'LIMIT', kind: 'value' }] })],
    ['a file exporting only types', facts({ exports: [{ name: 'T', kind: 'type' }] })],
    ['a test file', facts({ kind: 'test', exports: [fn('helper')] })],
  ])('does not treat %s as pure logic', (_label, file) => {
    expect(check({ 'a.ts': file }).c1).toEqual([]);
  });
});

describe('C2: a component verified by both a test and a story with play', () => {
  it('lists a component imported by a test and by a story that has play', () => {
    const { c2 } = check({
      'card.tsx': component('Card'),
      'card.test.tsx': test(uses('./card', 'Card')),
      'card.stories.tsx': story(1, uses('./card', 'Card')),
    });
    expect(c2).toEqual([
      { file: 'card.tsx', testFiles: ['card.test.tsx'], storyFiles: ['card.stories.tsx'] },
    ]);
  });

  it('does not list it when the story has no play', () => {
    const { c2 } = check({
      'card.tsx': component('Card'),
      'card.test.tsx': test(uses('./card', 'Card')),
      'card.stories.tsx': story(0, uses('./card', 'Card')),
    });
    expect(c2).toEqual([]);
  });

  it('does not list it when no test imports the component', () => {
    const { c2 } = check({
      'card.tsx': component('Card'),
      'card.stories.tsx': story(2, uses('./card', 'Card')),
    });
    expect(c2).toEqual([]);
  });

  it('does not list pure logic used by a test and a story', () => {
    const { c2 } = check({
      'score.ts': logic('score'),
      'score.test.ts': test(uses('./score', 'score')),
      'card.stories.tsx': story(1, uses('./score', 'score')),
    });
    expect(c2).toEqual([]);
  });
});

describe('C3: mocked internal modules', () => {
  it('groups test files by the module they mock, most mocked first', () => {
    const { c3 } = check({
      'db.ts': logic('find'),
      'auth.ts': logic('auth'),
      'a.test.ts': test(mocks('./db'), mocks('./auth')),
      'b.test.ts': test(mocks('./db')),
    });
    expect(c3).toEqual([
      { target: 'db.ts', testFiles: ['a.test.ts', 'b.test.ts'] },
      { target: 'auth.ts', testFiles: ['a.test.ts'] },
    ]);
  });

  it('counts a test file once when it mocks the same module twice', () => {
    const { c3 } = check({
      'db.ts': logic('find'),
      'a.test.ts': test(mocks('./db'), mocks('./db')),
    });
    expect(c3).toEqual([{ target: 'db.ts', testFiles: ['a.test.ts'] }]);
  });

  it('leaves out mocks of packages and of files that do not resolve', () => {
    const { c3 } = check({
      'a.test.ts': test(mocks('next/navigation'), mocks('./missing')),
    });
    expect(c3).toEqual([]);
  });
});

describe('C4: components no story reaches', () => {
  it('lists a component without a story', () => {
    expect(check({ 'card.tsx': component('Card') }).c4).toEqual([{ file: 'card.tsx' }]);
  });

  it('does not list a component that a story imports', () => {
    const { c4 } = check({
      'card.tsx': component('Card'),
      'card.stories.tsx': story(0, uses('./card', 'Card')),
    });
    expect(c4).toEqual([]);
  });

  it('does not list a component reached through another component', () => {
    const { c4 } = check({
      'icon.tsx': component('Icon'),
      'card.tsx': component('Card', { imports: [uses('./icon', 'Icon')] }),
      'card.stories.tsx': story(0, uses('./card', 'Card')),
    });
    expect(c4).toEqual([]);
  });

  it('lists a component that only a test reaches', () => {
    const { c4 } = check({
      'card.tsx': component('Card'),
      'card.test.tsx': test(uses('./card', 'Card')),
    });
    expect(c4).toEqual([{ file: 'card.tsx' }]);
  });

  it('treats a default-exported function with JSX as a component', () => {
    const { c4 } = check({ 'widget.tsx': component('default') });
    expect(c4).toEqual([{ file: 'widget.tsx' }]);
  });

  it.each(['app/page.tsx', 'app/(private)/layout.tsx', 'app/error.tsx', 'app/not-found.tsx'])(
    'does not list the Next.js route file %s',
    (file) => {
      expect(check({ [file]: component('default') }).c4).toEqual([]);
    },
  );

  it('does not list a JSX file that exports only lowercase functions', () => {
    const { c4 } = check({ 'render.tsx': facts({ exports: [fn('renderRow')], jsx: true }) });
    expect(c4).toEqual([]);
  });
});
