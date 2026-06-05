import {
  findMissingPackageJsonRuntimeDependencies,
  formatMissingRuntimeDependenciesMessage,
} from './build-preflight.js';

const nodeMajor = Number((process.versions.node || '0').split('.')[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < 24) {
  console.error(`CodeLark build requires Node.js 24 or newer. Current Node.js: ${process.version}.`);
  process.exit(1);
}

const packageJsonUrl = new URL('../package.json', import.meta.url);
const missingRuntimeDependencies = await findMissingPackageJsonRuntimeDependencies(packageJsonUrl);
if (missingRuntimeDependencies.length > 0) {
  console.error(formatMissingRuntimeDependenciesMessage(missingRuntimeDependencies));
  process.exit(1);
}

const esbuild = await import('esbuild');

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: [
    '@openai/codex-sdk',
    // Keep large IM SDKs external so global/local npm installs resolve them
    // from node_modules instead of inflating daemon.mjs.
    '@larksuiteoapi/node-sdk',
    // ws optional native deps
    'bufferutil', 'utf-8-validate',
    // Node.js built-ins
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls',
    'stream', 'events', 'url', 'util', 'child_process', 'worker_threads',
    'node:*',
  ],
  banner: { js: "import { createRequire as __codelarkCreateRequire } from 'module'; const require = __codelarkCreateRequire(import.meta.url);" },
};

async function build(entryPoint, outfile) {
  await esbuild.build({
    ...common,
    entryPoints: [entryPoint],
    outfile,
  });
}

await build('src/entrypoints/daemon.ts', 'dist/daemon.mjs');
await build('src/operator-ui/server.ts', 'dist/ui-server.mjs');
await build('src/entrypoints/cli.ts', 'dist/cli.mjs');

console.log('Built dist/daemon.mjs, dist/ui-server.mjs, dist/cli.mjs');
