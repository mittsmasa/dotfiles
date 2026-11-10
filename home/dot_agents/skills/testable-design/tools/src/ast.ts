import type { AstNode, Visitor } from './types.ts';

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

const COMPONENT_WRAPPERS = new Set(['memo', 'forwardRef']);

export type UnitKind = 'component' | 'hook';

interface ResolvedName {
  nameNode: AstNode | null;
  anonymousDefault: boolean;
}

interface Frame<F> extends ResolvedName {
  node: AstNode;
  hasJsx: boolean;
  findings: (F & { nested: boolean })[];
}

export interface Unit<F> extends Frame<F> {
  kind: UnitKind;
}

/** `foo.bar` (non-computed) -> 'bar' */
function propertyName(member: AstNode): string | null {
  return !member.computed && member.property.type === 'Identifier'
    ? member.property.name
    : null;
}

/** Matches `name(...)` and `<anything>.name(...)` callee shapes. */
function calleeName(callee: AstNode): string | null {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression') return propertyName(callee);
  return null;
}

/** `vi.mock(...)` / `vi.doMock(...)` */
export function isViMockCall(node: AstNode): boolean {
  const { callee } = node;
  if (callee.type !== 'MemberExpression') return false;
  if (callee.object.type !== 'Identifier' || callee.object.name !== 'vi') {
    return false;
  }
  const name = propertyName(callee);
  return name === 'mock' || name === 'doMock';
}

/**
 * Module specifier passed to `vi.mock`: a string, a template without
 * expressions, or `import('...')`. Returns null when it is not static.
 */
export function mockSpecifier(node: AstNode): string | null {
  const arg = node.arguments[0];
  if (!arg) return null;
  if (arg.type === 'Literal' && typeof arg.value === 'string') return arg.value;
  if (arg.type === 'TemplateLiteral' && arg.expressions.length === 0) {
    return arg.quasis[0].value.cooked;
  }
  if (arg.type === 'ImportExpression') {
    const { source } = arg;
    if (source.type === 'Literal' && typeof source.value === 'string') {
      return source.value;
    }
  }
  return null;
}

/**
 * `it(...)`, `test(...)`, and modifier forms such as `it.only(...)`,
 * `test.each(table)(...)`, `it.each`...``(...)`. Only calls that receive a
 * function are tests (`it.todo('x')` and the inner `it.each(table)` are not).
 */
export function isTestCall(node: AstNode): boolean {
  if (!node.arguments.some((arg: AstNode) => FUNCTION_TYPES.has(arg.type))) return false;
  let root = node.callee;
  while (root.type !== 'Identifier') {
    if (root.type === 'MemberExpression') root = root.object;
    else if (root.type === 'CallExpression') root = root.callee;
    else if (root.type === 'TaggedTemplateExpression') root = root.tag;
    else return false;
  }
  return root.name === 'it' || root.name === 'test';
}

/**
 * Matcher name of an assertion call such as `expect(x).not.toBe(1)` or
 * `expect.element(locator).toBeVisible()`. Returns null for anything else,
 * including asymmetric matchers like `expect.any(String)`.
 */
export function expectMatcherName(node: AstNode): string | null {
  if (node.callee.type !== 'MemberExpression') return null;
  let root = node.callee.object;
  let sawCall = false;
  while (root.type !== 'Identifier') {
    if (root.type === 'MemberExpression') root = root.object;
    else if (root.type === 'CallExpression') {
      sawCall = true;
      root = root.callee;
    } else return null;
  }
  if (root.name !== 'expect' || !sawCall) return null;
  return propertyName(node.callee);
}

/** `useEffect(...)` / `React.useLayoutEffect(...)` */
export function isEffectCall(node: AstNode): boolean {
  const name = calleeName(node.callee);
  return name === 'useEffect' || name === 'useLayoutEffect';
}

/**
 * Resolves the name a function is known by.
 * - `function Foo() {}` / `function Foo() {}` expression: own id
 * - `const Foo = () => {}`: the variable
 * - `const Foo = memo(forwardRef(() => {}))`: wrappers are peeled first
 * - `export default function () {}` / `export default () => {}`: anonymous default
 */
function resolveName(node: AstNode): ResolvedName {
  if (node.id) return { nameNode: node.id, anonymousDefault: false };
  let parent: AstNode | undefined = node.parent;
  let child = node;
  while (
    parent?.type === 'CallExpression' &&
    parent.arguments[0] === child &&
    COMPONENT_WRAPPERS.has(calleeName(parent.callee) ?? '')
  ) {
    child = parent;
    parent = parent.parent;
  }
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
    return { nameNode: parent.id, anonymousDefault: false };
  }
  return {
    nameNode: null,
    anonymousDefault: parent?.type === 'ExportDefaultDeclaration',
  };
}

function classify(frame: Frame<unknown>): UnitKind | null {
  const name = frame.nameNode?.name;
  if (name && /^use[A-Z0-9]/.test(name)) return 'hook';
  const componentLike = name ? /^[A-Z]/.test(name) : frame.anonymousDefault;
  return componentLike && frame.hasJsx ? 'component' : null;
}

/**
 * Tracks React components and hooks ("units") while traversing a file.
 *
 * Type information is unavailable, so units are decided by syntax and naming:
 * a hook is a function named `useXxx`; a component is a function with a
 * capitalized name (or an anonymous default export) that contains JSX.
 *
 * Findings recorded inside a nested non-unit function (an event handler, a
 * callback) are attributed to the nearest enclosing unit with `nested: true`.
 * Findings outside any unit are dropped.
 *
 */
export function createUnitTracker<F extends { node: AstNode }>(
  onUnitExit: (unit: Unit<F>) => void,
): { record(finding: F): void; visitors: Visitor } {
  const stack: Frame<F>[] = [];

  function enter(node: AstNode): void {
    stack.push({ node, ...resolveName(node), hasJsx: false, findings: [] });
  }

  function exit(): void {
    const frame = stack.pop();
    if (!frame) return;
    const kind = classify(frame);
    if (kind) {
      onUnitExit({ ...frame, kind });
      return;
    }
    const parent = stack.at(-1);
    if (parent) {
      for (const finding of frame.findings) {
        parent.findings.push({ ...finding, nested: true });
      }
    }
  }

  function markJsx(): void {
    for (const frame of stack) frame.hasJsx = true;
  }

  return {
    record(finding: F): void {
      stack.at(-1)?.findings.push({ ...finding, nested: false });
    },
    visitors: {
      FunctionDeclaration: enter,
      FunctionExpression: enter,
      ArrowFunctionExpression: enter,
      'FunctionDeclaration:exit': exit,
      'FunctionExpression:exit': exit,
      'ArrowFunctionExpression:exit': exit,
      JSXElement: markJsx,
      JSXFragment: markJsx,
    },
  };
}

/** Display name of a unit for messages. */
export function unitLabel(unit: { nameNode: AstNode | null }): string {
  return unit.nameNode?.name ?? '(default export)';
}
