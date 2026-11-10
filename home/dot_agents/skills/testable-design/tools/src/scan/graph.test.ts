import { describe, expect, it } from 'vitest';
import { buildGraph, buildIr } from './graph.ts';
import type { ExportFact, FileFacts, RawImport } from './ir.ts';
import type { Project } from './resolve.ts';

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

function imports(source: string, names: string[], rest: Partial<RawImport> = {}): RawImport {
  return { source, names, typeOnly: false, via: 'import', ...rest };
}

function reexports(source: string, name: string, exportedAs?: string): RawImport {
  const record: RawImport = { source, names: [name], typeOnly: false, via: 'reexport' };
  if (exportedAs !== undefined) record.exportedAs = exportedAs;
  return record;
}

function fn(name: string): ExportFact {
  return { name, kind: 'function' };
}

function projectOf(files: Record<string, FileFacts>): {
  facts: Map<string, FileFacts>;
  project: Project;
} {
  return {
    facts: new Map(Object.entries(files)),
    project: {
      files: new Set(Object.keys(files)),
      tsconfigs: [],
      packages: [],
      generatedDirectories: [],
    },
  };
}

function targetsOf(files: Record<string, FileFacts>, file: string): (string | null)[] {
  const { facts: map, project } = projectOf(files);
  const record = buildIr(map, project).files.find((entry) => entry.file === file);
  return record!.imports.map((entry) => entry.target);
}

