/**
 * Minimal types for an ESLint-compatible plugin.
 *
 * oxlint 1.89.0 does not export plugin types, and a runtime dependency on a
 * types package would require node_modules next to the plugin. Only the parts
 * of the API that the rules use are declared here.
 */

/** ESTree-like node. Rules narrow on `type` and read the fields they need. */
export interface AstNode {
  type: string;
  parent: AstNode;
  range: [number, number];
  // oxlint-disable-next-line typescript/no-explicit-any
  [key: string]: any;
}

export type ReportDescriptor =
  | { node: AstNode; messageId: string; data?: Record<string, string> }
  | { node: AstNode; message: string };

export interface RuleContext {
  filename: string;
  /** Values after the severity in the rule's config entry. */
  options: readonly unknown[];
  report(descriptor: ReportDescriptor): void;
}

/**
 * Handlers receive oxlint's own node types, which are not exported. The
 * parameter is left open here; helpers that take a node declare `AstNode`.
 */
// oxlint-disable-next-line typescript/no-explicit-any
export type Visitor = Record<string, (node: any) => void>;

export interface Rule {
  meta: {
    type?: 'problem' | 'suggestion' | 'layout';
    docs?: { description: string };
    schema?: unknown[];
    messages?: Record<string, string>;
  };
  create(context: RuleContext): Visitor;
}

export interface Plugin {
  meta: { name: string };
  rules: Record<string, Rule>;
}
