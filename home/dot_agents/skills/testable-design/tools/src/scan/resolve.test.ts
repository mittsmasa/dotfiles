import { describe, expect, it } from 'vitest';
import {
  packageName,
  type Project,
  readPackageInfo,
  readTsconfigPaths,
  resolveSpecifier,
  stripJsonComments,
} from './resolve.ts';

const project: Project = {
  files: new Set([
    'apps/main/src/app/page.tsx',
    'apps/main/src/app/_hooks/use-redirect.ts',
    'apps/main/src/app/_components/card/index.tsx',
    'apps/main/src/app/_components/card/index.stories.tsx',
    'apps/main/src/domains/score.ts',
    'apps/main/src/assets/avatar.png',
    'apps/main/src/styles/globals.css',
    'apps/console/src/domains/score.ts',
    'apps/console/config/env.ts',
    'packages/ui/src/components/index.ts',
    'packages/ui/src/hooks/index.ts',
    'packages/ui/src/panda/preset.ts',
    'packages/ui/src/styles/globals.css',
    'index.ts',
  ]),
  tsconfigs: [
    { dir: 'apps/main', paths: { '@/*': ['./src/*'] } },
    {
      dir: 'apps/console',
      paths: { '@/*': ['./src/*'], '@config/*': ['./config/*'] },
    },
  ],
  packages: [
    { dir: '', name: null, dependencies: ['vitest'], exports: {} },
    { dir: 'apps/main', name: 'main', dependencies: ['next', '@urql/next'], exports: {} },
    { dir: 'apps/console', name: 'console', dependencies: [], exports: {} },
    {
      dir: 'packages/ui',
      name: '@repo/ui',
      dependencies: [],
      exports: {
        './components': './src/components/index.ts',
        './hooks': './src/hooks/index.ts',
        './globals.css': './src/styles/globals.css',
        './panda/*': './src/panda/*.ts',
        './css': './src/styled-system/css/index.js',
      },
    },
  ],
  generatedDirectories: ['styled-system', '__generated__'],
};

const from = 'apps/main/src/app/page.tsx';

