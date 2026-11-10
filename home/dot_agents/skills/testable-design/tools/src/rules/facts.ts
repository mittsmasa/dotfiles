import { isViMockCall, mockSpecifier } from '../ast.ts';
import type {
  ExportFact,
  ExportKind,
  FileFacts,
  FileKind,
  RawImport,
} from '../scan/ir.ts';
import type { AstNode, Rule } from '../types.ts';

const FUNCTION_EXPRESSIONS = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
]);
const TYPE_DECLARATIONS = new Set([
  'TSTypeAliasDeclaration',
  'TSInterfaceDeclaration',
]);
const TYPE_WRAPPERS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
]);
const COMPONENT_WRAPPERS = new Set(['memo', 'forwardRef']);

export function fileKind(filename: string): FileKind {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(filename)) return 'test';
  if (/\.stories\.[cm]?[jt]sx?$/.test(filename)) return 'story';
  return 'source';
}

/** `foo` of `{ foo }`, or the value of a string-literal module export name. */
function moduleExportName(node: AstNode): string {
  return node.type === 'Identifier' ? node.name : String(node.value);
}

function isReactSource(source: string): boolean {
  return /^react(-dom)?(\/|$)/.test(source);
}

/** True for a function expression, also through `memo()` / `forwardRef()` and type wrappers. */
function isFunctionValue(
  node: AstNode | null,
  locals: Map<string, ExportKind>,
): boolean {
  let current = node;
  while (current) {
    if (FUNCTION_EXPRESSIONS.has(current.type)) return true;
    if (TYPE_WRAPPERS.has(current.type)) {
      current = current.expression;
    } else if (current.type === 'CallExpression') {
      const { callee } = current;
      const name =
        callee.type === 'Identifier'
          ? callee.name
          : callee.type === 'MemberExpression' && !callee.computed
            ? callee.property.name
            : null;
      if (!COMPONENT_WRAPPERS.has(name)) return false;
      current = current.arguments[0] ?? null;
    } else if (current.type === 'Identifier') {
      return locals.get(current.name) === 'function';
    } else {
      return false;
    }
  }
  return false;
}

/** Names and kinds introduced by a top-level declaration. */
function declaredNames(
  declaration: AstNode,
  locals: Map<string, ExportKind>,
): ExportFact[] {
  if (declaration.type === 'FunctionDeclaration') {
    return declaration.id
      ? [{ name: declaration.id.name, kind: 'function' }]
      : [];
  }
  if (TYPE_DECLARATIONS.has(declaration.type)) {
    return [{ name: declaration.id.name, kind: 'type' }];
  }
  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations
      .filter((d: AstNode) => d.id.type === 'Identifier')
      .map((d: AstNode) => ({
        name: d.id.name,
        kind: isFunctionValue(d.init, locals) ? 'function' : 'value',
      }));
  }
  return declaration.id ? [{ name: declaration.id.name, kind: 'value' }] : [];
}

function importRecords(node: AstNode): RawImport[] {
  const source: string = node.source.value;
  if (node.specifiers.length === 0) {
    return [{ source, names: [], typeOnly: false, via: 'import' }];
  }
  const values: string[] = [];
  const types: string[] = [];
  for (const specifier of node.specifiers) {
    const name =
      specifier.type === 'ImportDefaultSpecifier'
        ? 'default'
        : specifier.type === 'ImportNamespaceSpecifier'
          ? '*'
          : moduleExportName(specifier.imported);
    const typeOnly = node.importKind === 'type' || specifier.importKind === 'type';
    (typeOnly ? types : values).push(name);
  }
  const records: RawImport[] = [];
  if (values.length > 0) {
    records.push({ source, names: values, typeOnly: false, via: 'import' });
  }
  if (types.length > 0) {
    records.push({ source, names: types, typeOnly: true, via: 'import' });
  }
  return records;
}

function reexportRecords(node: AstNode): RawImport[] {
  const source: string = node.source.value;
  const typeOnly = node.exportKind === 'type';
  if (node.type === 'ExportAllDeclaration') {
    const record: RawImport = { source, names: ['*'], typeOnly, via: 'reexport' };
    if (node.exported) record.exportedAs = moduleExportName(node.exported);
    return [record];
  }
  return node.specifiers.map((specifier: AstNode) => ({
    source,
    names: [moduleExportName(specifier.local)],
    typeOnly: typeOnly || specifier.exportKind === 'type',
    via: 'reexport',
    exportedAs: moduleExportName(specifier.exported),
  }));
}

