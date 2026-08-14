import type { JsonFileStore } from '../../storage/json-store.js';
import { createUiSessionRegistry } from './session-source.js';

export class UiBindingApplication {
  private readonly registry: ReturnType<typeof createUiSessionRegistry>;

  constructor(private readonly store: JsonFileStore) {
    this.registry = createUiSessionRegistry(store);
  }

  switchBindingTarget(options: {
    bindingId: string;
    bridgeSessionId?: string;
    codexThreadId?: string;
    claudeSessionId?: string;
    claudeCwd?: string;
    kimiSessionId?: string;
    kimiCwd?: string;
    cursorSessionId?: string;
    cursorCwd?: string;
    zcodeSessionId?: string;
    zcodeCwd?: string;
  }) {
    if (options.bridgeSessionId) {
      return this.registry.switchBindingToBridgeSession(options.bindingId, options.bridgeSessionId);
    }
    if (options.codexThreadId) {
      return this.registry.switchBindingToCodexThread(options.bindingId, options.codexThreadId);
    }
    const session = options.claudeSessionId && options.claudeCwd
      ? this.registry.materializeClaudeThread(options.claudeSessionId, options.claudeCwd)
      : options.kimiSessionId && options.kimiCwd
        ? this.registry.materializeKimiThread(options.kimiSessionId, options.kimiCwd)
        : options.cursorSessionId && options.cursorCwd
          ? this.registry.materializeCursorThread(options.cursorSessionId, options.cursorCwd)
          : this.registry.materializeZcodeThread(options.zcodeSessionId!, options.zcodeCwd!);
    return this.registry.switchBindingToBridgeSession(options.bindingId, session.id);
  }

  removeBinding(bindingId: string): void {
    this.registry.removeBinding(bindingId);
  }
}
