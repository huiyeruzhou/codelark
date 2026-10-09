import type { CursorTransport } from '../../domain/session.js';

/** Standard transport capabilities. Optional Desktop model control is probed per instance
 * by desktop-bridge-client; it never changes this provider or enables TOML writes. */
export interface CursorCapabilities {
  readonly provider: 'tmux';
  readonly transport: CursorTransport;
  /** A CLI catalog is neither the target conversation's selection nor an authorization result. */
  readonly modelCatalog: 'cli' | 'unavailable';
  /** Applies to both model and reasoning effort. Process launch does not include TUI reuse. */
  readonly modelConfiguration: 'process-launch' | 'external';
}

const CAPABILITIES: Record<CursorTransport, CursorCapabilities> = {
  desktop: Object.freeze({
    provider: 'tmux',
    transport: 'desktop',
    modelCatalog: 'unavailable',
    modelConfiguration: 'external',
  }),
  cli: Object.freeze({
    provider: 'tmux',
    transport: 'cli',
    modelCatalog: 'cli',
    modelConfiguration: 'process-launch',
  }),
};

export function getCursorCapabilities(transport: CursorTransport): CursorCapabilities {
  return CAPABILITIES[transport];
}
