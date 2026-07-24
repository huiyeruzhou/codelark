import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadTomlFileWithNodeConfig } from '../../configuration/merge.js';

function kimiCodeHome(): string {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function assertKimiLaunchAuthentication(model?: string): void {
  const home = kimiCodeHome();
  const configPath = path.join(home, 'config.toml');
  let config: Record<string, any>;
  try {
    const loaded = loadTomlFileWithNodeConfig(configPath);
    if (!loaded || typeof loaded !== 'object') return;
    config = loaded as Record<string, any>;
  } catch {
    // Kimi owns config validation. If its config is absent or unreadable, let the CLI report it.
    return;
  }

  const selectedModel = model && config.models?.[model]
    ? model
    : nonEmptyString(config.default_model);
  const modelConfig = selectedModel ? config.models?.[selectedModel] : undefined;
  const providerId = nonEmptyString(modelConfig?.provider);
  const provider = providerId ? config.providers?.[providerId] : undefined;
  if (!providerId?.startsWith('managed:') || nonEmptyString(provider?.api_key)) return;

  const credentialKey = nonEmptyString(provider?.oauth?.key);
  if (!credentialKey) return;
  const credentialName = path.basename(credentialKey);
  const credentialPath = path.join(home, 'credentials', `${credentialName}.json`);
  let credential: Record<string, unknown> | null = null;
  try {
    credential = JSON.parse(fs.readFileSync(credentialPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // Missing or malformed OAuth state is the same actionable condition for a managed provider.
  }
  if (nonEmptyString(credential?.access_token) || nonEmptyString(credential?.refresh_token)) return;

  throw new Error(
    `Kimi Code provider ${providerId} is not logged in. Run ${resolveKimiLoginCommand()} and retry.`,
  );
}

function resolveKimiLoginCommand(): string {
  const explicit = process.env.KIMI_CODE_EXECUTABLE || process.env.CODELARK_KIMI_EXECUTABLE;
  if (explicit) return `${explicit} login`;
  const homeExecutable = path.join(os.homedir(), '.kimi-code', 'bin', 'kimi');
  return fs.existsSync(homeExecutable) ? `${homeExecutable} login` : 'kimi login';
}
