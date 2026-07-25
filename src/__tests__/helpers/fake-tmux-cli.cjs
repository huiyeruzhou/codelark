const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const logPath = process.env.TMUX_FAKE_LOG;
const statePath = process.env.TMUX_FAKE_STATE_PATH || `${logPath}.sessions`;
const fakeCodexRoot = process.env.CODELARK_FAKE_CODEX_TUI_STATE_DIR || '';
const fakeCodexControl = process.env.CODELARK_FAKE_CODEX_TUI_CONTROL || '';

if (logPath) fs.appendFileSync(logPath, `${args.join(' ')}\n`);

function safeName(value) {
  return String(value || 'default').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function readSessions() {
  try {
    return fs.readFileSync(statePath, 'utf-8').split(/\r?\n/u).filter(Boolean);
  } catch {
    return [];
  }
}

function writeSessions(sessions) {
  fs.writeFileSync(statePath, sessions.length ? `${sessions.join('\n')}\n` : '', 'utf-8');
}

function removeSession(target) {
  writeSessions(readSessions().filter((session) => session !== target));
}

function fakeCodexFile(target, suffix) {
  return `${fakeCodexRoot}/${safeName(target)}${suffix}`;
}

function targetExists(target) {
  if (fakeCodexRoot && fs.existsSync(fakeCodexFile(target, '.exited'))) {
    removeSession(target);
    return false;
  }
  if (['alpha', 'beta', 'codex_existing'].includes(target)) return true;
  if ((process.env.TMUX_FAKE_EXISTING_SESSIONS || '').split(',').includes(target)) return true;
  return readSessions().includes(target);
}

function optionValue(option) {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] || '' : '';
}

function runFakeCodex(controlArgs) {
  if (!fakeCodexControl) return;
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || process.env.COMSPEC || 'cmd.exe', [
        '/d', '/s', '/c', `"${fakeCodexControl}" ${controlArgs.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(' ')}`,
      ], { env: process.env, stdio: 'ignore' })
    : spawnSync(fakeCodexControl, controlArgs, { env: process.env, stdio: 'ignore' });
  if (result.error) process.stderr.write(`${result.error.message}\n`);
}

switch (args[0]) {
  case 'list-sessions':
    process.stdout.write('alpha\t1\t0\t0\t0\nbeta\t2\t1\t0\t0\n');
    break;
  case 'has-session':
    process.exit(targetExists(optionValue('-t')) ? 0 : 1);
    break;
  case 'kill-session':
    removeSession(optionValue('-t'));
    break;
  case 'new-session': {
    const target = optionValue('-s');
    const commandIndex = args.indexOf('--');
    const commandText = commandIndex >= 0 ? args.slice(commandIndex + 1).join(' ') : '';
    if (process.env.TMUX_FAKE_LAUNCH_STDERR) {
      const match = commandText.match(/\s2>\s+(?:'([^']+)'|"([^"]+)"|(\S+))/u);
      const launchLogPath = match?.[1] || match?.[2] || match?.[3];
      if (launchLogPath) {
        fs.mkdirSync(require('node:path').dirname(launchLogPath), { recursive: true });
        fs.writeFileSync(launchLogPath, process.env.TMUX_FAKE_LAUNCH_STDERR, 'utf-8');
      }
      break;
    }
    if (target) {
      const sessions = readSessions();
      if (!sessions.includes(target)) writeSessions([...sessions, target]);
      if (fakeCodexRoot && fakeCodexControl && commandText) {
        runFakeCodex(['__codelark_fake_tui', 'start-target', target]);
      }
    }
    break;
  }
  case 'send-keys': {
    const target = optionValue('-t');
    let literal = false;
    let skipLiteralSeparator = false;
    for (let index = 1; index < args.length; index += 1) {
      const value = args[index];
      if (value === '-t') {
        index += 1;
        continue;
      }
      if (value === '-l') {
        literal = true;
        skipLiteralSeparator = true;
        continue;
      }
      if (literal && skipLiteralSeparator && value === '--') {
        skipLiteralSeparator = false;
        continue;
      }
      runFakeCodex(['__codelark_fake_tui', literal ? 'send-literal' : 'send-key', target, value]);
      literal = false;
      skipLiteralSeparator = false;
    }
    break;
  }
  case 'capture-pane': {
    if (process.env.TMUX_FAKE_CAPTURE_TEXT) {
      process.stdout.write(process.env.TMUX_FAKE_CAPTURE_TEXT.replace(/\\n/g, '\n'));
      break;
    }
    const target = optionValue('-t');
    if (!targetExists(target)) {
      process.stderr.write(`can't find pane ${target}\n`);
      process.exit(1);
    }
    runFakeCodex(['__codelark_fake_tui', 'capture', target]);
    const screenPath = fakeCodexFile(target, '.screen');
    if (fakeCodexRoot && fs.existsSync(screenPath)) {
      process.stdout.write(fs.readFileSync(screenPath, 'utf-8'));
      break;
    }
    const countPath = `${logPath}.${safeName(target)}.captures`;
    let count = 0;
    try { count = Number.parseInt(fs.readFileSync(countPath, 'utf-8'), 10) || 0; } catch {}
    count += 1;
    fs.writeFileSync(countPath, String(count), 'utf-8');
    const readyAfter = Number.parseInt(process.env.TMUX_FAKE_READY_AFTER_CAPTURES || '0', 10) || 0;
    process.stdout.write(count <= readyAfter
      ? 'alpha-screen\nCodex starting...\n'
      : 'alpha-screen\nOpenAI Codex\n› \n');
    break;
  }
  default:
    break;
}
