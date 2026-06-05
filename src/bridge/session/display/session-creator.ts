export interface CodexSourceSummary {
  originator?: string;
  source?: string;
  cliVersion?: string;
}

export type CreatorKind =
  | 'bridge'
  | 'sdk'
  | 'vscode'
  | 'tui_cli'
  | 'desktop'
  | 'native';

export function resolveCreatorKind(input: {
  bridgeSession?: boolean;
  source?: string | null;
  originator?: string | null;
}): CreatorKind {
  if (input.bridgeSession) return 'bridge';
  const source = (input.source || '').toLowerCase();
  const originator = (input.originator || '').toLowerCase();
  if (source === 'codex_sdk_ts' || originator.includes('codex_sdk_ts')) return 'sdk';
  if (originator.includes('vscode') || source.includes('vscode')) return 'vscode';
  if (originator.includes('tui') || source.includes('tui') || source.includes('codex_tui')) return 'tui_cli';
  if (originator.includes('cli') || source.includes('cli')) return 'tui_cli';
  if (originator.includes('desktop') || source.includes('desktop')) return 'desktop';
  return 'native';
}

export function formatCreatorBadge(kind: CreatorKind): { label: string; className: string } {
  switch (kind) {
    case 'bridge':
      return { label: 'Bridge', className: 'bridge' };
    case 'sdk':
      return { label: 'SDK', className: 'sdk' };
    case 'vscode':
      return { label: 'VS Code', className: 'vscode' };
    case 'tui_cli':
      return { label: 'TUI / CLI', className: 'tui' };
    case 'desktop':
      return { label: 'Desktop', className: 'desktop' };
    case 'native':
    default:
      return { label: 'Native', className: 'native' };
  }
}
