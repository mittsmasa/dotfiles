import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import rule from './no-internal-module-spy.ts';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: 'ts' } },
});

ruleTester.run('no-internal-module-spy', rule, {
  valid: [
    { name: 'a global object is not imported', code: `vi.spyOn(window, 'open');` },
    {
      name: 'a package import is not internal',
      code: `import { toast } from '@partner-prop/prysm-react'; vi.spyOn(toast, 'error');`,
    },
    {
      name: 'a type-only import declaration is skipped',
      code: `import type { Api } from './api'; vi.spyOn(Api, 'get');`,
    },
    {
      name: 'a type-only specifier is skipped',
      code: `import { type Api, load } from './api'; vi.spyOn(Api, 'get');`,
    },
    {
      name: 'a specifier in the allow list is skipped',
      code: `import { auth } from '@/lib/auth'; vi.spyOn(auth, 'currentUser');`,
      options: [{ allow: ['@/lib/auth'] }],
    },
    {
      name: 'a baseUrl-style specifier needs an alias',
      code: `import { ax } from 'utils/axios'; vi.spyOn(ax, 'get');`,
    },
    {
      name: 'a non-identifier target is skipped',
      code: `import * as mod from './mod'; vi.spyOn(getTarget(), 'run');`,
    },
    {
      name: 'other vi methods are not spyOn',
      code: `import { run } from './mod'; vi.fn(run);`,
    },
  ],
  invalid: [
    {
      name: 'a namespace import',
      code: `import * as queries from './queries'; vi.spyOn(queries, 'find');`,
      errors: [{ messageId: 'internal', data: { specifier: './queries', name: 'queries' } }],
    },
    {
      name: 'a default import',
      code: `import client from '../client'; vi.spyOn(client, 'post');`,
      errors: [{ messageId: 'internal', data: { specifier: '../client', name: 'client' } }],
    },
    {
      name: 'a named import through the default alias',
      code: `import { api } from '@/lib/api'; vi.spyOn(api, 'get');`,
      errors: [{ messageId: 'internal', data: { specifier: '@/lib/api', name: 'api' } }],
    },
    {
      name: 'a member of a namespace import such as mod.default',
      code: `import * as mod from './mod'; vi.spyOn(mod.default, 'run');`,
      errors: [{ messageId: 'internal', data: { specifier: './mod', name: 'mod' } }],
    },
    {
      name: 'a nested member such as api.client',
      code: `import { api } from './api'; vi.spyOn(api.client, 'get');`,
      errors: [{ messageId: 'internal', data: { specifier: './api', name: 'api' } }],
    },
    {
      name: 'a baseUrl-style specifier matching a configured alias',
      code: `import { ax } from 'utils/axios'; vi.spyOn(ax, 'get');`,
      options: [{ aliases: ['utils/'] }],
      errors: [{ messageId: 'internal', data: { specifier: 'utils/axios', name: 'ax' } }],
    },
    {
      name: 'a local variable shadowing an import is not distinguished',
      code: `import { api } from './api'; it('x', () => { const api = { get() {} }; vi.spyOn(api, 'get'); });`,
      errors: [{ messageId: 'internal', data: { specifier: './api', name: 'api' } }],
    },
  ],
});
