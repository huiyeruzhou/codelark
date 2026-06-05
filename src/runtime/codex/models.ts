import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CachedCodexModel {
  slug: string;
  displayName: string;
  visibility: string;
  supportedInApi: boolean;
}

const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex');
export const CODEX_HOME = process.env.CODEX_HOME || DEFAULT_CODEX_HOME;
export const DEFAULT_CODEX_CONFIG_PATH = path.join(CODEX_HOME, 'config.toml');

interface RawModelsCache {
  models?: Array<{
    slug?: unknown;
    display_name?: unknown;
    visibility?: unknown;
    supported_in_api?: unknown;
  }>;
}

export const DEFAULT_CODEX_MODELS_CACHE_PATH = path.join(CODEX_HOME, 'models_cache.json');

export function readConfiguredCodexModel(configPath = DEFAULT_CODEX_CONFIG_PATH): string | null {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    let inSection = false;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        inSection = true;
        continue;
      }
      if (inSection) continue;
      const match = trimmed.match(/^model\s*=\s*["']([^"']+)["']/);
      if (match?.[1]) {
        return match[1].trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function listCachedCodexModels(cachePath = DEFAULT_CODEX_MODELS_CACHE_PATH): CachedCodexModel[] {
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as RawModelsCache;
    if (!Array.isArray(parsed.models)) return [];

    const seen = new Set<string>();
    const models: CachedCodexModel[] = [];
    for (const model of parsed.models) {
      if (typeof model?.slug !== 'string' || !model.slug.trim()) continue;
      const slug = model.slug.trim();
      if (seen.has(slug)) continue;
      seen.add(slug);
      models.push({
        slug,
        displayName: typeof model.display_name === 'string' && model.display_name.trim()
          ? model.display_name.trim()
          : slug,
        visibility: typeof model.visibility === 'string' && model.visibility.trim()
          ? model.visibility.trim()
          : 'list',
        supportedInApi: model.supported_in_api === true,
      });
    }
    return models;
  } catch {
    return [];
  }
}

export function listSelectableCodexModels(cachePath = DEFAULT_CODEX_MODELS_CACHE_PATH): CachedCodexModel[] {
  return listCachedCodexModels(cachePath).filter((model) => model.visibility !== 'hide');
}

export function findSelectableCodexModel(
  slug: string,
  cachePath = DEFAULT_CODEX_MODELS_CACHE_PATH,
): CachedCodexModel | null {
  const normalized = slug.trim();
  if (!normalized) return null;
  return listSelectableCodexModels(cachePath).find((model) => model.slug === normalized) || null;
}

export function isCliOnlyCodexModel(model: Pick<CachedCodexModel, 'supportedInApi'> | null | undefined): boolean {
  return !!model && model.supportedInApi === false;
}
