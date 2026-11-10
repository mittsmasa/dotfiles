import { describe, expect, it } from 'vitest';
import { type CheckOptions, runChecks } from './checks.ts';
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
    directives: [],
    envReads: [],
    matcherLiterals: [],
    ...partial,
  };
}

function uses(source: string, name: string, rest: Partial<RawImport> = {}): RawImport {
  return { source, names: [name], typeOnly: false, via: 'import', ...rest };
}

function mocks(source: string, rest: Partial<RawImport> = {}): RawImport {
  return { source, names: [], typeOnly: false, via: 'mock', factory: true, partial: false, ...rest };
}

function reexports(source: string): RawImport {
  return { source, names: ['*'], typeOnly: false, via: 'reexport' };
}

function external(source: string): RawImport {
  return { source, names: ['readFile'], typeOnly: false, via: 'import' };
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

function check(files: Record<string, FileFacts>, options: CheckOptions = {}): Candidates {
  const ir = buildIr(new Map(Object.entries(files)), {
    files: new Set(Object.keys(files)),
    tsconfigs: [],
    packages: [],
    generatedDirectories: [],
  });
  return runChecks(ir, buildGraph(ir), options);
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

  it('marks a module behind a mocked module as test-mocked, not self', () => {
    const { c1 } = check({
      'extract.ts': logic('extract'),
      'reader.ts': logic('read', { imports: [uses('./extract', 'extract')] }),
      'handler.ts': logic('handle', { imports: [uses('./reader', 'read')] }),
      'handler.test.ts': test(uses('./handler', 'handle'), mocks('./reader')),
    });
    expect(c1).toContainEqual({
      file: 'extract.ts',
      reach: 'test-mocked',
      mockedAt: ['reader.ts'],
      self: false,
    });
  });

  it('marks a mocked module itself as test-mocked with self', () => {
    const { c1 } = check({
      'reader.ts': logic('read'),
      'handler.ts': logic('handle', { imports: [uses('./reader', 'read')] }),
      'handler.test.ts': test(uses('./handler', 'handle'), mocks('./reader')),
    });
    expect(c1).toEqual([
      { file: 'reader.ts', reach: 'test-mocked', mockedAt: ['reader.ts'], self: true },
    ]);
  });

  it('cuts at a mocked barrel even though the import points past it, and counts what it re-exports as self', () => {
    const { c1 } = check({
      'queries/index.ts': facts({ imports: [reexports('./sessions')] }),
      'queries/sessions.ts': logic('getSession'),
      'action.ts': logic('act', { imports: [uses('./queries', 'getSession')] }),
      'action.test.ts': test(uses('./action', 'act'), mocks('./queries')),
    });
    expect(c1).toEqual([
      {
        file: 'queries/sessions.ts',
        reach: 'test-mocked',
        mockedAt: ['queries/index.ts'],
        self: true,
      },
    ]);
  });

  it('keeps reach test when another test reaches the module for real', () => {
    const { c1 } = check({
      'reader.ts': logic('read'),
      'handler.ts': logic('handle', { imports: [uses('./reader', 'read')] }),
      'handler.test.ts': test(uses('./handler', 'handle'), mocks('./reader')),
      'other.test.ts': test(uses('./handler', 'handle')),
    });
    expect(c1).toEqual([{ file: 'reader.ts', reach: 'test' }]);
  });

  it('does not cut at a partial mock, whose real module still runs', () => {
    const { c1 } = check({
      'reader.ts': logic('read'),
      'handler.ts': logic('handle', { imports: [uses('./reader', 'read')] }),
      'handler.test.ts': test(uses('./handler', 'handle'), mocks('./reader', { partial: true })),
    });
    expect(c1).toEqual([{ file: 'reader.ts', reach: 'test' }]);
  });

  it('leaves out of mockedAt a mock that is not on the way to the module', () => {
    const { c1 } = check({
      'reader.ts': logic('read'),
      'clock.ts': logic('now'),
      'handler.ts': logic('handle', {
        imports: [uses('./reader', 'read'), uses('./clock', 'now')],
      }),
      'handler.test.ts': test(uses('./handler', 'handle'), mocks('./reader'), mocks('./clock')),
    });
    expect(c1).toContainEqual({
      file: 'reader.ts',
      reach: 'test-mocked',
      mockedAt: ['reader.ts'],
      self: true,
    });
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
      { target: 'db.ts', testFiles: ['a.test.ts', 'b.test.ts'], touches: [], partial: [] },
      { target: 'auth.ts', testFiles: ['a.test.ts'], touches: [], partial: [] },
    ]);
  });

  it('counts a test file once when it mocks the same module twice', () => {
    const { c3 } = check({
      'db.ts': logic('find'),
      'a.test.ts': test(mocks('./db'), mocks('./db')),
    });
    expect(c3).toEqual([{ target: 'db.ts', testFiles: ['a.test.ts'], touches: [], partial: [] }]);
  });

  it('lists the I/O builtins and environment variables the mocked module and its re-exports touch', () => {
    const { c3 } = check({
      'store/index.ts': facts({ imports: [reexports('./files')] }),
      'store/files.ts': logic('load', {
        imports: [external('node:fs/promises')],
        envReads: ['NODE_ENV', 'STORE_DIR'],
      }),
      'a.test.ts': test(mocks('./store')),
    });
    expect(c3).toEqual([
      {
        target: 'store/index.ts',
        testFiles: ['a.test.ts'],
        touches: ['fs', 'process.env.STORE_DIR'],
        partial: [],
      },
    ]);
  });

  it('lists the test files whose mock is partial', () => {
    const { c3 } = check({
      'check.ts': logic('check'),
      'a.test.ts': test(mocks('./check', { partial: true })),
      'b.test.ts': test(mocks('./check')),
    });
    expect(c3).toEqual([
      { target: 'check.ts', testFiles: ['a.test.ts', 'b.test.ts'], touches: [], partial: ['a.test.ts'] },
    ]);
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

  it('notes a story next to the component, named after it, that does not render it', () => {
    const { c4 } = check({
      'history/index.tsx': component('History'),
      'history/empty.tsx': component('Empty'),
      'history/index.stories.tsx': story(0, uses('./empty', 'Empty')),
    });
    expect(c4).toEqual([{ file: 'history/index.tsx', siblingStory: 'history/index.stories.tsx' }]);
  });

  it('notes the server actions the component imports', () => {
    const { c4 } = check({
      'actions.ts': logic('deleteSession', { directives: ['use server'] }),
      'history.tsx': component('History', { imports: [uses('./actions', 'deleteSession')] }),
    });
    expect(c4).toEqual([{ file: 'history.tsx', serverActions: ['deleteSession'] }]);
  });

  it('does not note a type-only import from a server action file', () => {
    const { c4 } = check({
      'actions.ts': logic('deleteSession', { directives: ['use server'] }),
      'history.tsx': component('History', {
        imports: [uses('./actions', 'Result', { typeOnly: true })],
      }),
    });
    expect(c4).toEqual([{ file: 'history.tsx' }]);
  });

  it('does not list a JSX file that exports only lowercase functions', () => {
    const { c4 } = check({ 'render.tsx': facts({ exports: [fn('renderRow')], jsx: true }) });
    expect(c4).toEqual([]);
  });
});

