import { createUnitTracker, unitLabel } from '../ast.ts';
import type { AstNode, Rule } from '../types.ts';

const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);

function isFetchCall(node: AstNode): boolean {
  const { callee } = node;
  if (callee.type === 'Identifier') return callee.name === 'fetch';
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.name === 'fetch' &&
    callee.object.type === 'Identifier' &&
    GLOBAL_OBJECTS.has(callee.object.name)
  );
}

const rule: Rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow calling fetch directly inside a React component. Route requests through an API client so they can be replaced at the network layer.',
    },
    schema: [],
    messages: {
      fetch:
        'コンポーネント {{name}} の中で fetch を直接呼んでいます。API クライアントに集めると、通信が一か所を通り、vi.mock なしでネットワーク層（MSW）で差し替えられます。',
    },
  },
  create(context) {
    const tracker = createUnitTracker<{ node: AstNode }>((unit) => {
      if (unit.kind !== 'component') return;
      for (const { node } of unit.findings) {
        context.report({
          node,
          messageId: 'fetch',
          data: { name: unitLabel(unit) },
        });
      }
    });
    return {
      ...tracker.visitors,
      CallExpression(node) {
        if (isFetchCall(node)) tracker.record({ node });
      },
    };
  },
};

export default rule;
