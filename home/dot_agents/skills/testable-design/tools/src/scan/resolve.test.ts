import { describe, expect, it } from 'vitest';
import {
  packageName,
  type Project,
  readPackageInfo,
  readTsconfig,
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
    { dir: 'apps/main', paths: { '@/*': ['./src/*'] }, baseUrl: null },
    {
      dir: 'apps/console',
      paths: { '@/*': ['./src/*'], '@config/*': ['./config/*'] },
      baseUrl: null,
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

describe('tsconfig baseUrl', () => {
  const withBaseUrl: Project = {
    files: new Set([
      'app/pages/index.tsx',
      'app/src/utils/recoil/atoms.ts',
      'app/src/hooks/index.ts',
      'app/src/styles/globals.css',
      'app/src/lodash/index.ts',
      'app/src/shared/date.ts',
      'app/src/date.ts',
      'app/src/empty/readme.md',
      'legacy/main.ts',
      'legacy/utils/format.ts',
    ]),
    tsconfigs: [
      { dir: 'app', paths: { 'shared/*': ['./missing/*'], '~/*': ['./*'] }, baseUrl: 'app/src' },
      { dir: 'legacy', paths: {}, baseUrl: null },
    ],
    packages: [
      { dir: 'app', name: 'app', dependencies: ['lodash', 'swiper', 'react'], exports: {} },
    ],
    generatedDirectories: [],
  };
  const page = 'app/pages/index.tsx';

  it('resolves a bare specifier against baseUrl, completing the extension', () => {
    expect(resolveSpecifier('utils/recoil/atoms', page, withBaseUrl)).toEqual({
      target: 'app/src/utils/recoil/atoms.ts',
      resolution: 'internal',
    });
  });

  it('completes index.ts for a directory under baseUrl', () => {
    expect(resolveSpecifier('hooks', page, withBaseUrl)).toEqual({
      target: 'app/src/hooks/index.ts',
      resolution: 'internal',
    });
  });

  it('classifies an existing stylesheet under baseUrl as an asset', () => {
    expect(resolveSpecifier('styles/globals.css', page, withBaseUrl)).toEqual({
      target: 'app/src/styles/globals.css',
      resolution: 'asset',
    });
  });

  it('prefers a file under baseUrl over a declared package of the same name', () => {
    expect(resolveSpecifier('lodash', page, withBaseUrl)).toEqual({
      target: 'app/src/lodash/index.ts',
      resolution: 'internal',
    });
  });

  it('stays external for a declared package with nothing under baseUrl', () => {
    expect(resolveSpecifier('react', page, withBaseUrl)).toEqual({
      target: null,
      resolution: 'external',
    });
  });

  it('leaves a missing non-code file of a declared package external', () => {
    expect(resolveSpecifier('swiper/swiper.css', page, withBaseUrl)).toEqual({
      target: null,
      resolution: 'external',
    });
  });

  it('is unresolved when nothing under baseUrl matches and no package declares it', () => {
    expect(resolveSpecifier('utils/missing', page, withBaseUrl)).toEqual({
      target: null,
      resolution: 'unresolved',
    });
  });

  it('is unresolved for a directory under baseUrl without an index', () => {
    expect(resolveSpecifier('empty', page, withBaseUrl)).toEqual({
      target: null,
      resolution: 'unresolved',
    });
  });

  it('resolves paths substitutions against baseUrl', () => {
    expect(resolveSpecifier('~/date', page, withBaseUrl)).toEqual({
      target: 'app/src/date.ts',
      resolution: 'internal',
    });
  });

  it('does not fall back to baseUrl once a paths pattern matched', () => {
    expect(resolveSpecifier('shared/date', page, withBaseUrl)).toEqual({
      target: null,
      resolution: 'unresolved',
    });
  });

  it('does not read a bare specifier as a path without baseUrl', () => {
    expect(resolveSpecifier('utils/format', 'legacy/main.ts', withBaseUrl)).toEqual({
      target: null,
      resolution: 'unresolved',
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

describe('build output of workspace packages', () => {
  const built: Project = {
    files: new Set([
      'packages/lib/src/index.ts',
      'packages/lib/src/button/index.tsx',
      'packages/lib/src/icons.ts',
      'packages/storybook/src/Button.stories.tsx',
    ]),
    tsconfigs: [],
    packages: [
      {
        dir: 'packages/lib',
        name: '@repo/lib',
        dependencies: [],
        exports: {
          '.': './dist/index.mjs',
          './button': './dist/button/index.js',
          './icons': './dist/icons.d.ts',
          './theme': './dist/theme.js',
        },
      },
    ],
    generatedDirectories: ['dist'],
  };
  const story = 'packages/storybook/src/Button.stories.tsx';

  it.each([
    ['@repo/lib', 'packages/lib/src/index.ts'],
    ['@repo/lib/button', 'packages/lib/src/button/index.tsx'],
    ['@repo/lib/icons', 'packages/lib/src/icons.ts'],
  ])('maps %s from the missing dist file to its source in src', (specifier, target) => {
    expect(resolveSpecifier(specifier, story, built)).toEqual({
      target,
      resolution: 'internal',
    });
  });

  it('stays generated when src has no matching source', () => {
    expect(resolveSpecifier('@repo/lib/theme', story, built)).toEqual({
      target: null,
      resolution: 'generated',
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

describe('readTsconfig', () => {
  it('reads paths from a tsconfig with a comment after an entry', () => {
    const text = `{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"],
      "@public/*": ["./public/*"] // workaround for assetPrefix
    },
  },
}`;
    expect(readTsconfig(text, 'apps/main')).toEqual({
      dir: 'apps/main',
      paths: { '@/*': ['./src/*'], '@public/*': ['./public/*'] },
      baseUrl: null,
    });
  });

  it('returns no paths and no baseUrl when compilerOptions has none', () => {
    expect(readTsconfig(`{ "compilerOptions": { "strict": true } }`, '')).toEqual({
      dir: '',
      paths: {},
      baseUrl: null,
    });
  });

  it.each([
    ['.', '', ''],
    ['.', 'apps/main', 'apps/main'],
    ['./src/', 'apps/main', 'apps/main/src'],
    ['src', '', 'src'],
    ['..', 'apps/main', 'apps'],
  ])('makes baseUrl %j of the tsconfig in %j root-relative', (baseUrl, dir, expected) => {
    const text = JSON.stringify({ compilerOptions: { baseUrl } });
    expect(readTsconfig(text, dir).baseUrl).toBe(expected);
  });

  it('ignores an absolute baseUrl', () => {
    const text = JSON.stringify({ compilerOptions: { baseUrl: '/srv/app' } });
    expect(readTsconfig(text, '').baseUrl).toBeNull();
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
