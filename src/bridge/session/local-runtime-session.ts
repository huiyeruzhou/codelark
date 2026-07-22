import type { RuntimeAgent } from '../../domain/session.js';

export interface LocalRuntimeSessionSummary {
  runtime: RuntimeAgent;
  threadId: string;
  filePath: string;
  cwd: string;
  originator: string;
  source?: string;
  cliVersion?: string;
  firstSeenAt: string;
  lastEventAt: string;
  title: string;
  activeEstimate: boolean;
  userInputTurns?: number;
}
