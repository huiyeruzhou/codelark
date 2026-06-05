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
  }) {
    if (options.bridgeSessionId) {
      return this.registry.switchBindingToBridgeSession(options.bindingId, options.bridgeSessionId);
    }
    if (options.codexThreadId) {
      return this.registry.switchBindingToCodexThread(options.bindingId, options.codexThreadId);
    }
    const session = this.registry.materializeClaudeThread(options.claudeSessionId!, options.claudeCwd!);
    return this.registry.switchBindingToBridgeSession(options.bindingId, session.id);
  }

  setChannelDefaultTarget(options: {
    channelType: string;
    bridgeSessionId?: string;
    codexThreadId?: string;
    claudeSessionId?: string;
    claudeCwd?: string;
  }) {
    if (options.bridgeSessionId) {
      return this.registry.setChannelDefaultBridgeSession(options.channelType, options.bridgeSessionId);
    }
    if (options.codexThreadId) {
      return this.registry.setChannelDefaultCodexThread(options.channelType, options.codexThreadId);
    }
    return this.registry.setChannelDefaultClaudeThread(options.channelType, options.claudeSessionId!, options.claudeCwd!);
  }

  removeChannelDefaultTarget(channelType: string): void {
    this.registry.removeChannelDefaultTarget(channelType);
  }

  removeBinding(bindingId: string): void {
    this.registry.removeBinding(bindingId);
  }
}
