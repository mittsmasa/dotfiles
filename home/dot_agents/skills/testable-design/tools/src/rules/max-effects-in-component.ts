import { createUnitTracker, isEffectCall, unitLabel } from '../ast.ts';
import type { AstNode, Rule } from '../types.ts';

interface Options {
  max?: number;
}

const rule: Rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Limit the number of useEffect / useLayoutEffect calls written directly in a React component. Effects inside custom hooks are not counted.',
    },
    schema: [
      {
        type: 'object',
        properties: { max: { type: 'integer', minimum: 1 } },
        additionalProperties: false,
      },
    ],
    messages: {
      tooMany:
        'コンポーネント {{name}} の本体に useEffect / useLayoutEffect が {{count}} 個あります（{{max}} 個以上で報告）。副作用は関心事ごとにカスタムフックへ閉じ込め、props や state から計算できる値はレンダー中に計算してください。',
    },
  },
  create(context) {
    const max = (context.options[0] as Options | undefined)?.max ?? 3;
    const tracker = createUnitTracker<{ node: AstNode }>((unit) => {
      if (unit.kind !== 'component' || unit.findings.length < max) return;
      context.report({
        node: unit.nameNode ?? unit.findings[0].node,
        messageId: 'tooMany',
        data: {
          name: unitLabel(unit),
          count: String(unit.findings.length),
          max: String(max),
        },
      });
    });
    return {
      ...tracker.visitors,
      CallExpression(node) {
        if (isEffectCall(node)) tracker.record({ node });
      },
    };
  },
};

export default rule;
