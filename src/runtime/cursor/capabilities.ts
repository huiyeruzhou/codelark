import type { CursorProviderChoice } from '../../domain/session.js';

/** Capabilities of CodeLark's integration, not everything the native Cursor UI can do. */
export interface CursorProviderCapabilities {
  readonly provider: CursorProviderChoice;
  /** A CLI catalog is neither the target conversation's selection nor an authorization result. */
  readonly modelCatalog: 'cli' | 'unavailable';
  /** Applies to both model and reasoning effort. Process launch does not include TUI reuse. */
  readonly modelConfiguration: 'process-launch' | 'external';
}

const CAPABILITIES: Record<CursorProviderChoice, CursorProviderCapabilities> = {
  desktop: Object.freeze({
    provider: 'desktop',
    modelCatalog: 'unavailable',
    modelConfiguration: 'external',
  }),
  tmux: Object.freeze({
    provider: 'tmux',
    modelCatalog: 'cli',
    modelConfiguration: 'process-launch',
  }),
};

export function getCursorProviderCapabilities(provider: CursorProviderChoice): CursorProviderCapabilities {
  return CAPABILITIES[provider];
}
