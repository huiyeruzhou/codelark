import '../../setup/test-setup.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

function listSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') return [];
      return listSourceFiles(fullPath);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

function filesImportingLegacyFacade(root: string, options: { skipTests?: boolean; allowed?: Set<string> } = {}): string[] {
  const allowed = options.allowed || new Set<string>();
  return listSourceFiles(root)
    .filter((file) => {
      if (options.skipTests && path.relative(root, file).split(path.sep).includes('__tests__')) return false;
      return true;
    })
    .filter((file) => !allowed.has(path.relative(process.cwd(), file)))
    .filter((file) => {
      const source = fs.readFileSync(file, 'utf-8');
      return /from\s+['"][^'"]*configuration\/index\.js['"]/.test(source);
    })
    .map((file) => path.relative(process.cwd(), file));
}

function legacyBridgeSettingReads(root: string): string[] {
  const allowed = new Set([
    'bridge_auto_start',
    'bridge_default_provider_id',
    'bridge_feishu_group_allow_from',
    'bridge_feishu_group_policy',
  ]);
  const settingPattern = /getSetting\(\s*['"](bridge_[^'"]+)['"]\s*\)/g;
  return listSourceFiles(root)
    .filter((file) => !path.relative(root, file).split(path.sep).includes('__tests__'))
    .flatMap((file) => {
      const relative = path.relative(process.cwd(), file);
      const source = fs.readFileSync(file, 'utf-8');
      const offenders: string[] = [];
      for (const match of source.matchAll(settingPattern)) {
        const setting = match[1]!;
        if (!allowed.has(setting)) offenders.push(`${relative}: ${setting}`);
      }
      return offenders;
    });
}

