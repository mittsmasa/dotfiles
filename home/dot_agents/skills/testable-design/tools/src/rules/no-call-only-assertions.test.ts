import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import rule from './no-call-only-assertions.ts';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: 'ts' } },
});

ruleTester.run('no-call-only-assertions', rule, {
  valid: [
    {
      name: 'a test asserting on a value',
      code: `it('adds', () => { expect(add(1, 2)).toBe(3); });`,
    },
    {
      name: 'a call assertion next to a value assertion',
      code: `it('saves', () => { expect(save).toHaveBeenCalled(); expect(result).toEqual({ ok: true }); });`,
    },
    {
      name: 'a test without assertions is left to other rules',
      code: `it('renders', () => { render(); });`,
    },
    {
      name: 'asymmetric matchers are not assertions',
      code: `it('adds', () => { expect(value).toEqual(expect.any(Number)); });`,
    },
    {
      name: 'a locator assertion is a value assertion',
      code: `test('shows', async () => { await expect.element(button).toBeVisible(); });`,
    },
    {
      name: 'call assertions outside a test are ignored',
      code: `afterEach(() => { expect(cleanup).toHaveBeenCalled(); });`,
    },
    {
      name: 'it.todo has no test function',
      code: `it.todo('later');`,
    },
  ],
  invalid: [
    {
      name: 'a single call assertion',
      code: `it('calls save', () => { expect(save).toHaveBeenCalled(); });`,
      errors: [{ messageId: 'callOnly', data: { matchers: 'toHaveBeenCalled' } }],
    },
    {
      name: 'several call matchers, negated and awaited',
      code: `test('calls', async () => { expect(a).toHaveBeenCalledWith(1); expect(b).not.toHaveBeenCalled(); expect(a).toHaveBeenCalledTimes(1); });`,
      errors: [
        {
          messageId: 'callOnly',
          data: {
            matchers:
              'toHaveBeenCalledWith, toHaveBeenCalled, toHaveBeenCalledTimes',
          },
        },
      ],
    },
    {
      name: 'an asymmetric matcher argument does not count as a value assertion',
      code: `it('calls', () => { expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 1 })); });`,
      errors: [
        { messageId: 'callOnly', data: { matchers: 'toHaveBeenCalledWith' } },
      ],
    },
    {
      name: 'modifier forms are tests',
      code: `it.only('calls', () => { expect(save).toHaveBeenLastCalledWith(1); });`,
      errors: [
        { messageId: 'callOnly', data: { matchers: 'toHaveBeenLastCalledWith' } },
      ],
    },
    {
      name: 'a table test is a test',
      code: `test.each([1, 2])('calls %i', (n) => { expect(save).toHaveBeenNthCalledWith(n, 1); });`,
      errors: [
        { messageId: 'callOnly', data: { matchers: 'toHaveBeenNthCalledWith' } },
      ],
    },
    {
      name: 'assertions inside a nested callback belong to the test',
      code: `it('calls', async () => { await waitFor(() => { expect(save).toHaveBeenCalled(); }); });`,
      errors: [{ messageId: 'callOnly', data: { matchers: 'toHaveBeenCalled' } }],
    },
    {
      name: 'only the call-only test in a file is reported',
      code: `it('adds', () => { expect(add(1, 2)).toBe(3); }); it('calls', () => { expect(save).toBeCalled(); });`,
      errors: [{ messageId: 'callOnly', data: { matchers: 'toBeCalled' } }],
    },
  ],
});
