import ts from 'typescript';

import { renderUiShellHtml } from '../../../operator-ui/shell.js';

/**
 * Contract view of the operator UI as the browser receives it.
 *
 * Tests read the output of renderUiShellHtml() instead of grepping source
 * files, so they keep checking the browser/backend contract no matter how the
 * shell, page templates and client script are split across modules.
 */
export interface RenderedShell {
  html: string;
  /** Markup before the inline client script. */
  markup: string;
  /** Inline client script text. */
  script: string;
  /** Element ids declared in static markup. */
  elementIds: Set<string>;
  /** `<option value>` list of a static `<select id>`; null when absent. */
  selectOptions(id: string): string[] | null;
  /** Keys of the object literal returned by a top-level client function. */
  returnedObjectKeys(functionName: string): string[];
  /** Map of returned key -> element id read via document.getElementById(id).value|checked. */
  returnedElementBindings(functionName: string): Record<string, string>;
  /** Element ids written via document.getElementById(id).value|checked = ... inside a function. */
  assignedElementIds(functionName: string): string[];
}

let cached: RenderedShell | null = null;

export function renderedShell(): RenderedShell {
  if (cached) return cached;
  const html = renderUiShellHtml();
  const scriptStart = html.indexOf('<script>');
  const scriptEnd = html.lastIndexOf('</script>');
  if (scriptStart < 0 || scriptEnd < scriptStart) throw new Error('rendered shell has no inline client script');
  const markup = html.slice(0, scriptStart);
  const script = html.slice(scriptStart + '<script>'.length, scriptEnd);
  const source = ts.createSourceFile('ui-client.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

  const functions = new Map<string, ts.FunctionDeclaration>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) functions.set(statement.name.text, statement);
  }
  const requireFunction = (name: string) => {
    const fn = functions.get(name);
    if (!fn?.body) throw new Error(`client function ${name}() not found in rendered shell`);
    return fn;
  };

  const elementIdOf = (node: ts.Expression): string | null => {
    // document.getElementById('x').value | .checked
    if (!ts.isPropertyAccessExpression(node)) return null;
    if (node.name.text !== 'value' && node.name.text !== 'checked') return null;
    const call = node.expression;
    if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return null;
    if (call.expression.name.text !== 'getElementById') return null;
    const [arg] = call.arguments;
    return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
  };

  const returnedObject = (name: string): ts.ObjectLiteralExpression => {
    let found: ts.ObjectLiteralExpression | null = null;
    requireFunction(name).body!.statements.forEach((statement) => {
      if (ts.isReturnStatement(statement) && statement.expression && ts.isObjectLiteralExpression(statement.expression)) {
        found = statement.expression;
      }
    });
    if (!found) throw new Error(`client function ${name}() does not return an object literal`);
    return found;
  };

  const propertyName = (property: ts.ObjectLiteralElementLike): string | null => {
    if (!property.name) return null;
    if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) return property.name.text;
    return null;
  };

  const elementIds = new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!));

  cached = {
    html,
    markup,
    script,
    elementIds,
    selectOptions(id) {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const body = markup.match(new RegExp(`<select id="${escaped}"[^>]*>([\\s\\S]*?)</select>`))?.[1];
      if (body === undefined) return null;
      return [...body.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]!);
    },
    returnedObjectKeys(name) {
      return returnedObject(name).properties.map(propertyName).filter((key): key is string => Boolean(key));
    },
    returnedElementBindings(name) {
      const bindings: Record<string, string> = {};
      for (const property of returnedObject(name).properties) {
        const key = propertyName(property);
        if (!key || !ts.isPropertyAssignment(property)) continue;
        const id = elementIdOf(property.initializer);
        if (id) bindings[key] = id;
      }
      return bindings;
    },
    assignedElementIds(name) {
      const ids: string[] = [];
      const visit = (node: ts.Node) => {
        if (
          ts.isBinaryExpression(node)
          && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          const id = elementIdOf(node.left);
          if (id) ids.push(id);
        }
        ts.forEachChild(node, visit);
      };
      visit(requireFunction(name).body!);
      return ids;
    },
  };
  return cached;
}
