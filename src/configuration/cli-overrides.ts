import { Command, InvalidOptionArgumentError as InvalidArgumentError } from 'commander';
import { findConfigField } from './fields.js';
import type { ConfigField, ConfigPath } from './fields-types.js';
import { setConfigPath } from './path-access.js';
import { configPatchSchema, type ConfigPatch } from './schema.js';

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
    throw new InvalidArgumentError(`Unknown config field: ${path}`);
  }
  if (!field.scopes.includes('cli')) {
    throw new InvalidArgumentError(`Config field ${path} cannot be set from CLI.`);
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
  throw new InvalidArgumentError(`Invalid value for ${field.path}: ${raw}`);
}

function setPatchValue(patch: ConfigPatch, path: ConfigPath, value: unknown): void {
  setConfigPath(patch as Record<string, unknown>, path, value);
}

function parseSetAssignment(assignment: string, patch: ConfigPatch): void {
  const eqIdx = assignment.indexOf('=');
  if (eqIdx <= 0) {
    throw new InvalidArgumentError(`Expected --set path=value, received: ${assignment}`);
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
    .option('--set <path=value>', 'override a config value by canonical path', collect, [])
    .option('--unset <path>', 'unset a config value by canonical path', collect, []);

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
