import { parse, type Node } from 'acorn';

import type { CodexToolDetail } from '../../../domain/progress.js';
import { buildCodexToolDetailFromInput } from '../../../shared/progress/tool-call-details.js';

export interface NormalizedCodexToolSubcall {
  name: string;
  input: unknown;
  inputResolved: boolean;
}

export interface NormalizedCodexToolCall {
  name: string;
  input: unknown;
  subcalls?: NormalizedCodexToolSubcall[];
}

type AstNode = Node & Record<string, unknown>;

const ORCHESTRATOR_TOOL_NAMES = new Set(['exec', 'functions__exec', 'functions.exec']);
const UNRESOLVED = Symbol('unresolved');

function astNode(value: unknown): AstNode | null {
  if (!value || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string') return null;
  return value as AstNode;
}

function identifierName(value: unknown): string {
  const node = astNode(value);
  return node?.type === 'Identifier' && typeof node.name === 'string' ? node.name : '';
}

function propertyKey(node: AstNode): string | null {
  if (node.computed === true) return null;
  const key = astNode(node.key);
  if (!key) return null;
  if (key.type === 'Identifier' && typeof key.name === 'string') return key.name;
  if (key.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number')) {
    return String(key.value);
  }
  return null;
}

function evaluateStatic(nodeValue: unknown, bindings: Map<string, unknown>): unknown | typeof UNRESOLVED {
  const node = astNode(nodeValue);
  if (!node) return UNRESOLVED;

  if (node.type === 'Literal') {
    if (typeof node.regex !== 'undefined') return UNRESOLVED;
    return node.value;
  }
  if (node.type === 'TemplateLiteral') {
    const expressions = Array.isArray(node.expressions) ? node.expressions : [];
    const quasis = Array.isArray(node.quasis) ? node.quasis : [];
    if (expressions.length > 0 || quasis.length !== 1) return UNRESOLVED;
    const quasi = astNode(quasis[0]);
    const value = quasi?.value;
    if (!value || typeof value !== 'object') return UNRESOLVED;
    const cooked = (value as { cooked?: unknown }).cooked;
    const raw = (value as { raw?: unknown }).raw;
    return typeof cooked === 'string' ? cooked : typeof raw === 'string' ? raw : UNRESOLVED;
  }
  if (node.type === 'Identifier') {
    const name = identifierName(node);
    return bindings.has(name) ? bindings.get(name) : UNRESOLVED;
  }
  if (node.type === 'ArrayExpression') {
    const elements = Array.isArray(node.elements) ? node.elements : [];
    const result: unknown[] = [];
    for (const element of elements) {
      if (element == null) return UNRESOLVED;
      const value = evaluateStatic(element, bindings);
      if (value === UNRESOLVED) return UNRESOLVED;
      result.push(value);
    }
    return result;
  }
  if (node.type === 'ObjectExpression') {
    const properties = Array.isArray(node.properties) ? node.properties : [];
    const result: Record<string, unknown> = {};
    for (const propertyValue of properties) {
      const property = astNode(propertyValue);
      if (!property || property.type !== 'Property' || property.kind !== 'init' || property.method === true) {
        return UNRESOLVED;
      }
      const key = propertyKey(property);
      const value = evaluateStatic(property.value, bindings);
      if (key == null || value === UNRESOLVED) return UNRESOLVED;
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  if (node.type === 'UnaryExpression') {
    const value = evaluateStatic(node.argument, bindings);
    if (value === UNRESOLVED) return UNRESOLVED;
    switch (node.operator) {
      case '-': return typeof value === 'number' ? -value : UNRESOLVED;
      case '+': return typeof value === 'number' ? value : UNRESOLVED;
      case '!': return !value;
      case 'void': return undefined;
      default: return UNRESOLVED;
    }
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = evaluateStatic(node.left, bindings);
    const right = evaluateStatic(node.right, bindings);
    if (left === UNRESOLVED || right === UNRESOLVED) return UNRESOLVED;
    if ((typeof left === 'string' || typeof left === 'number')
      && (typeof right === 'string' || typeof right === 'number')) {
      return typeof left === 'string' || typeof right === 'string'
        ? String(left) + String(right)
        : Number(left) + Number(right);
    }
  }
  return UNRESOLVED;
}

function toolNameFromCall(node: AstNode): string {
  if (node.type !== 'CallExpression') return '';
  const callee = astNode(node.callee);
  if (!callee || callee.type !== 'MemberExpression' || callee.computed === true) return '';
  if (identifierName(callee.object) !== 'tools') return '';
  return identifierName(callee.property);
}

function childNodes(node: AstNode): AstNode[] {
  const children: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        const child = astNode(item);
        if (child) children.push(child);
      }
      continue;
    }
    const child = astNode(value);
    if (child) children.push(child);
  }
  return children;
}