describe('C5: tests in different layers that share expected literals', () => {
  const format = logic('format');
  const handler = logic('handle', { imports: [uses('./format', 'format')] });
  const withLiterals = (literals: string[], ...imports: RawImport[]): FileFacts =>
    facts({ kind: 'test', imports, matcherLiterals: literals });

  it('pairs a test of a module with a test that reaches it through another module', () => {
    const { c5 } = check({
      'format.ts': format,
      'handler.ts': handler,
      'format.test.ts': withLiterals(['label: Save', 'path (outermost first)'], uses('./format', 'format')),
      'handler.test.ts': withLiterals(['label: Save', 'path (outermost first)', 'other'], uses('./handler', 'handle')),
    });
    expect(c5).toEqual([
      {
        direct: 'format.test.ts',
        indirect: 'handler.test.ts',
        subjects: ['format.ts'],
        literals: ['label: Save', 'path (outermost first)'],
      },
    ]);
  });

  it('does not pair tests that share only one literal', () => {
    const { c5 } = check({
      'format.ts': format,
      'handler.ts': handler,
      'format.test.ts': withLiterals(['label: Save', 'a'], uses('./format', 'format')),
      'handler.test.ts': withLiterals(['label: Save', 'b'], uses('./handler', 'handle')),
    });
    expect(c5).toEqual([]);
  });

  it('does not pair them when the indirect test mocks the module', () => {
    const { c5 } = check({
      'format.ts': format,
      'handler.ts': handler,
      'format.test.ts': withLiterals(['label: Save', 'path: x > y'], uses('./format', 'format')),
      'handler.test.ts': withLiterals(
        ['label: Save', 'path: x > y'],
        uses('./handler', 'handle'),
        mocks('./format'),
      ),
    });
    expect(c5).toEqual([]);
  });
});

describe('C6: source files that read the same environment variables', () => {
  it('groups files by the set of files reading each variable, leaving NODE_ENV out', () => {
    const { c6 } = check({
      'title.ts': logic('title', { envReads: ['LLM_KEY', 'LLM_URL', 'NODE_ENV'] }),
      'model.ts': logic('model', { envReads: ['LLM_KEY', 'LLM_URL'] }),
      'db.ts': logic('db', { envReads: ['DB_HOST', 'NODE_ENV'] }),
      'migrate.ts': logic('migrate', { envReads: ['DB_HOST'] }),
      'only.ts': logic('only', { envReads: ['SOLO'] }),
      'model.test.ts': facts({ kind: 'test', envReads: ['LLM_KEY'] }),
    });
    expect(c6).toEqual([
      { env: ['DB_HOST'], files: ['db.ts', 'migrate.ts'] },
      { env: ['LLM_KEY', 'LLM_URL'], files: ['model.ts', 'title.ts'] },
    ]);
  });

  it('leaves out the variables passed in envIgnore', () => {
    const { c6 } = check(
      {
        'a.ts': logic('a', { envReads: ['CI'] }),
        'b.ts': logic('b', { envReads: ['CI'] }),
      },
      { envIgnore: ['CI'] },
    );
    expect(c6).toEqual([]);
  });
});
