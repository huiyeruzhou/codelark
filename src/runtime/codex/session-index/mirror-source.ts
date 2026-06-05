import {
  getCodexSessionByThreadId,
  readCodexSessionMirrorRecordDeltaByFilePath,
} from './core.js';
import type { MirrorJsonlSource, MirrorJsonlSourceSummary } from '../../contracts.js';

export function createCodexMirrorJsonlSource(): MirrorJsonlSource {
  return {
    runtime: 'codex',
    findByThreadId(threadId: string): MirrorJsonlSourceSummary | null {
      const summary = getCodexSessionByThreadId(threadId);
      return summary
        ? {
          threadId: summary.threadId,
          filePath: summary.filePath,
          cwd: summary.cwd,
          updatedAt: summary.lastEventAt,
        }
        : null;
    },
    readDelta(
      filePath,
      startOffset,
      endOffset,
      trailingText,
      currentTurnId,
      currentSpecialCallIds,
    ) {
      return readCodexSessionMirrorRecordDeltaByFilePath(
        filePath,
        startOffset,
        endOffset,
        trailingText,
        currentTurnId,
        currentSpecialCallIds,
      );
    },
  };
}
