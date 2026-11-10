import { isViMockCall } from '../ast.ts';
import type { AstNode, Rule } from '../types.ts';

interface Options {
  max?: number;
}

const rule: Rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Limit the number of vi.mock / vi.doMock calls in a file. Many module mocks suggest the code under test mixes logic with external access.',
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
        'vi.mock / vi.doMock が {{count}} 個あります（{{max}} 個以上で報告）。モックを足す前に、判定ロジックを引数で値を受け取る純粋関数に切り出せないか見直してください。',
    },
  },
  create(context) {
    const max = (context.options[0] as Options | undefined)?.max ?? 3;
    const calls: AstNode[] = [];
    return {
      CallExpression(node) {
        if (isViMockCall(node)) calls.push(node);
      },
      'Program:exit'() {
        if (calls.length >= max) {
          context.report({
            node: calls[0],
            messageId: 'tooMany',
            data: { count: String(calls.length), max: String(max) },
          });
        }
      },
    };
  },
};

export default rule;