describe('resolveSpecifier', () => {
  describe('relative paths', () => {
    it('completes the extension', () => {
      expect(resolveSpecifier('./_hooks/use-redirect', from, project)).toEqual({
        target: 'apps/main/src/app/_hooks/use-redirect.ts',
        resolution: 'internal',
      });
    });

    it('completes index.tsx for a directory', () => {
      expect(resolveSpecifier('./_components/card', from, project)).toEqual({
        target: 'apps/main/src/app/_components/card/index.tsx',
        resolution: 'internal',
      });
    });

    it("resolves '.' to the index of the importer's directory", () => {
      const story = 'apps/main/src/app/_components/card/index.stories.tsx';
      expect(resolveSpecifier('.', story, project)).toEqual({
        target: 'apps/main/src/app/_components/card/index.tsx',
        resolution: 'internal',
      });
    });

    it('walks up with ../', () => {
      expect(resolveSpecifier('../domains/score', from, project)).toEqual({
        target: 'apps/main/src/domains/score.ts',
        resolution: 'internal',
      });
    });

    it('reaches a file at the project root', () => {
      expect(resolveSpecifier('../../../../index', from, project)).toEqual({
        target: 'index.ts',
        resolution: 'internal',
      });
    });

    it('is unresolved when the file does not exist', () => {
      expect(resolveSpecifier('./missing', from, project)).toEqual({
        target: null,
        resolution: 'unresolved',
      });
    });

    it('classifies a non-code file outside the project root as an asset', () => {
      expect(resolveSpecifier('../../../../../schema.gql', from, project)).toEqual({
        target: null,
        resolution: 'asset',
      });
    });

    it('is unresolved when the path leaves the project root', () => {
      expect(resolveSpecifier('../../../../../outside', from, project)).toEqual({
        target: null,
        resolution: 'unresolved',
      });
    });
  });

  describe('tsconfig paths', () => {
    it('maps @/* to src/* of the nearest tsconfig', () => {
      expect(resolveSpecifier('@/domains/score', from, project)).toEqual({
        target: 'apps/main/src/domains/score.ts',
        resolution: 'internal',
      });
    });

    it('uses the tsconfig of the package the importer belongs to', () => {
      const importer = 'apps/console/src/domains/score.ts';
      expect(resolveSpecifier('@/domains/score', importer, project)).toEqual({
        target: 'apps/console/src/domains/score.ts',
        resolution: 'internal',
      });
    });

    it('applies a second pattern of the same tsconfig', () => {
      const importer = 'apps/console/src/domains/score.ts';
      expect(resolveSpecifier('@config/env', importer, project)).toEqual({
        target: 'apps/console/config/env.ts',
        resolution: 'internal',
      });
    });

    it('is unresolved when the pattern matches but the file does not exist', () => {
      expect(resolveSpecifier('@/domains/missing', from, project)).toEqual({
        target: null,
        resolution: 'unresolved',
      });
    });

    it('does not apply the paths of another package', () => {
      expect(resolveSpecifier('@config/env', from, project)).toEqual({
        target: null,
        resolution: 'unresolved',
      });
    });
  });

  describe('workspace packages', () => {
    it('follows the exports entry of the subpath', () => {
      expect(resolveSpecifier('@repo/ui/components', from, project)).toEqual({
        target: 'packages/ui/src/components/index.ts',
        resolution: 'internal',
      });
    });

    it('follows a pattern entry', () => {
      expect(resolveSpecifier('@repo/ui/panda/preset', from, project)).toEqual({
        target: 'packages/ui/src/panda/preset.ts',
        resolution: 'internal',
      });
    });

    it('is unresolved for a subpath that exports does not list', () => {
      expect(resolveSpecifier('@repo/ui/internal', from, project)).toEqual({
        target: null,
        resolution: 'unresolved',
      });
    });

    it('classifies an exported stylesheet as an asset', () => {
      expect(resolveSpecifier('@repo/ui/globals.css', from, project)).toEqual({
        target: 'packages/ui/src/styles/globals.css',
        resolution: 'asset',
      });
    });
  });

  describe('assets', () => {
    it('classifies an existing image as an asset', () => {
      expect(resolveSpecifier('@/assets/avatar.png', from, project)).toEqual({
        target: 'apps/main/src/assets/avatar.png',
        resolution: 'asset',
      });
    });

    it('classifies a missing non-code file as an asset', () => {
      expect(resolveSpecifier('./generated.svg', from, project)).toEqual({
        target: null,
        resolution: 'asset',
      });
    });

    it('ignores a query string', () => {
      expect(resolveSpecifier('@/styles/globals.css?inline', from, project)).toEqual({
        target: 'apps/main/src/styles/globals.css',
        resolution: 'asset',
      });
    });
  });

  describe('external packages', () => {
    it('is external when the nearest package.json declares it', () => {
      expect(resolveSpecifier('next/navigation', from, project)).toEqual({
        target: null,
        resolution: 'external',
      });
    });

    it('matches a scoped package by scope and name', () => {
      expect(resolveSpecifier('@urql/next/rsc', from, project)).toEqual({
        target: null,
        resolution: 'external',
      });
    });

    it('is external when a package.json further up declares it', () => {
      expect(resolveSpecifier('vitest', from, project)).toEqual({
        target: null,
        resolution: 'external',
      });
    });

    it('is external for a Node builtin with and without the node: prefix', () => {
      expect(resolveSpecifier('node:path', from, project).resolution).toBe('external');
      expect(resolveSpecifier('fs', from, project).resolution).toBe('external');
    });

    it('is unresolved when no package.json above the importer declares it', () => {
      const importer = 'apps/console/src/domains/score.ts';
      expect(resolveSpecifier('next/navigation', importer, project)).toEqual({
        target: null,
        resolution: 'unresolved',
      });
    });
  });
});

