import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const forbidden = [
  {
    file: path.join('src', 'bridge'),
    pattern: /\bawait\s+[\w.()[\]?]+\s*\.\s*(?:addMessageReaction|removeMessageReaction)\s*\(/,
    message: 'Bridge code must not await IM reaction side effects; run them in a fire-and-forget helper.',
  },
  {
    file: path.join('src', 'bridge', 'host', 'manager.ts'),
    pattern: /\bawait\s+markPendingTmuxAutoForwardReaction\s*\(/,
    message: 'tmux auto-forward Typing reaction must not block the forwarding path.',
  },
  {
    file: path.join('src', 'bridge', 'host', 'manager.ts'),
    pattern: /\bawait\s+adapter\s*\.\s*answerCallback\??\s*\(/,
    message: 'Callback acknowledgement must not block the inbound handler.',
  },
  {
    file: path.join('src', 'bridge', 'session', 'command-use-cases'),
    pattern: /\bawait\s+reconcileMirrorSubscriptionsBestEffort\s*\(/,
    message: 'Session commands must schedule mirror reconcile outside the session lane.',
  },
  {
    file: path.join('src', 'bridge', 'session', 'command-use-cases'),
    pattern: /\bawait\s+(?:options\.)?adapter\s*\.\s*renameGroupChat\s*\(/,
    message: 'Session commands must not wait for group rename acknowledgement.',
  },
  {
    file: path.join('src', 'bridge', 'command', 'dispatch.ts'),
    pattern: /\bawait\s+options\s*\.\s*adapter\s*\.\s*renameGroupChat\s*\(/,
    message: 'Command dispatch must not wait for group rename acknowledgement.',
  },
  {
    file: path.join('src', 'bridge', 'command', 'dispatch.ts'),
    pattern: /\bawait\s+new\s+Promise<[^>]*>\s*\(\s*\(resolve\)\s*=>\s*setImmediate\s*\(/,
    message: 'Command dispatch must not yield merely to make background delivery observable to callers.',
  },
  {
    file: path.join('src', 'bridge', 'permission', 'broker.ts'),
    pattern: /\bawait\s+deliver\s*\(/,
    message: 'Permission cards must be enqueued; the caller must not wait for the platform acknowledgement.',
  },
  {
    file: path.join('src', 'bridge'),
    pattern: /\bawait\s+(?:permissionBroker\.|broker\.)?forwardPermissionRequest\s*\(/,
    message: 'Permission forwarding must not block a turn or tmux selection path.',
  },
  {
    file: path.join('src', 'channels', 'feishu', 'adapter.ts'),
    pattern: /\bawait\s+this\.(?:sendCloudDocumentForwardNotice|notifyUnsupportedInboundContent|addCloudDocumentTypingReaction)\s*\(/,
    message: 'Feishu inbound routing must enqueue UI notices and reactions without waiting for remote acknowledgement.',
  },
];

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(fullPath);
    if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
    return [fullPath];
  });
}

const findings = [];

for (const rule of forbidden) {
  const target = path.join(repoRoot, rule.file);
  const files = fs.statSync(target).isDirectory() ? listFiles(target) : [target];
  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    const lines = fs.readFileSync(file, 'utf8').split(/\n/);
    for (const [index, line] of lines.entries()) {
      if (!rule.pattern.test(line)) continue;
      findings.push(`${rel}:${index + 1}: ${rule.message}\n  ${line.trim()}`);
    }
  }
}

if (findings.length > 0) {
  console.error('Synchronous bridge side-effect calls are forbidden:\n');
  console.error(findings.join('\n\n'));
  process.exit(1);
}