describe('buildIr', () => {
  it('resolves a mocked specifier against baseUrl like an import', () => {
    const { facts: map, project } = projectOf({
      'utils/api/index.ts': facts({ imports: [reexports('./client', '*')] }),
      'utils/api/client.ts': facts({ exports: [fn('get')] }),
      'features/list.test.ts': facts({
        kind: 'test',
        imports: [imports('utils/api', [], { via: 'mock' })],
      }),
    });
    project.tsconfigs = [{ dir: '', paths: {}, baseUrl: '' }];
    const record = buildIr(map, project).files.find(
      (entry) => entry.file === 'features/list.test.ts',
    );
    expect(record!.imports).toMatchObject([
      { via: 'mock', resolution: 'internal', module: 'utils/api/index.ts' },
    ]);
    expect(record!.imports[0].target).not.toBeNull();
  });

  it('points a named import through `export *` at the file that defines the name', () => {
    const files = {
      'hooks/index.ts': facts({ imports: [reexports('./use-a', '*'), reexports('./use-b', '*')] }),
      'hooks/use-a.ts': facts({ exports: [fn('useA')] }),
      'hooks/use-b.ts': facts({ exports: [fn('useB')] }),
      'page.ts': facts({ imports: [imports('./hooks', ['useB'])] }),
    };
    expect(targetsOf(files, 'page.ts')).toEqual(['hooks/use-b.ts']);
  });

  it('points a named import through `export { x } from` at the defining file', () => {
    const files = {
      'hooks/index.ts': facts({ imports: [reexports('./use-a', 'useA', 'useA')] }),
      'hooks/use-a.ts': facts({ exports: [fn('useA')] }),
      'page.ts': facts({ imports: [imports('./hooks', ['useA'])] }),
    };
    expect(targetsOf(files, 'page.ts')).toEqual(['hooks/use-a.ts']);
  });

  it('follows a renamed re-export back to the original name', () => {
    const files = {
      'index.ts': facts({ imports: [reexports('./impl', 'internalName', 'publicName')] }),
      'impl.ts': facts({ exports: [fn('internalName')] }),
      'page.ts': facts({ imports: [imports('./index', ['publicName'])] }),
    };
    expect(targetsOf(files, 'page.ts')).toEqual(['impl.ts']);
  });

  it('follows two levels of barrels', () => {
    const files = {
      'index.ts': facts({ imports: [reexports('./components', '*')] }),
      'components/index.ts': facts({ imports: [reexports('./button', '*')] }),
      'components/button.tsx': facts({ exports: [fn('Button')] }),
      'page.ts': facts({ imports: [imports('./index', ['Button'])] }),
    };
    expect(targetsOf(files, 'page.ts')).toEqual(['components/button.tsx']);
  });

  it('splits several names into one record each, with their own targets and the barrel as module', () => {
    const { facts: map, project } = projectOf({
      'hooks/index.ts': facts({ imports: [reexports('./use-a', '*'), reexports('./use-b', '*')] }),
      'hooks/use-a.ts': facts({ exports: [fn('useA')] }),
      'hooks/use-b.ts': facts({ exports: [fn('useB')] }),
      'page.ts': facts({ imports: [imports('./hooks', ['useA', 'useB'])] }),
    });
    const page = buildIr(map, project).files.find((entry) => entry.file === 'page.ts');
    expect(page!.imports).toEqual([
      { source: './hooks', names: ['useA'], typeOnly: false, via: 'import', target: 'hooks/use-a.ts', module: 'hooks/index.ts', resolution: 'internal' },
      { source: './hooks', names: ['useB'], typeOnly: false, via: 'import', target: 'hooks/use-b.ts', module: 'hooks/index.ts', resolution: 'internal' },
    ]);
  });

  it('keeps the barrel as the target of namespace and default imports', () => {
    const files = {
      'hooks/index.ts': facts({ imports: [reexports('./use-a', '*')] }),
      'hooks/use-a.ts': facts({ exports: [fn('useA')] }),
      'page.ts': facts({ imports: [imports('./hooks', ['*']), imports('./hooks', ['default'])] }),
    };
    expect(targetsOf(files, 'page.ts')).toEqual(['hooks/index.ts', 'hooks/index.ts']);
  });

  it('keeps the barrel as the target when no re-exported file defines the name', () => {
    const files = {
      'index.ts': facts({ imports: [reexports('./a', '*')] }),
      'a.ts': facts({ exports: [fn('other')] }),
      'page.ts': facts({ imports: [imports('./index', ['missing'])] }),
    };
    expect(targetsOf(files, 'page.ts')).toEqual(['index.ts']);
  });

  it('stops on barrels that re-export each other', () => {
    const files = {
      'a.ts': facts({ imports: [reexports('./b', '*')] }),
      'b.ts': facts({ imports: [reexports('./a', '*')] }),
      'page.ts': facts({ imports: [imports('./a', ['x'])] }),
    };
    expect(targetsOf(files, 'page.ts')).toEqual(['a.ts']);
  });

  it('treats a target without facts as the defining file', () => {
    const { project } = projectOf({ 'generated/graphql.ts': facts() });
    const map = new Map([['page.ts', facts({ imports: [imports('./generated/graphql', ['Query'])] })]]);
    const page = buildIr(map, project).files[0];
    expect(page.imports[0].target).toBe('generated/graphql.ts');
  });

  it('counts imports by how they resolved', () => {
    const { facts: map } = projectOf({
      'a.ts': facts({ exports: [fn('a')] }),
      'page.ts': facts({
        imports: [
          imports('./a', ['a']),
          imports('next/navigation', ['useRouter', 'usePathname']),
          imports('./logo.svg', ['default']),
          imports('./missing', ['x']),
          imports('unknown-package', ['y']),
          imports('./__generated__/graphql', ['Query']),
        ],
      }),
    });
    const project: Project = {
      files: new Set(['a.ts', 'page.ts']),
      tsconfigs: [],
      packages: [{ dir: '', name: null, dependencies: ['next'], exports: {} }],
      generatedDirectories: ['__generated__'],
    };
    expect(buildIr(map, project, 2).stats).toEqual({
      parseFailures: 2,
      imports: { internal: 1, generated: 1, external: 1, asset: 1, unresolved: 2 },
    });
  });
});