describe('generated directories', () => {
  it('is generated when a paths match points into a generated directory with no file', () => {
    expect(resolveSpecifier('@/styled-system/css', from, project)).toEqual({
      target: null,
      resolution: 'generated',
    });
  });

  it('is generated for a relative path into a generated directory', () => {
    expect(resolveSpecifier('../__generated__/graphql', from, project)).toEqual({
      target: null,
      resolution: 'generated',
    });
  });

  it('is generated when workspace exports point into a generated directory', () => {
    expect(resolveSpecifier('@repo/ui/css', from, project)).toEqual({
      target: null,
      resolution: 'generated',
    });
  });

  it('stays unresolved when the directory name only resembles a generated one', () => {
    expect(resolveSpecifier('@/styled-system-studio/css', from, project)).toEqual({
      target: null,
      resolution: 'unresolved',
    });
  });
});

describe('packageName', () => {
  it.each([
    ['next', 'next'],
    ['next/navigation', 'next'],
    ['@urql/next', '@urql/next'],
    ['@urql/next/rsc', '@urql/next'],
  ])('%s belongs to %s', (specifier, name) => {
    expect(packageName(specifier)).toBe(name);
  });
});

describe('stripJsonComments', () => {
  it('removes line comments, block comments and trailing commas', () => {
    const text = `{
  // line comment
  "a": 1, /* block
  comment */
  "b": [1, 2,],
}`;
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 1, b: [1, 2] });
  });

  it('keeps comment-like text and escaped quotes inside strings', () => {
    const text = `{ "url": "https://example.com/a", "glob": "src/**/*.ts", "quote": "a \\" // b" }`;
    expect(JSON.parse(stripJsonComments(text))).toEqual({
      url: 'https://example.com/a',
      glob: 'src/**/*.ts',
      quote: 'a " // b',
    });
  });
});

describe('readTsconfigPaths', () => {
  it('reads paths from a tsconfig with a comment after an entry', () => {
    const text = `{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"],
      "@public/*": ["./public/*"] // workaround for assetPrefix
    },
  },
}`;
    expect(readTsconfigPaths(text)).toEqual({
      '@/*': ['./src/*'],
      '@public/*': ['./public/*'],
    });
  });

  it('returns no paths when compilerOptions has none', () => {
    expect(readTsconfigPaths(`{ "compilerOptions": { "strict": true } }`)).toEqual({});
  });
});

describe('readPackageInfo', () => {
  it('collects the three dependency fields and normalizes exports', () => {
    const text = JSON.stringify({
      name: '@repo/ui',
      dependencies: { react: '19' },
      devDependencies: { vitest: '5' },
      peerDependencies: { next: '16' },
      exports: {
        './components': { default: './src/components/index.ts' },
        './globals.css': './src/styles/globals.css',
        './types': { types: './src/types.d.ts' },
        './broken': { node: 3 },
      },
    });
    expect(readPackageInfo(text, 'packages/ui')).toEqual({
      dir: 'packages/ui',
      name: '@repo/ui',
      dependencies: ['react', 'vitest', 'next'],
      exports: {
        './components': './src/components/index.ts',
        './globals.css': './src/styles/globals.css',
        './types': './src/types.d.ts',
      },
    });
  });

  it('treats a string exports field as the root entry', () => {
    const text = JSON.stringify({ name: 'lib', exports: './src/index.ts' });
    expect(readPackageInfo(text, 'packages/lib').exports).toEqual({
      '.': './src/index.ts',
    });
  });

  it('accepts a package.json without a name or dependencies', () => {
    expect(readPackageInfo(`{}`, '')).toEqual({
      dir: '',
      name: null,
      dependencies: [],
      exports: {},
    });
  });
});
