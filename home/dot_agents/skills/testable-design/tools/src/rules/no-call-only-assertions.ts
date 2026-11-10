import { expectMatcherName, isTestCall } from '../ast.ts';
import type { AstNode, Rule } from '../types.ts';

const CALL_MATCHER =
  /^(toHaveBeenCalled|toHaveBeenLastCalled|toHaveBeenNthCalled|toBeCalled|lastCalledWith|nthCalledWith)/;

const rule: Rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow tests whose only assertions verify mock calls. Assert on returned values or resulting state instead.',
    },
    schema: [],
    messages: {
      callOnly:
        'このテストの expect は、呼び出しの検証（{{matchers}}）だけです。内部の協調者への呼び出しは実装詳細なので、戻り値や結果の状態を確かめてください。外部から観測できる相互作用（コールバック props、外部 API）なら、この指摘は当たりません。',
    },
  },
  create(context) {
    const stack: { node: AstNode; matchers: string[] }[] = [];
    return {
      CallExpression(node) {
        if (isTestCall(node)) {
          stack.push({ node, matchers: [] });
          return;
        }
        const matcher = expectMatcherName(node);
        if (matcher !== null) stack.at(-1)?.matchers.push(matcher);
      },
      'CallExpression:exit'(node) {
        if (stack.at(-1)?.node !== node) return;
        const { matchers } = stack.pop()!;
        if (matchers.length === 0) return;
        if (!matchers.every((name) => CALL_MATCHER.test(name))) return;
        context.report({
          node: node.callee,
          messageId: 'callOnly',
          data: { matchers: [...new Set(matchers)].join(', ') },
        });
      },
    };
  },
};

export default rule;
