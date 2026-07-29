export interface ProviderStreamTerminalState {
  streamKey: string;
  status: string;
}

interface ProviderStreamTerminalInput {
  streamKeys: string[];
  logText: string;
  streamPrefix: string;
  excludedStreamKeys?: Iterable<string>;
}

function terminalStatusFromLogLine(line: string): string | undefined {
  let message = line;
  try {
    const record = JSON.parse(line) as { msg?: unknown };
    if (typeof record.msg === 'string') message = record.msg;
  } catch {
    // Legacy plain-text logs use the same finalization messages.
  }
  return message.match(/Card finalized: .*\bstatus=([a-z_-]+)/iu)?.[1]
    || message.match(/Final card update payload: .*\bstatus:\s*['"]?([a-z_-]+)/iu)?.[1];
}

export function findLatestProviderStreamTerminalState(
  input: ProviderStreamTerminalInput,
): ProviderStreamTerminalState | undefined {
  const excluded = new Set(input.excludedStreamKeys || []);
  const candidates = input.streamKeys
    .filter((streamKey) => streamKey.startsWith(input.streamPrefix) && !excluded.has(streamKey))
    .reverse();
  const lines = input.logText.split(/\r?\n/).reverse();
  for (const streamKey of candidates) {
    for (const line of lines) {
      if (!line.includes(streamKey)) continue;
      const status = terminalStatusFromLogLine(line);
      if (status) return { streamKey, status: status.toLowerCase() };
    }
  }
  return undefined;
}