describe('buildGraph', () => {
  function graphOf(files: Record<string, FileFacts>) {
    const { facts: map, project } = projectOf(files);
    return buildGraph(buildIr(map, project));
  }

  it('lists the files that import a module directly', () => {
    const graph = graphOf({
      'score.ts': facts({ exports: [fn('score')] }),
      'score.test.ts': facts({ kind: 'test', imports: [imports('./score', ['score'])] }),
      'page.tsx': facts({ imports: [imports('./score', ['score'])] }),
    });
    expect(graph.importersOf('score.ts')).toEqual(['page.tsx', 'score.test.ts']);
  });

  it('attributes a named import through a barrel to the defining file only', () => {
    const graph = graphOf({
      'hooks/index.ts': facts({ imports: [reexports('./use-a', '*'), reexports('./use-b', '*')] }),
      'hooks/use-a.ts': facts({ exports: [fn('useA')] }),
      'hooks/use-b.ts': facts({ exports: [fn('useB')] }),
      'a.test.ts': facts({ kind: 'test', imports: [imports('./hooks', ['useA'])] }),
    });
    expect(graph.importersOf('hooks/use-a.ts')).toEqual(['a.test.ts']);
    expect(graph.importersOf('hooks/use-b.ts')).toEqual([]);
  });

  it('counts a namespace import of a barrel as a use of every re-exported file', () => {
    const graph = graphOf({
      'index.ts': facts({ imports: [reexports('./components', '*')] }),
      'components/index.ts': facts({ imports: [reexports('./button', '*')] }),
      'components/button.tsx': facts({ exports: [fn('Button')] }),
      'a.test.ts': facts({ kind: 'test', imports: [imports('./index', ['*'])] }),
    });
    expect(graph.importersOf('components/button.tsx')).toEqual(['a.test.ts']);
  });

  it('counts a default import of a barrel as a use of every re-exported file', () => {
    const graph = graphOf({
      'index.ts': facts({ imports: [reexports('./a', '*')] }),
      'a.ts': facts({ exports: [fn('a')] }),
      'a.test.ts': facts({ kind: 'test', imports: [imports('./index', ['default'])] }),
    });
    expect(graph.importersOf('a.ts')).toEqual(['a.test.ts']);
  });

  it('does not count a barrel as an importer of the files it re-exports', () => {
    const graph = graphOf({
      'index.ts': facts({ imports: [reexports('./a', '*')] }),
      'a.ts': facts({ exports: [fn('a')] }),
    });
    expect(graph.importersOf('a.ts')).toEqual([]);
  });

  it('leaves type-only imports out of importers and reachability', () => {
    const graph = graphOf({
      'types.ts': facts(),
      'a.test.ts': facts({ kind: 'test', imports: [imports('./types', ['T'], { typeOnly: true })] }),
    });
    expect(graph.importersOf('types.ts')).toEqual([]);
    expect([...graph.reachableFrom(['a.test.ts'])]).toEqual(['a.test.ts']);
  });

  it('leaves mocks out of importers and reachability', () => {
    const graph = graphOf({
      'db.ts': facts({ exports: [fn('find')] }),
      'a.test.ts': facts({ kind: 'test', imports: [imports('./db', [], { via: 'mock' })] }),
    });
    expect(graph.importersOf('db.ts')).toEqual([]);
    expect([...graph.reachableFrom(['a.test.ts'])]).toEqual(['a.test.ts']);
  });

  it('reaches files through several imports and through a barrel', () => {
    const graph = graphOf({
      'card.stories.tsx': facts({ kind: 'story', imports: [imports('./card', ['Card'])] }),
      'card.tsx': facts({ exports: [fn('Card')], imports: [imports('./lib', ['*'])] }),
      'lib/index.ts': facts({ imports: [reexports('./format', '*')] }),
      'lib/format.ts': facts({ exports: [fn('format')] }),
      'unrelated.ts': facts({ exports: [fn('unrelated')] }),
    });
    expect([...graph.reachableFrom(['card.stories.tsx'])].sort()).toEqual([
      'card.stories.tsx',
      'card.tsx',
      'lib/format.ts',
      'lib/index.ts',
    ]);
  });

  it('stops on a cycle of imports', () => {
    const graph = graphOf({
      'a.ts': facts({ exports: [fn('a')], imports: [imports('./b', ['b'])] }),
      'b.ts': facts({ exports: [fn('b')], imports: [imports('./a', ['a'])] }),
    });
    expect([...graph.reachableFrom(['a.ts'])].sort()).toEqual(['a.ts', 'b.ts']);
  });
});
