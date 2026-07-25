import { spawnSync } from 'node:child_process';

const forbiddenPrefixes = [
  'package/docs/',
  'package/docs/.vitepress/',
];

const forbiddenFiles = new Set([
  'package/README_EN.md',
  'package/config.env.example',
]);

const npmArgs = ['pack', '--dry-run', '--json'];
const npmExecPath = process.env.npm_execpath;
const result = npmExecPath
  ? spawnSync(process.execPath, [npmExecPath, ...npmArgs], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  : spawnSync('npm', npmArgs, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

if (result.error) {
  console.error(`Unable to start npm pack: ${result.error.message}`);
  process.exit(1);
}

const stdout = typeof result.stdout === 'string' ? result.stdout : '';
const stderr = typeof result.stderr === 'string' ? result.stderr : '';

if (result.status !== 0) {
  if (stderr) process.stderr.write(stderr);
  else console.error(`npm pack exited with status ${result.status ?? 'unknown'}.`);
  process.exit(result.status ?? 1);
}

let packOutput;
try {
  packOutput = JSON.parse(stdout);
} catch (error) {
  console.error('Unable to parse npm pack --dry-run --json output.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// npm <=11 returns an array; npm 12 returns an object keyed by package name.
const packEntries = Array.isArray(packOutput)
  ? packOutput
  : packOutput && typeof packOutput === 'object'
    ? Object.values(packOutput)
    : [];
if (packEntries.length === 0) {
  console.error('npm pack --dry-run --json returned no package entries.');
  process.exit(1);
}
const files = packEntries.flatMap((entry) => entry.files?.map((file) => file.path) ?? []);
const forbiddenMatches = files.filter((file) =>
  forbiddenFiles.has(file) || forbiddenPrefixes.some((prefix) => file.startsWith(prefix)),
);
const requiredFiles = new Set([
  'dist/defaults.toml',
  'dist/update-global-codelark.mjs',
]);
const missingRequiredFiles = [...requiredFiles].filter((file) => !files.includes(file));

if (forbiddenMatches.length > 0) {
  console.error('Unexpected files would be included in the npm package:');
  for (const file of forbiddenMatches) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}

if (missingRequiredFiles.length > 0) {
  console.error('Required files are missing from the npm package:');
  for (const file of missingRequiredFiles) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}

console.log(`npm package dry-run passed: ${files.length} files, no docs or example env files included.`);
