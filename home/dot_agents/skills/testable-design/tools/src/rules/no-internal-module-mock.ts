import { isInternalSpecifier, isViMockCall, mockSpecifier } from '../ast.ts';
import type { Rule } from '../types.ts';

interface Options {
  aliases?: string[];
  allow?: string[];
}

const rule: Rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow vi.mock / vi.doMock of modules owned by this project. Mock only unmanaged dependencies and the network layer.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          aliases: { type: 'array', items: { type: 'string' } },
          allow: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      internal:
        "自前のモジュール '{{specifier}}' を vi.mock しています。モックは管理外の依存（外部 API など）とネットワーク層に限り、内側のロジックは引数で値を受け取る形に切り出してください。",
    },
  },
  create(context) {
    const { aliases = ['@/'], allow = [] } =
      (context.options[0] as Options | undefined) ?? {};
    const allowed = new Set(allow);
    return {
      CallExpression(node) {
        if (!isViMockCall(node)) return;
        const specifier = mockSpecifier(node);
        if (specifier === null || allowed.has(specifier)) return;
        if (isInternalSpecifier(specifier, aliases)) {
          context.report({
            node: node.arguments[0],
            messageId: 'internal',
            data: { specifier },
          });
        }
      },
    };
  },
};

export default rule;
