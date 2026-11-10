import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import rule from './max-module-mocks.ts';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: 'ts' } },
});

ruleTester.run('max-module-mocks', rule, {
  valid: [
    {
      name: 'two mocks stay below the default limit of three',
      code: `vi.mock('a'); vi.mock('b');`,
    },
    {
      name: 'other vi methods are not counted',
      code: `vi.spyOn(a, 'b'); vi.fn(); vi.stubGlobal('c', 1); vi.mock('a');`,
    },
    {
      name: 'mock methods on other objects are not counted',
      code: `jest.mock('a'); jest.mock('b'); jest.mock('c');`,
    },
    {
      name: 'a raised limit allows three mocks',
      code: `vi.mock('a'); vi.mock('b'); vi.mock('c');`,
      options: [{ max: 4 }],
    },
  ],
  invalid: [
    {
      name: 'three mocks reach the default limit and are reported once',
      code: `vi.mock('a'); vi.mock('b'); vi.mock('c');`,
      errors: [{ messageId: 'tooMany', data: { count: '3', max: '3' } }],
    },
    {
      name: 'vi.doMock is counted together with vi.mock',
      code: `vi.mock('a'); vi.doMock('b'); vi.doMock('c'); vi.mock('d');`,
      errors: [{ messageId: 'tooMany', data: { count: '4', max: '3' } }],
    },
    {
      name: 'a lowered limit reports two mocks',
      code: `vi.mock('a'); vi.mock('b');`,
      options: [{ max: 2 }],
      errors: [{ messageId: 'tooMany', data: { count: '2', max: '2' } }],
    },
  ],
});
