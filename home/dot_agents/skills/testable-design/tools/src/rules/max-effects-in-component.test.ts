import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import rule from './max-effects-in-component.ts';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: 'tsx' } },
});

ruleTester.run('max-effects-in-component', rule, {
  valid: [
    {
      name: 'two effects stay below the default limit of three',
      code: `function Panel() { useEffect(() => {}, []); useEffect(() => {}, []); return <div />; }`,
    },
    {
      name: 'effects inside a custom hook are not counted',
      code: `function usePanel() { useEffect(() => {}, []); useEffect(() => {}, []); useLayoutEffect(() => {}, []); }`,
    },
    {
      name: 'effects are counted per component',
      code: `function A() { useEffect(() => {}, []); return <div />; } function B() { useEffect(() => {}, []); return <div />; }`,
    },
    {
      name: 'a raised limit allows three effects',
      code: `function Panel() { useEffect(() => {}, []); useEffect(() => {}, []); useEffect(() => {}, []); return <div />; }`,
      options: [{ max: 4 }],
    },
    {
      name: 'other hooks are not counted',
      code: `function Panel() { useMemo(() => 1, []); useCallback(() => {}, []); useEffect(() => {}, []); return <div />; }`,
    },
  ],
  invalid: [
    {
      name: 'useLayoutEffect and React.useEffect are counted together up to the default limit',
      code: `const Panel = () => { useLayoutEffect(() => {}, []); React.useEffect(() => {}, []); useEffect(() => {}, []); return <div />; };`,
      errors: [
        { messageId: 'tooMany', data: { name: 'Panel', count: '3', max: '3' } },
      ],
    },
    {
      name: 'a lowered limit reports a single effect',
      code: `function Panel() { useEffect(() => {}, []); return <div />; }`,
      options: [{ max: 1 }],
      errors: [
        { messageId: 'tooMany', data: { name: 'Panel', count: '1', max: '1' } },
      ],
    },
    {
      name: 'only the component over the limit is reported',
      code: `function A() { useEffect(() => {}, []); return <div />; } function B() { useEffect(() => {}, []); useEffect(() => {}, []); useEffect(() => {}, []); return <div />; }`,
      errors: [{ messageId: 'tooMany', data: { name: 'B', count: '3', max: '3' } }],
    },
  ],
});
