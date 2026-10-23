/** Dependency-free tmux screen parsing shared by runtime providers and bridge orchestration. */

export interface RuntimeTmuxPaneDead {
  status?: number;
  line: string;
}

export function detectRuntimeTmuxPaneDead(screen: string | undefined): RuntimeTmuxPaneDead | undefined {
  const line = (screen || '').split(/\r?\n/).find((candidate) => /Pane is dead \(status \d+/i.test(candidate));
  if (!line) return undefined;
  const statusMatch = line.match(/Pane is dead \(status (\d+)/i);
  return {
    ...(statusMatch ? { status: Number(statusMatch[1]) } : {}),
    line: line.trim(),
  };
}
