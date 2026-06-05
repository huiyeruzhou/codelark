import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const missingPackagePathErrorCodes = new Set(['ENOENT', 'ENOTDIR']);

export async function readPackageJson(packageJsonUrl) {
  const raw = await readFile(packageJsonUrl, 'utf8');
  return JSON.parse(raw);
}

export async function hasInstalledPackage(dependencyName, options = {}) {
  const accessFile = options.accessFile ?? access;
  const resolvePaths = options.resolvePaths ?? (() => []);

  for (const nodeModulesPath of resolvePaths(dependencyName) ?? []) {
    const packageJsonPath = path.join(nodeModulesPath, dependencyName, 'package.json');

    try {
      await accessFile(packageJsonPath);
      return true;
    } catch (error) {
      if (!missingPackagePathErrorCodes.has(error?.code)) {
        throw error;
      }
    }
  }

  return false;
}

export async function findMissingRuntimeDependencies(dependencies, options = {}) {
  const dependencyNames = Object.keys(dependencies ?? {}).sort();
  const missing = [];

  for (const dependencyName of dependencyNames) {
    if (!(await hasInstalledPackage(dependencyName, options))) {
      missing.push(dependencyName);
    }
  }

  return missing;
}

export async function findMissingPackageJsonRuntimeDependencies(packageJsonUrl) {
  const packageJson = await readPackageJson(packageJsonUrl);
  const packageRequire = createRequire(packageJsonUrl);

  return findMissingRuntimeDependencies(packageJson.dependencies, {
    resolvePaths: (dependencyName) => packageRequire.resolve.paths(dependencyName),
  });
}

export function formatMissingRuntimeDependenciesMessage(missingDependencies) {
  const dependencyList = missingDependencies.map((dependencyName) => `  - ${dependencyName}`).join('\n');

  return [
    'CodeLark build cannot start because package.json runtime dependencies are not installed:',
    dependencyList,
    '',
    'Install dependencies first:',
    '  npm ci',
    '',
    'If you are updating an existing checkout, npm install is also acceptable:',
    '  npm install',
    '',
    'Then rerun:',
    '  npm run build',
  ].join('\n');
}
