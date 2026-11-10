import { createUnitTracker, unitLabel } from '../ast.ts';
import type { AstNode, Rule } from '../types.ts';

const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);
const STORAGES = new Set(['localStorage', 'sessionStorage']);
const STATIC_CALLS = new Set(['Date.now', 'Math.random', 'crypto.randomUUID']);

/** `Date.now` style name of a non-computed `Identifier.Identifier` callee. */
function staticCallName(callee: AstNode): string | null {
  if (
    callee.type !== 'MemberExpression' ||
    callee.computed ||
    callee.object.type !== 'Identifier'
  ) {
    return null;
  }
  return `${callee.object.name}.${callee.property.name}`;
}

/** True when the identifier reads the global, not a property of the same name. */
function isGlobalReference(node: AstNode): boolean {
  const { parent } = node;
  if (parent.type === 'MemberExpression' && parent.property === node) {
    return (
      !parent.computed &&
      parent.object.type === 'Identifier' &&
      GLOBAL_OBJECTS.has(parent.object.name)
    );
  }
  if (parent.type === 'Property' && parent.key === node && !parent.computed) {
    return false;
  }
  return true;
}

const rule: Rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow reading the current time, random values, and web storage directly inside React components and hooks. Receive them as arguments or props.',
    },
    schema: [],
    messages: {
      ambient:
        '{{kind}} {{name}} の{{where}}で {{source}} を直接読んでいます。現在時刻、乱数、ストレージは引数か props で受け取ると、グローバルを差し替えずにテストできます。',
    },
  },
  create(context) {
    const tracker = createUnitTracker<{ node: AstNode; source: string }>((unit) => {
      for (const { node, source, nested } of unit.findings) {
        context.report({
          node,
          messageId: 'ambient',
          data: {
            kind: unit.kind === 'component' ? 'コンポーネント' : 'フック',
            name: unitLabel(unit),
            where: nested ? 'ネストした関数' : '本体',
            source,
          },
        });
      }
    });
    return {
      ...tracker.visitors,
      CallExpression(node) {
        const name = staticCallName(node.callee);
        if (name !== null && STATIC_CALLS.has(name)) {
          tracker.record({ node, source: `${name}()` });
        }
      },
      NewExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'Date' &&
          node.arguments.length === 0
        ) {
          tracker.record({ node, source: 'new Date()' });
        }
      },
      Identifier(node) {
        if (STORAGES.has(node.name) && isGlobalReference(node)) {
          tracker.record({ node, source: node.name });
        }
      },
    };
  },
};

export default rule;
