import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import rule from './no-fetch-in-component.ts';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: 'tsx' } },
});

ruleTester.run('no-fetch-in-component', rule, {
  valid: [
    {
      name: 'fetch in a plain function',
      code: `async function getUser(id: string) { return fetch('/users/' + id); }`,
    },
    {
      name: 'fetch in a capitalized function without JSX',
      code: `async function LoadUser() { return fetch('/user'); }`,
    },
    {
      name: 'fetch in a hook is out of scope for this rule',
      code: `function useUser() { useEffect(() => { fetch('/user'); }, []); }`,
    },
    {
      name: 'a component calling an API client',
      code: `function User() { const load = () => api.fetch('/user'); return <button onClick={load} />; }`,
    },
    {
      name: 'fetch at module level',
      code: `const promise = fetch('/user'); function User() { return <div />; }`,
    },
    {
      name: 'a lowercase function returning JSX is not treated as a component',
      code: `function renderUser() { fetch('/user'); return <div />; }`,
    },
  ],
  invalid: [
    {
      name: 'a function declaration component',
      code: `function User() { fetch('/user'); return <div />; }`,
      errors: [{ messageId: 'fetch', data: { name: 'User' } }],
    },
    {
      name: 'an arrow function component, fetch in an effect',
      code: `const User = () => { useEffect(() => { fetch('/user'); }, []); return <div />; };`,
      errors: [{ messageId: 'fetch', data: { name: 'User' } }],
    },
    {
      name: 'a function expression component, fetch in an event handler',
      code: `const User = function () { return <button onClick={() => fetch('/user')} />; };`,
      errors: [{ messageId: 'fetch', data: { name: 'User' } }],
    },
    {
      name: 'a memo component',
      code: `const User = memo(() => { fetch('/user'); return <div />; });`,
      errors: [{ messageId: 'fetch', data: { name: 'User' } }],
    },
    {
      name: 'a React.forwardRef component',
      code: `const User = React.forwardRef((props, ref) => { fetch('/user'); return <div ref={ref} />; });`,
      errors: [{ messageId: 'fetch', data: { name: 'User' } }],
    },
    {
      name: 'a memo(forwardRef()) component',
      code: `const User = memo(forwardRef((props, ref) => { fetch('/user'); return <div ref={ref} />; }));`,
      errors: [{ messageId: 'fetch', data: { name: 'User' } }],
    },
    {
      name: 'an anonymous default export function',
      code: `export default function () { fetch('/user'); return <div />; }`,
      errors: [{ messageId: 'fetch', data: { name: '(default export)' } }],
    },
    {
      name: 'an anonymous default export arrow function',
      code: `export default () => { fetch('/user'); return <></>; };`,
      errors: [{ messageId: 'fetch', data: { name: '(default export)' } }],
    },
    {
      name: 'window.fetch and globalThis.fetch',
      code: `function User() { window.fetch('/a'); globalThis.fetch('/b'); return <div />; }`,
      errors: [
        { messageId: 'fetch', data: { name: 'User' } },
        { messageId: 'fetch', data: { name: 'User' } },
      ],
    },
    {
      name: 'an async server component',
      code: `export default async function Page() { const res = await fetch('/user'); return <div>{res.status}</div>; }`,
      errors: [{ messageId: 'fetch', data: { name: 'Page' } }],
    },
  ],
});