function filesImportingConfigParsersOutsideConfiguration(root: string): string[] {
  const parserImportPattern = /from\s+['"](?:config(?:\/lib\/util\.js)?|smol-toml)['"]|require\(\s*['"](?:config(?:\/lib\/util\.js)?|smol-toml)['"]\s*\)/;
  return listSourceFiles(root)
    .filter((file) => {
      const relative = path.relative(root, file);
      return !relative.split(path.sep).includes('__tests__')
        && !relative.startsWith(`configuration${path.sep}`);
    })
    .filter((file) => parserImportPattern.test(fs.readFileSync(file, 'utf-8')))
    .map((file) => path.relative(process.cwd(), file));
}

function uiRouteFilesImportingConfigService(root: string): string[] {
  const serviceImportPattern = /from\s+['"][^'"]*configuration\/service\.js['"]/;
  const routesRoot = path.join(root, 'operator-ui', 'routes');
  return listSourceFiles(routesRoot)
    .filter((file) => serviceImportPattern.test(fs.readFileSync(file, 'utf-8')))
    .map((file) => path.relative(process.cwd(), file));
}

function filesImportingLegacyConfigurationProjection(root: string): string[] {
  const projectionImportPattern = /from\s+['"][^'"]*configuration\/projections\.js['"]/;
  return listSourceFiles(root)
    .filter((file) => !path.relative(root, file).split(path.sep).includes('__tests__'))
    .filter((file) => !path.relative(root, file).startsWith(`configuration${path.sep}`))
    .filter((file) => projectionImportPattern.test(fs.readFileSync(file, 'utf-8')))
    .map((file) => path.relative(process.cwd(), file));
}

describe('configuration module boundaries', () => {
  it('keeps the legacy config facade out of production imports', () => {
    const sourceRoot = path.join(process.cwd(), 'src');
    const offenders = filesImportingLegacyFacade(sourceRoot, {
      skipTests: true,
    });

    assert.deepEqual(offenders, []);
  });

  it('keeps non-facade tests from importing the legacy config facade', () => {
    const sourceRoot = path.join(process.cwd(), 'src');
    const offenders = filesImportingLegacyFacade(path.join(sourceRoot, '__tests__'));

    assert.deepEqual(offenders, []);
  });

  it('keeps scripts from importing the legacy config facade', () => {
    const scriptsRoot = path.join(process.cwd(), 'scripts');
    const offenders = filesImportingLegacyFacade(scriptsRoot);
    assert.deepEqual(offenders, []);
  });

  it('keeps legacy adapter modules independent from the facade re-export', () => {
    const legacySource = fs.readFileSync(path.join(process.cwd(), 'src', 'configuration', 'legacy.ts'), 'utf-8');
    assert.equal(/from\s+['"]\.\/index\.js['"]/.test(legacySource), false);
  });

  it('keeps current config paths from exposing legacy input files', () => {
    const pathsSource = fs.readFileSync(path.join(process.cwd(), 'src', 'configuration', 'paths.ts'), 'utf-8');

    assert.doesNotMatch(pathsSource, /config\.env/);
    assert.doesNotMatch(pathsSource, /config\.json/);
    assert.doesNotMatch(pathsSource, /CONFIG_PATH/);
    assert.doesNotMatch(pathsSource, /CONFIG_JSON_PATH/);
  });

  it('keeps runtime and channel application concerns out of the configuration layer', () => {
    assert.equal(fs.existsSync(path.join(process.cwd(), 'src', 'configuration', 'runtime-options.ts')), false);
    assert.equal(fs.existsSync(path.join(process.cwd(), 'src', 'configuration', 'runtime-types.ts')), false);
    assert.equal(fs.existsSync(path.join(process.cwd(), 'src', 'configuration', 'runtime-settings-projection.ts')), false);
    assert.equal(fs.existsSync(path.join(process.cwd(), 'src', 'configuration', 'channel-types.ts')), false);

    const channelTypesSource = fs.readFileSync(path.join(process.cwd(), 'src', 'channels', 'types.ts'), 'utf-8');
    assert.doesNotMatch(channelTypesSource, /normalizeFeishuSite/);
    assert.doesNotMatch(channelTypesSource, /feishuSiteToApiBaseUrl/);
    assert.doesNotMatch(channelTypesSource, /open\.larksuite\.com/);
  });

  it('does not synthesize channel patches from env or CLI overlays', () => {
    const cliSource = fs.readFileSync(path.join(process.cwd(), 'src', 'configuration', 'cli-overrides.ts'), 'utf-8');
    const envSource = fs.readFileSync(path.join(process.cwd(), 'src', 'configuration', 'env-compat.ts'), 'utf-8');
    assert.doesNotMatch(cliSource, /defaultChannelPatch/);
    assert.doesNotMatch(envSource, /ensureDefaultChannelPatch/);
  });

  it('keeps merge exports limited to source merge mechanics', () => {
    const mergeSource = fs.readFileSync(path.join(process.cwd(), 'src', 'configuration', 'merge.ts'), 'utf-8');
    assert.doesNotMatch(mergeSource, /export function getDefaultChannel/);
    assert.doesNotMatch(mergeSource, /export function valueToString/);
    assert.doesNotMatch(mergeSource, /export function setPatchPath/);
  });

  it('keeps production legacy bridge setting reads limited to explicit migration-decision holdouts', () => {
    const offenders = legacyBridgeSettingReads(path.join(process.cwd(), 'src'));
    assert.deepEqual(offenders, []);
  });

  it('keeps TOML and node-config parsing behind the configuration module', () => {
    const offenders = filesImportingConfigParsersOutsideConfiguration(path.join(process.cwd(), 'src'));
    assert.deepEqual(offenders, []);
  });
  it('keeps UI route config writes behind the application layer', () => {
    const offenders = uiRouteFilesImportingConfigService(path.join(process.cwd(), 'src'));
    assert.deepEqual(offenders, []);
  });

  it('keeps runtime projections outside the configuration service boundary', () => {
    assert.equal(fs.existsSync(path.join(process.cwd(), 'src', 'configuration', 'projections.ts')), false);

    const serviceSource = fs.readFileSync(path.join(process.cwd(), 'src', 'configuration', 'service.ts'), 'utf-8');
    assert.doesNotMatch(serviceSource, /exportRuntimeSettings/);
    assert.doesNotMatch(serviceSource, /exportProcessEnv/);
    assert.doesNotMatch(serviceSource, /projectRuntimeSettings/);

    const offenders = filesImportingLegacyConfigurationProjection(path.join(process.cwd(), 'src'));
    assert.deepEqual(offenders, []);
  });
});
