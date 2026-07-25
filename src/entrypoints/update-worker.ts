import { runGlobalUpdateWorker } from '../bridge/update/update-worker.js';

function parseWorkerArgs(argv: string[]): { expectedVersion: string; npmExecutable?: string } {
  let expectedVersion = '';
  let npmExecutable: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--version') expectedVersion = argv[++index] || '';
    else if (argv[index] === '--npm') npmExecutable = argv[++index] || undefined;
    else throw new Error(`unknown option: ${argv[index]}`);
  }
  return { expectedVersion, npmExecutable };
}

runGlobalUpdateWorker(parseWorkerArgs(process.argv.slice(2))).catch((error) => {
  console.error(`[version-update] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
