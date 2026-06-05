export interface LocalRuntimeSessionSummary {
  runtime: 'codex' | 'claude';
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
