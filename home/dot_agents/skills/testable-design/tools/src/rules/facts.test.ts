import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import type { FileFacts } from '../scan/ir.ts';
import rule from './facts.ts';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

/** Expected diagnostic for a file; only the facts under test are spelled out. */
function reports(facts: Partial<FileFacts>): { message: string }[] {
  const complete: FileFacts = {
    kind: 'source',
    imports: [],
    exports: [],
    jsx: false,
    importsReact: false,
    hookCalls: 0,
    plays: 0,
    ...facts,
  };
  return [{ message: JSON.stringify(complete) }];
}

ruleTester.run('facts', rule, {
  valid: [],
  invalid: [
    {
      name: 'an empty file still reports one record',
      filename: 'src/empty.ts',
      code: ``,
      errors: reports({}),
    },
    {
      name: 'named, default and namespace imports keep the names taken from the module',
      filename: 'src/a.ts',
      code: `import def, { a, b as c } from './x'; import * as ns from './y';`,
      errors: reports({
        imports: [
          { source: './x', names: ['default', 'a', 'b'], typeOnly: false, via: 'import' },
          { source: './y', names: ['*'], typeOnly: false, via: 'import' },
        ],
      }),
    },
    {
      name: 'a side-effect import has no names',
      filename: 'src/a.ts',
      code: `import './setup';`,
      errors: reports({
        imports: [{ source: './setup', names: [], typeOnly: false, via: 'import' }],
      }),
    },
    {
      name: 'a type-only import is marked, and inline type specifiers are split from values',
      filename: 'src/a.ts',
      code: `import type { T } from './t'; import { v, type U } from './u';`,
      errors: reports({
        imports: [
          { source: './t', names: ['T'], typeOnly: true, via: 'import' },
          { source: './u', names: ['v'], typeOnly: false, via: 'import' },
          { source: './u', names: ['U'], typeOnly: true, via: 'import' },
        ],
      }),
    },
    {
      name: 're-exports record the source name and the exported name',
      filename: 'src/index.ts',
      code: `export * from './a'; export { b, c as d } from './b'; export * as ns from './c'; export type { T } from './t';`,
      errors: reports({
        imports: [
          { source: './a', names: ['*'], typeOnly: false, via: 'reexport' },
          { source: './b', names: ['b'], typeOnly: false, via: 'reexport', exportedAs: 'b' },
          { source: './b', names: ['c'], typeOnly: false, via: 'reexport', exportedAs: 'd' },
          { source: './c', names: ['*'], typeOnly: false, via: 'reexport', exportedAs: 'ns' },
          { source: './t', names: ['T'], typeOnly: true, via: 'reexport', exportedAs: 'T' },
        ],
      }),
    },
    {
      name: 'a dynamic import with a string literal is recorded; a computed one is not',
      filename: 'src/a.ts',
      code: `const a = import('./lazy'); const b = import(path);`,
      errors: reports({
        imports: [{ source: './lazy', names: ['*'], typeOnly: false, via: 'dynamic' }],
      }),
    },
    {
      name: 'vi.mock and vi.doMock are recorded as mocks, including the import() form',
      filename: 'src/a.test.ts',
      code: `vi.mock('@/db/queries'); vi.doMock('./client', () => ({})); vi.mock(import('./auth'));`,
      errors: reports({
        kind: 'test',
        imports: [
          { source: '@/db/queries', names: [], typeOnly: false, via: 'mock' },
          { source: './client', names: [], typeOnly: false, via: 'mock' },
          { source: './auth', names: [], typeOnly: false, via: 'mock' },
        ],
      }),
    },
    {
      name: 'exported declarations are classified as function, type or value',
      filename: 'src/a.ts',
      code: `export function f() {} export const g = () => {}; export const LIMIT = 3; export type T = string; export interface I {} export class C {}`,
      errors: reports({
        exports: [
          { name: 'f', kind: 'function' },
          { name: 'g', kind: 'function' },
          { name: 'LIMIT', kind: 'value' },
          { name: 'T', kind: 'type' },
          { name: 'I', kind: 'type' },
          { name: 'C', kind: 'value' },
        ],
      }),
    },
    {
      name: 'an export list takes the kind of the local declaration',
      filename: 'src/a.ts',
      code: `function f() {} const n = 1; type T = string; export { f, n as count, type T };`,
      errors: reports({
        exports: [
          { name: 'f', kind: 'function' },
          { name: 'count', kind: 'value' },
          { name: 'T', kind: 'type' },
        ],
      }),
    },
    {
      name: 'a default-exported function, also through memo(), is a function export',
      filename: 'src/a.ts',
      code: `const Inner = () => null; export default memo(Inner);`,
      errors: reports({ exports: [{ name: 'default', kind: 'function' }] }),
    },
    {
      name: 'a default-exported object is a value export',
      filename: 'src/a.ts',
      code: `export default { title: 'x' };`,
      errors: reports({ exports: [{ name: 'default', kind: 'value' }] }),
    },
    {
      name: 'JSX, a value import of react and hook calls are recorded',
      filename: 'src/panel.tsx',
      code: `import { useState } from 'react'; export function Panel() { const [a] = useState(0); React.useEffect(() => {}); return <div>{a}</div>; }`,
      errors: reports({
        imports: [{ source: 'react', names: ['useState'], typeOnly: false, via: 'import' }],
        exports: [{ name: 'Panel', kind: 'function' }],
        jsx: true,
        importsReact: true,
        hookCalls: 2,
      }),
    },
    {
      name: 'a type-only import of react does not count as importing react',
      filename: 'src/a.ts',
      code: `import type { ReactNode } from 'react';`,
      errors: reports({
        imports: [{ source: 'react', names: ['ReactNode'], typeOnly: true, via: 'import' }],
      }),
    },
    {
      name: 'a spec file is a test',
      filename: 'src/a.spec.tsx',
      code: ``,
      errors: reports({ kind: 'test' }),
    },
    {
      name: 'play functions in a story file are counted in object, method and assignment forms',
      filename: 'src/button.stories.tsx',
      code: `export const A = { play: async () => {} }; export const B = { play() {} }; export const C = {}; C.play = async () => {};`,
      errors: reports({
        kind: 'story',
        exports: [
          { name: 'A', kind: 'value' },
          { name: 'B', kind: 'value' },
          { name: 'C', kind: 'value' },
        ],
        plays: 3,
      }),
    },
    {
      name: 'a play key outside a story file is not counted',
      filename: 'src/player.ts',
      code: `export const controls = { play: () => {} };`,
      errors: reports({ exports: [{ name: 'controls', kind: 'value' }] }),
    },
  ],
});
