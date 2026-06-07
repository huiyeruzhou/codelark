import { spawnSync } from 'node:child_process';

const forbiddenPrefixes = [
  'package/docs/',
  'package/docs/.vitepress/',
];

const forbiddenFiles = new Set([
  'package/README_EN.md',
  'package/config.env.example',
]);

const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

let packEntries;
try {
  packEntries = JSON.parse(result.stdout);
} catch (error) {
  console.error('Unable to parse npm pack --dry-run --json output.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const files = packEntries.flatMap((entry) => entry.files?.map((file) => file.path) ?? []);
const forbiddenMatches = files.filter((file) =>
  forbiddenFiles.has(file) || forbiddenPrefixes.some((prefix) => file.startsWith(prefix)),
);
const requiredFiles = new Set([
  'dist/defaults.toml',
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
