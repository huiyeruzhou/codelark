import { Command, InvalidOptionArgumentError as InvalidArgumentError } from 'commander';
import { findConfigField } from './fields.js';
import type { ConfigField, ConfigPath } from './fields.js';
import { setConfigPath } from './path-access.js';
import { configPatchSchema, type ConfigPatch } from './schema.js';

// CLI 覆盖解析：把 `--set path=value` / `--unset path` 转成一次启动内的 ConfigPatch。
// 这里只接受 configFields 声明为 cli scope 的字段，避免 CLI 绕过写入边界。

export interface ParsedConfigCliOverrides {
  patch: ConfigPatch;
  unset: ConfigPath[];
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function requireCliField(path: string): ConfigField {
  const field = findConfigField(path) as ConfigField | undefined;
  if (!field) {
    throw new InvalidArgumentError(`未知配置字段：${path}`);
  }
  if (!field.scopes.includes('cli')) {
    throw new InvalidArgumentError(`配置字段 ${path} 不能通过 CLI 设置。`);
  }
  return field;
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
    || (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

function parseValue(field: ConfigField, raw: string): unknown {
  const candidates = [
    parseScalar(raw),
    field.parseEnv?.(raw),
    raw,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const parsed = field.schema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  throw new InvalidArgumentError(`配置字段 ${field.path} 的值不合法：${raw}`);
}

function setPatchValue(patch: ConfigPatch, path: ConfigPath, value: unknown): void {
  setConfigPath(patch as Record<string, unknown>, path, value);
}

function parseSetAssignment(assignment: string, patch: ConfigPatch): void {
  const eqIdx = assignment.indexOf('=');
  if (eqIdx <= 0) {
    throw new InvalidArgumentError(`--set 需要使用 path=value 格式，实际收到：${assignment}`);
  }
  const path = assignment.slice(0, eqIdx).trim();
  const raw = assignment.slice(eqIdx + 1);
  const field = requireCliField(path);
  setPatchValue(patch, path, parseValue(field, raw));
}

export function parseConfigCliOverrides(argv: string[]): ParsedConfigCliOverrides {
  const program = new Command();
  program
    .exitOverride()
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option('--set <path=value>', '按 canonical path 临时覆盖配置值', collect, [])
    .option('--unset <path>', '按 canonical path 临时清除配置值', collect, []);

  program.parse(argv, { from: 'user' });
  const options = program.opts() as { set?: string[]; unset?: string[] };
  const patch: ConfigPatch = {};

  for (const assignment of options.set || []) {
    parseSetAssignment(assignment, patch);
  }

  const unset = (options.unset || []).map((path: string) => {
    const trimmed = path.trim();
    requireCliField(trimmed);
    return trimmed;
  });

  return {
    patch: configPatchSchema.parse(patch),
    unset,
  };
}
