import '../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Architecture guard: a lower layer must not import a higher one.
 *
 * Layers (lower number = lower layer). Same-rank imports are allowed.
 *   0 shared
 *   1 domain, configuration
 *   2 storage, runtime
 *   3 channels
 *   4 bridge
 *   5 local-service, operator-ui
 *   6 entrypoints
 *
 * KNOWN_VIOLATIONS records the debt that existed when the guard was introduced.
 * The list may only shrink: a new upward import fails, and a fixed entry that is
 * still listed also fails so the allowance cannot silently linger.
 */
const LAYER_RANK: Record<string, number> = {
  shared: 0,
  domain: 1,
  configuration: 1,
  storage: 2,
  runtime: 2,
  channels: 3,
  bridge: 4,
  'local-service': 5,
  'operator-ui': 5,
  entrypoints: 6,
};

const KNOWN_VIOLATIONS = new Set([
  // bridge -> local-service: the /status command reads daemon/UI process state directly.
  'bridge/command/status.ts -> local-service/manager.ts',
  // channels -> bridge: adapters reach into bridge host state and command helpers.
  'channels/adapter-runtime/channel-runtime.ts -> bridge/session/display/channel-label.ts',
  'channels/delivery/deliver.ts -> bridge/host/context.ts',
  'channels/feishu/adapter.ts -> bridge/command/aliases.ts',
  'channels/feishu/adapter.ts -> bridge/command/file-upload-confirmations.ts',
  'channels/feishu/adapter.ts -> bridge/host/context.ts',
  'channels/feishu/adapter.ts -> bridge/session/require-mention.ts',
  // configuration -> runtime/channels: legacy migration types only.
  'configuration/legacy-types.ts -> channels/types.ts',
  'configuration/legacy-types.ts -> runtime/options.ts',
  'configuration/legacy.ts -> channels/types.ts',
  // domain -> runtime: audit borrows a provider contract type.
  'domain/audit.ts -> runtime/contracts.ts',
  // shared -> configuration/domain/runtime: progress and logging helpers depend on higher-level types.
  'shared/lark-cli-env.ts -> configuration/paths.ts',
  'shared/logger.ts -> configuration/paths.ts',
  'shared/progress/tool-call-details.ts -> domain/progress.ts',
  'shared/progress/tool-events.ts -> domain/progress.ts',
  'shared/progress/tool-events.ts -> runtime/contracts.ts',
  'shared/progress/tool-presentation.ts -> domain/progress.ts',
  'shared/progress/tool-rendering.ts -> domain/progress.ts',
]);

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const importPattern = /(?:\bfrom\s+|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'testing') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

function resolveImport(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier.replace(/\.m?js$/, ''));
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function layerOf(file: string): string {
  return path.relative(srcRoot, file).split(path.sep)[0]!;
}

function collectUpwardImports(): Set<string> {
  const violations = new Set<string>();
  for (const file of sourceFiles(srcRoot)) {
    const fromLayer = layerOf(file);
    const fromRank = LAYER_RANK[fromLayer];
    if (fromRank === undefined) continue;
    for (const match of fs.readFileSync(file, 'utf8').matchAll(importPattern)) {
      const target = resolveImport(file, match[1]!);
      if (!target) continue;
      const toLayer = layerOf(target);
      const toRank = LAYER_RANK[toLayer];
      if (toRank === undefined || toLayer === fromLayer || toRank <= fromRank) continue;
      const rel = (p: string) => path.relative(srcRoot, p).split(path.sep).join('/');
      violations.add(`${rel(file)} -> ${rel(target)}`);
    }
  }
  return violations;
}

test('every top-level source directory is assigned a layer', () => {
  const unassigned = fs.readdirSync(srcRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !['__tests__', 'testing'].includes(entry.name))
    .map((entry) => entry.name)
    .filter((name) => LAYER_RANK[name] === undefined);
  assert.deepEqual(unassigned, [], `Assign a layer in LAYER_RANK for: ${unassigned.join(', ')}`);
});

test('no new upward imports between layers', () => {
  const unexpected = [...collectUpwardImports()].filter((edge) => !KNOWN_VIOLATIONS.has(edge)).sort();
  assert.deepEqual(unexpected, [],
    `Lower layers must not import higher layers. Move the shared code down or invert the dependency:\n${unexpected.join('\n')}`);
});

test('fixed layer violations are removed from the allowlist', () => {
  const current = collectUpwardImports();
  const stale = [...KNOWN_VIOLATIONS].filter((edge) => !current.has(edge)).sort();
  assert.deepEqual(stale, [], `These violations are fixed; delete them from KNOWN_VIOLATIONS:\n${stale.join('\n')}`);
});
