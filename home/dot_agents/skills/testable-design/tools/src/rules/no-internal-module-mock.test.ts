import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import rule from './no-internal-module-mock.ts';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: 'ts' } },
});

ruleTester.run('no-internal-module-mock', rule, {
  valid: [
    { name: 'a package is not internal', code: `vi.mock('next/navigation');` },
    { name: 'a scoped package is not internal', code: `vi.mock('@urql/next');` },
    {
      name: 'a specifier in the allow list is skipped',
      code: `vi.mock('@/lib/auth');`,
      options: [{ allow: ['@/lib/auth'] }],
    },
    {
      name: 'the default alias is replaced by the aliases option',
      code: `vi.mock('@/db/queries');`,
      options: [{ aliases: ['~/'] }],
    },
    {
      name: 'a non-static specifier is skipped',
      code: 'vi.mock(modulePath); vi.mock(`${base}/queries`);',
    },
    { name: 'vi.mock without arguments is skipped', code: `vi.mock();` },
  ],
  invalid: [
    {
      name: 'a relative path is internal',
      code: `vi.mock('./queries');`,
      errors: [{ messageId: 'internal', data: { specifier: './queries' } }],
    },
    {
      name: 'a parent-relative path is internal',
      code: `vi.mock('../db/queries', () => ({ find: vi.fn() }));`,
      errors: [{ messageId: 'internal', data: { specifier: '../db/queries' } }],
    },
    {
      name: 'the default alias @/ is internal',
      code: `vi.mock('@/db/queries');`,
      errors: [{ messageId: 'internal', data: { specifier: '@/db/queries' } }],
    },
    {
      name: 'vi.doMock is checked',
      code: `vi.doMock('@/db/queries');`,
      errors: [{ messageId: 'internal', data: { specifier: '@/db/queries' } }],
    },
    {
      name: 'an import() specifier is checked',
      code: `vi.mock(import('./queries'));`,
      errors: [{ messageId: 'internal', data: { specifier: './queries' } }],
    },
    {
      name: 'a template literal without expressions is checked',
      code: 'vi.mock(`./queries`);',
      errors: [{ messageId: 'internal', data: { specifier: './queries' } }],
    },
    {
      name: 'a custom alias is internal',
      code: `vi.mock('~/db/queries');`,
      options: [{ aliases: ['~/'] }],
      errors: [{ messageId: 'internal', data: { specifier: '~/db/queries' } }],
    },
    {
      name: 'each internal mock is reported',
      code: `vi.mock('./a'); vi.mock('next/cache'); vi.mock('@/b');`,
      errors: [
        { messageId: 'internal', data: { specifier: './a' } },
        { messageId: 'internal', data: { specifier: '@/b' } },
      ],
    },
  ],
});