/** Reads imports, re-exports and exports from the top-level statements. */
function readModuleStatements(
  body: AstNode[],
): Pick<FileFacts, 'imports' | 'exports'> {
  const imports: RawImport[] = [];
  const exports: ExportFact[] = [];
  const locals = new Map<string, ExportKind>();

  for (const statement of body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration'
        ? statement.declaration
        : statement;
    if (declaration && declaration.type !== 'ExportDefaultDeclaration') {
      for (const { name, kind } of declaredNames(declaration, locals)) {
        locals.set(name, kind);
      }
    }
  }

  for (const statement of body) {
    if (statement.type === 'ImportDeclaration') {
      imports.push(...importRecords(statement));
    } else if (statement.type === 'ExportAllDeclaration') {
      imports.push(...reexportRecords(statement));
    } else if (statement.type === 'ExportNamedDeclaration') {
      if (statement.source) {
        imports.push(...reexportRecords(statement));
      } else if (statement.declaration) {
        exports.push(...declaredNames(statement.declaration, locals));
      } else {
        for (const specifier of statement.specifiers) {
          const typeOnly =
            statement.exportKind === 'type' || specifier.exportKind === 'type';
          exports.push({
            name: moduleExportName(specifier.exported),
            kind: typeOnly
              ? 'type'
              : (locals.get(moduleExportName(specifier.local)) ?? 'value'),
          });
        }
      }
    } else if (statement.type === 'ExportDefaultDeclaration') {
      const { declaration } = statement;
      const isFunction =
        declaration.type === 'FunctionDeclaration' ||
        isFunctionValue(declaration, locals);
      exports.push({ name: 'default', kind: isFunction ? 'function' : 'value' });
    }
  }
  return { imports, exports };
}

function isHookCall(node: AstNode): boolean {
  const { callee } = node;
  const name =
    callee.type === 'Identifier'
      ? callee.name
      : callee.type === 'MemberExpression' && !callee.computed
        ? callee.property.name
        : null;
  return typeof name === 'string' && /^use[A-Z0-9]/.test(name);
}

/** `play` as a non-computed object key or member name. */
function isPlayKey(key: AstNode, computed: boolean): boolean {
  return (
    !computed &&
    ((key.type === 'Identifier' && key.name === 'play') ||
      (key.type === 'Literal' && key.value === 'play'))
  );
}

const rule: Rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Reports one diagnostic per file whose message is a JSON record of module facts. Meant to be read by testable-scan, not shown to people.',
    },
    schema: [],
  },
  create(context) {
    const kind = fileKind(context.filename);
    const facts: FileFacts = {
      kind,
      imports: [],
      exports: [],
      jsx: false,
      importsReact: false,
      hookCalls: 0,
      plays: 0,
    };
    const markJsx = (): void => {
      facts.jsx = true;
    };
    return {
      Program(node) {
        Object.assign(facts, readModuleStatements(node.body));
      },
      CallExpression(node) {
        if (isViMockCall(node)) {
          const source = mockSpecifier(node);
          if (source !== null) {
            facts.imports.push({ source, names: [], typeOnly: false, via: 'mock' });
          }
        } else if (isHookCall(node)) {
          facts.hookCalls += 1;
        }
      },
      ImportExpression(node) {
        const { source, parent } = node;
        if (source.type !== 'Literal' || typeof source.value !== 'string') return;
        if (parent.type === 'CallExpression' && isViMockCall(parent)) return;
        facts.imports.push({
          source: source.value,
          names: ['*'],
          typeOnly: false,
          via: 'dynamic',
        });
      },
      JSXElement: markJsx,
      JSXFragment: markJsx,
      Property(node) {
        if (kind === 'story' && isPlayKey(node.key, node.computed)) {
          facts.plays += 1;
        }
      },
      AssignmentExpression(node) {
        const { left } = node;
        if (
          kind === 'story' &&
          left.type === 'MemberExpression' &&
          isPlayKey(left.property, left.computed)
        ) {
          facts.plays += 1;
        }
      },
      'Program:exit'(node) {
        facts.importsReact = facts.imports.some(
          (record) =>
            record.via === 'import' &&
            !record.typeOnly &&
            isReactSource(record.source),
        );
        context.report({ node, message: JSON.stringify(facts) });
      },
    };
  },
};

export default rule;
