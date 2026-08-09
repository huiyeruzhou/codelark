import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export interface SpawnSpec {
  command: string;
  args: string[];
}

function quoteCmdArgument(value: string): string {
  if (!value) return '""';
  return `"${value.replace(/(["^&|<>])/gu, '^$1')}"`;
}

export function buildSpawnSpec(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  commandInterpreter = process.env.ComSpec || 'cmd.exe',
): SpawnSpec {
  const extension = path.extname(executable).toLowerCase();
  if (platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
    const commandLine = [executable, ...args].map(quoteCmdArgument).join(' ');
    return { command: commandInterpreter, args: ['/d', '/s', '/c', commandLine] };
  }
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return { command: process.execPath, args: [executable, ...args] };
  }
  return { command: executable, args };
}

function executableCandidates(name: string, platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name];
}

export function findNpmExecutable(options: {
  nodePath?: string;
  pathValue?: string;
  platform?: NodeJS.Platform;
} = {}): string | null {
  const nodePath = options.nodePath || process.execPath;
  const platform = options.platform || process.platform;
  const nodeDirectory = path.dirname(nodePath);
  const directCandidates = [
    path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(nodeDirectory), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...executableCandidates('npm', platform).map((name) => path.join(nodeDirectory, name)),
  ];
  for (const candidate of directCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const directory of (options.pathValue ?? process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    for (const name of executableCandidates('npm', platform)) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function run(
  executable: string,
  args: string[],
  options: { capture?: boolean; allowFailure?: boolean } = {},
): Promise<string> {
  const spec = buildSpawnSpec(executable, args);
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn(spec.command, spec.args, {
      env: process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      windowsHide: true,
    });
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 || options.allowFailure) {
        resolve(Buffer.concat(chunks).toString('utf-8'));
        return;
      }
      reject(new Error(`${path.basename(executable)} exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`));
    });
  });
}

function parseRegistryVersion(output: string): string {
  const parsed = JSON.parse(output.trim()) as unknown;
  const raw = Array.isArray(parsed) ? parsed.at(-1) : parsed;
  if (typeof raw !== 'string' || !VERSION_PATTERN.test(raw)) {
    throw new Error('npm registry returned an invalid CodeLark version');
  }
  return raw;
}

export async function runGlobalUpdateWorker(options: {
  expectedVersion: string;
  npmExecutable?: string;
}): Promise<void> {
  if (!VERSION_PATTERN.test(options.expectedVersion)) throw new Error('invalid expected CodeLark version');
  const npmExecutable = options.npmExecutable || findNpmExecutable();
  if (!npmExecutable) throw new Error('npm executable was not found');

  console.log(`[version-update] started ${new Date().toISOString()}`);
  console.log(`[version-update] expected v${options.expectedVersion}`);
  console.log(`[version-update] Node.js ${process.version}`);

  const latestVersion = parseRegistryVersion(await run(
    npmExecutable,
    ['view', 'codelark', 'version', '--json'],
    { capture: true },
  ));
  console.log(`[version-update] npm latest v${latestVersion}`);
  if (latestVersion !== options.expectedVersion) {
    console.log(`[version-update] registry changed after the card was sent; installing v${latestVersion}`);
  }

  await run(npmExecutable, ['install', '-g', '--yes', `codelark@${latestVersion}`]);
  const globalRoot = (await run(npmExecutable, ['root', '-g'], { capture: true })).trim().split(/\r?\n/u).at(-1);
  if (!globalRoot) throw new Error('npm did not return its global package directory');
  const cliPath = path.join(globalRoot, 'codelark', 'dist', 'cli.mjs');
  if (!fs.existsSync(cliPath)) throw new Error(`updated CodeLark CLI was not found at ${cliPath}`);

  console.log('[version-update] updating bundled CodeLark skills');
  await run(process.execPath, [cliPath, 'install-skills', 'codelark', 'condition-monitor']);

  console.log('[version-update] restarting CodeLark');
  await run(process.execPath, [cliPath, 'stop'], { allowFailure: true });
  await run(process.execPath, [cliPath, 'start']);
  console.log(`[version-update] completed ${new Date().toISOString()}`);
}