function parseOrchestratedSubcalls(source: string): NormalizedCodexToolSubcall[] | null {
  let program: Node;
  try {
    program = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
    });
  } catch {
    return null;
  }

  const bindings = new Map<string, unknown>();
  const calls: Array<NormalizedCodexToolSubcall & { start: number }> = [];

  const visit = (node: AstNode): void => {
    if (node.type === 'VariableDeclarator') {
      const name = identifierName(node.id);
      const value = evaluateStatic(node.init, bindings);
      if (name && value !== UNRESOLVED) bindings.set(name, value);
    }

    const toolName = toolNameFromCall(node);
    if (toolName) {
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      const argumentNode = astNode(args[0]);
      const value = evaluateStatic(argumentNode, bindings);
      calls.push({
        name: toolName,
        input: value === UNRESOLVED
          ? argumentNode ? source.slice(argumentNode.start, argumentNode.end) : ''
          : value,
        inputResolved: value !== UNRESOLVED,
        start: node.start,
      });
    }

    for (const child of childNodes(node)) visit(child);
  };

  visit(program as AstNode);
  return calls.sort((left, right) => left.start - right.start).map(({ start: _start, ...call }) => call);
}

function isExecInput(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.cmd === 'string'
    || typeof record.command === 'string'
    || Array.isArray(record.args)
    || Array.isArray(record.argv);
}

function isPatchInput(value: unknown): value is string {
  return typeof value === 'string' && value.includes('*** Begin Patch');
}

function canNormalizeSingleCall(call: NormalizedCodexToolSubcall): boolean {
  if (!call.inputResolved) return false;
  if (call.name === 'exec_command') return isExecInput(call.input);
  if (call.name === 'apply_patch') return isPatchInput(call.input);
  return true;
}

function orchestrationDisplayName(calls: NormalizedCodexToolSubcall[]): string {
  const firstName = calls[0]?.name || 'tools';
  return calls.every((call) => call.name === firstName)
    ? `${firstName} × ${calls.length}`
    : `tools × ${calls.length}`;
}

/**
 * GPT-5.6 can expose logical tool calls as an `exec` custom tool whose input is
 * JavaScript orchestration. Acorn parses the source, then this module evaluates
 * only a small static-expression whitelist. The model-provided code is never
 * executed.
 */
export function normalizeCodexToolCall(name: string, input: unknown): NormalizedCodexToolCall {
  if (!ORCHESTRATOR_TOOL_NAMES.has(name.trim()) || typeof input !== 'string') return { name, input };
  const subcalls = parseOrchestratedSubcalls(input);
  if (!subcalls || subcalls.length === 0) return { name, input };
  if (subcalls.length === 1) {
    const call = subcalls[0]!;
    return canNormalizeSingleCall(call) ? { name: call.name, input: call.input } : { name, input };
  }
  return {
    name: orchestrationDisplayName(subcalls),
    input,
    subcalls,
  };
}

export function buildCodexToolDetailFromNormalizedCall(
  call: NormalizedCodexToolCall,
): CodexToolDetail | null {
  if (!call.subcalls || call.subcalls.length < 2) {
    return buildCodexToolDetailFromInput(call.name, call.input);
  }
  return {
    kind: 'orchestration',
    calls: call.subcalls.map((subcall) => ({
      name: subcall.name,
      detail: subcall.inputResolved
        ? buildCodexToolDetailFromInput(subcall.name, subcall.input)
        : { kind: 'generic', input: subcall.input },
    })),
  };
}
