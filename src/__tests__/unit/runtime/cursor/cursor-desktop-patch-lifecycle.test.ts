import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, it } from 'node:test';
import { inspectCursorDesktopPatch, installCursorDesktopRealtimePatch, planCursorDesktopPatchInstall,
  resolveCursorDesktopPatchPaths, uninstallCursorDesktopRealtimePatch } from '../../../../runtime/cursor/desktop-realtime-patch.js';
const marker = '/* __CODELARK_CURSOR_DESKTOP_CONTROL_V3__ */';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
let root: string, previous: string | undefined, app: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-patch-lifecycle-'));
  previous = process.env.CODELARK_HOME; process.env.CODELARK_HOME = path.join(root, 'home');
  app = path.join(root, 'Cursor.app');
  const paths = resolveCursorDesktopPatchPaths(app);
  fs.mkdirSync(path.dirname(paths.glassBundlePath), { recursive: true });
  fs.writeFileSync(paths.productPath, JSON.stringify({ version: 'fixture' }));
  for (const file of [paths.mainBundlePath, paths.rendererBundlePath, paths.glassBundlePath]) fs.writeFileSync(file, 'original:'+path.basename(file));
});
afterEach(() => { if (previous === undefined) delete process.env.CODELARK_HOME; else process.env.CODELARK_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); });
function layer(index: number, targets: string[]) {
  const dir = path.join(process.env.CODELARK_HOME!, 'backups', 'cursor-desktop', 'fixture', String(index));
  fs.mkdirSync(dir, { recursive: true });
  const files = targets.map((file) => {
    const before = fs.readFileSync(file, 'utf8'); const after = before + marker + index;
    const backup = path.join(dir, path.basename(file)); fs.writeFileSync(backup, before); fs.writeFileSync(file, after);
    return { path: file, backup, sha256: hash(before), patchedSha256: hash(after) };
  });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, marker: '__CODELARK_CURSOR_DESKTOP_CONTROL_V3__', appPath: app, appVersion: 'fixture', installedAt: '', files }));
  return files;
}
it('is opt-in and its status/install plan never modifies application files', () => {
  const paths = resolveCursorDesktopPatchPaths(app);
  const before = fs.readFileSync(paths.mainBundlePath, 'utf8');
  assert.throws(() => installCursorDesktopRealtimePatch(app), /--allow-app-modification/);
  assert.equal(inspectCursorDesktopPatch(app).state, 'not-installed');
  assert.equal(planCursorDesktopPatchInstall(app).action, 'install-plan');
  assert.equal(fs.readFileSync(paths.mainBundlePath, 'utf8'), before);
});
it('uninstalls every upgrade layer and a later-added Glass bundle back to stock, idempotently', () => {
  const p = resolveCursorDesktopPatchPaths(app); const targets = [p.mainBundlePath, p.rendererBundlePath, p.glassBundlePath];
  const originals = targets.map(file => fs.readFileSync(file, 'utf8'));
  layer(1, targets.slice(0, 2)); layer(2, targets.slice(0, 2)); layer(3, targets);
  assert.equal(inspectCursorDesktopPatch(app).canUninstall, true);
  const before = targets.map(file => fs.readFileSync(file, 'utf8'));
  assert.equal(uninstallCursorDesktopRealtimePatch(app, { dryRun: true }).action, 'uninstall-plan');
  assert.deepEqual(targets.map(file => fs.readFileSync(file, 'utf8')), before);
  assert.equal(uninstallCursorDesktopRealtimePatch(app).action, 'uninstalled');
  assert.deepEqual(targets.map(file => fs.readFileSync(file, 'utf8')), originals);
  assert.equal(uninstallCursorDesktopRealtimePatch(app).action, 'not-installed');
  assert.equal(inspectCursorDesktopPatch(app).state, 'not-installed');
});
for (const failure of ['external-change', 'corrupt-backup'] as const) it(`validates all files before uninstall: ${failure}`, () => {
  const p = resolveCursorDesktopPatchPaths(app); const targets = [p.mainBundlePath, p.rendererBundlePath, p.glassBundlePath];
  const files = layer(1, targets);
  if (failure === 'external-change') fs.appendFileSync(targets[2]!, 'external modification');
  else fs.writeFileSync(files[2]!.backup, 'corrupt');
  const before = targets.map(file => fs.readFileSync(file, 'utf8'));
  assert.equal(inspectCursorDesktopPatch(app).canUninstall, false);
  assert.throws(() => uninstallCursorDesktopRealtimePatch(app), /备份链/);
  assert.deepEqual(targets.map(file => fs.readFileSync(file, 'utf8')), before);
});

it('the actual CLI defaults to a read-only install plan and supports full uninstall aliases', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../../../../entrypoints/cli.ts', import.meta.url));
  const invoke = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', cli, 'cursor-desktop-patch', ...args, '--app', app], { encoding: 'utf8', timeout: 20_000 }));
  const p = resolveCursorDesktopPatchPaths(app), targets = [p.mainBundlePath, p.rendererBundlePath, p.glassBundlePath];
  const originals = targets.map(file => fs.readFileSync(file, 'utf8'));
  assert.equal(invoke().action, 'status');
  assert.equal(invoke('install').action, 'install-plan');
  assert.equal(invoke('install', '--allow-app-modification', '--dry-run').action, 'install-plan');
  assert.deepEqual(targets.map(file => fs.readFileSync(file, 'utf8')), originals);
  layer(1, targets);
  assert.equal(invoke('uninstall', '--dry-run').action, 'uninstall-plan');
  assert.equal(invoke('restore').action, 'uninstalled');
  assert.deepEqual(targets.map(file => fs.readFileSync(file, 'utf8')), originals);
  assert.equal(invoke('uninstall').action, 'not-installed');
});
