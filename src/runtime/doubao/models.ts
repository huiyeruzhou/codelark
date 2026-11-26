import { spawn } from 'node:child_process';

export interface DoubaoModelInfo {
  id: string;
  name: string;
  isDefault: boolean;
  efforts: string[];
  defaultEffort?: string;
}

export function resolveDoubaoExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODELARK_DOUBAO_EXECUTABLE || env.DOUBAO_EXECUTABLE;
  return configured?.trim() || 'doubao';
}

export function parseDoubaoModelListOutput(output: string): DoubaoModelInfo[] {
  const lines = output.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as {
        result?: { models?: Array<Record<string, unknown>> };
        models?: Array<Record<string, unknown>>;
      };
      const rawModels = parsed?.result?.models || parsed?.models;
      if (!Array.isArray(rawModels)) continue;
      return rawModels
        .filter((item) => typeof item?.id === 'string' && item.id.trim().length > 0)
        .map((item) => {
          const rawEfforts = Array.isArray(item.efforts)
            ? item.efforts
            : Array.isArray(item.reasoning_efforts)
              ? item.reasoning_efforts
              : [];
          const defaultEffort = typeof item.default_effort === 'string' && item.default_effort.trim()
            ? item.default_effort.trim()
            : typeof item.default_reasoning_effort === 'string' && item.default_reasoning_effort.trim()
              ? item.default_reasoning_effort.trim()
              : typeof item.defaultEffort === 'string' && item.defaultEffort.trim()
                ? item.defaultEffort.trim()
                : undefined;
          return {
            id: String(item.id).trim(),
            name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : String(item.id).trim(),
            isDefault: item.is_default === true || item.isDefault === true || item.default === true,
            efforts: rawEfforts.filter((effort): effort is string => typeof effort === 'string' && effort.trim().length > 0),
            defaultEffort,
          };
        });
    } catch {
      // Ignore diagnostic log lines.
    }
  }
  return [];
}

export function resolveDoubaoModelChoice(
  query: string,
  models: readonly DoubaoModelInfo[],
): DoubaoModelInfo | undefined {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return undefined;
  const byId = models.find((model) => model.id.toLowerCase() === normalized);
  if (byId) return byId;
  const exactName = models.filter((model) => model.name.toLowerCase() === normalized);
  if (exactName.length === 1) return exactName[0];
  const fuzzy = models.filter((model) => model.name.toLowerCase().includes(normalized));
  return fuzzy.length === 1 ? fuzzy[0] : undefined;
}

const CACHE_TTL_MS = 60_000;
let cachedModels: { expiresAt: number; executable: string; models: DoubaoModelInfo[] } | null = null;

export function clearDoubaoModelCacheForTests(): void {
  cachedModels = null;
}

function runDoubaoModelListCommand(
  executable: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use stdio[0]='ignore' (/dev/null) so doubao CLI does not reject Node's socketpair stdin.
    const child = spawn(executable, ['model', 'list', '--json'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const maxBuffer = 2 * 1024 * 1024;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('doubao model list timed out'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < maxBuffer) stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`doubao model list exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

export async function listDoubaoModels(options: {
  executable?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  forceRefresh?: boolean;
} = {}): Promise<DoubaoModelInfo[]> {
  const executable = options.executable || resolveDoubaoExecutable(options.env);
  if (!options.forceRefresh && cachedModels && cachedModels.executable === executable && cachedModels.expiresAt > Date.now()) {
    return cachedModels.models;
  }
  const env = options.env || process.env;
  const timeoutMs = options.timeoutMs ?? 15_000;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stdout = await runDoubaoModelListCommand(executable, env, timeoutMs);
      const models = parseDoubaoModelListOutput(stdout);
      if (models.length > 0) {
        cachedModels = { executable, models, expiresAt: Date.now() + CACHE_TTL_MS };
      }
      return models;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTransient = /service_unavailable|与共享服务断开|exited with code 3\b/iu.test(message);
      if (attempt === 0 && isTransient) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      return cachedModels?.executable === executable ? cachedModels.models : [];
    }
  }
  return cachedModels?.executable === executable ? cachedModels.models : [];
}
