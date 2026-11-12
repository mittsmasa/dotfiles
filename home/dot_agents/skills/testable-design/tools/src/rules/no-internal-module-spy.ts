import { isInternalSpecifier } from '../ast.ts';
import type { AstNode, Rule } from '../types.ts';

interface Options {
  aliases?: string[];
  allow?: string[];
}

/** `vi.spyOn(...)` */
function isViSpyOnCall(node: AstNode): boolean {
  const { callee } = node;
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'vi' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'spyOn'
  );
}

/** `mod` for `mod`, `mod.default`, `api.client.http`; null otherwise. */
function rootIdentifier(node: AstNode | undefined): string | null {
  let current = node;
  while (current?.type === 'MemberExpression') current = current.object;
  return current?.type === 'Identifier' ? current.name : null;
}

const rule: Rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow vi.spyOn on objects imported from modules owned by this project. Mock only unmanaged dependencies and the network layer.',
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
        "自前のモジュール '{{specifier}}' から import した {{name}} を vi.spyOn しています。モックは管理外の依存（外部 API など）とネットワーク層に限り、内側のロジックは引数で値を受け取る形に切り出してください。",
    },
  },
  create(context) {
    const { aliases = ['@/'], allow = [] } =
      (context.options[0] as Options | undefined) ?? {};
    const allowed = new Set(allow);
    // Local binding name -> specifier. Top-level imports only; a local
    // variable that shadows an imported name is not distinguished.
    const bindings = new Map<string, string>();
    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type') return;
        const specifier = node.source.value;
        if (typeof specifier !== 'string' || allowed.has(specifier)) return;
        if (!isInternalSpecifier(specifier, aliases)) return;
        for (const spec of node.specifiers) {
          if (spec.importKind === 'type') continue;
          bindings.set(spec.local.name, specifier);
        }
      },
      CallExpression(node) {
        if (!isViSpyOnCall(node)) return;
        const name = rootIdentifier(node.arguments[0]);
        const specifier = name === null ? undefined : bindings.get(name);
        if (specifier === undefined) return;
        context.report({
          node: node.arguments[0],
          messageId: 'internal',
          data: { specifier, name: name! },
        });
      },
    };
  },
};

export default rule;
