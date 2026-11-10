import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import rule from './no-ambient-nondeterminism.ts';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: 'tsx' } },
});

ruleTester.run('no-ambient-nondeterminism', rule, {
  valid: [
    {
      name: 'a pure function receiving the current time',
      code: `function isOverdue(deadline: Date, now: Date) { return deadline < now; }`,
    },
    {
      name: 'a plain function reading the clock',
      code: `function now() { return Date.now(); }`,
    },
    {
      name: 'new Date with an argument is deterministic',
      code: `function Label({ at }: { at: string }) { return <time>{new Date(at).toISOString()}</time>; }`,
    },
    {
      name: 'a component receiving the current time as a prop',
      code: `function Clock({ now }: { now: Date }) { return <time>{now.toISOString()}</time>; }`,
    },
    {
      name: 'a property named localStorage on another object',
      code: `function Panel({ deps }) { deps.localStorage.getItem('k'); return <div />; }`,
    },
    {
      name: 'an object key named localStorage',
      code: `function Panel() { const names = { localStorage: 'local' }; return <div>{names.localStorage}</div>; }`,
    },
    {
      name: 'reads at module level',
      code: `const startedAt = Date.now(); function Panel() { return <div>{startedAt}</div>; }`,
    },
  ],
  invalid: [
    {
      name: 'Date.now() in a component body',
      code: `function Clock() { const now = Date.now(); return <time>{now}</time>; }`,
      errors: [
        {
          messageId: 'ambient',
          data: {
            kind: 'コンポーネント',
            name: 'Clock',
            where: '本体',
            source: 'Date.now()',
          },
        },
      ],
    },
    {
      name: 'new Date() without arguments in a hook body',
      code: `function useToday() { return new Date(); }`,
      errors: [
        {
          messageId: 'ambient',
          data: {
            kind: 'フック',
            name: 'useToday',
            where: '本体',
            source: 'new Date()',
          },
        },
      ],
    },
    {
      name: 'Math.random() in an event handler is attributed to the component',
      code: `const Dice = () => <button onClick={() => roll(Math.random())} />;`,
      errors: [
        {
          messageId: 'ambient',
          data: {
            kind: 'コンポーネント',
            name: 'Dice',
            where: 'ネストした関数',
            source: 'Math.random()',
          },
        },
      ],
    },
    {
      name: 'crypto.randomUUID() in a hook',
      code: `const useId2 = () => crypto.randomUUID();`,
      errors: [
        {
          messageId: 'ambient',
          data: {
            kind: 'フック',
            name: 'useId2',
            where: '本体',
            source: 'crypto.randomUUID()',
          },
        },
      ],
    },
    {
      name: 'localStorage and window.sessionStorage',
      code: `function useDraft() { const a = localStorage.getItem('a'); const b = window.sessionStorage.getItem('b'); return [a, b]; }`,
      errors: [
        {
          messageId: 'ambient',
          data: {
            kind: 'フック',
            name: 'useDraft',
            where: '本体',
            source: 'localStorage',
          },
        },
        {
          messageId: 'ambient',
          data: {
            kind: 'フック',
            name: 'useDraft',
            where: '本体',
            source: 'sessionStorage',
          },
        },
      ],
    },
    {
      name: 'a read inside an effect callback of a hook',
      code: `function useTick() { useEffect(() => { save(Date.now()); }, []); }`,
      errors: [
        {
          messageId: 'ambient',
          data: {
            kind: 'フック',
            name: 'useTick',
            where: 'ネストした関数',
            source: 'Date.now()',
          },
        },
      ],
    },
  ],
});
