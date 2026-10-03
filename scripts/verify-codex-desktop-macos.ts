import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CodexAppServerClient, appServerWebSocketUrl, type AppServerMessage } from '../src/runtime/codex/app-server-client.js';
import { prepareCodexDesktopRemote, disableCodexDesktopRemote } from '../src/runtime/codex/desktop-remote.js';
import { CodexAppServerLifecycle } from '../src/runtime/codex/app-server-lifecycle.js';
import { fixtureEnvironment, fixtureModel, startFixtureModel, textInput } from './fixtures/codex-app-server-lifecycle.js';
import { DesktopGui, until } from './fixtures/desktop-gui-cdp.js';

const execute = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const home = os.homedir();
assert.equal(process.platform, 'darwin', '必须在原生 macOS 上验收，Linux 静态检查不能代替 GUI。');
assert.equal(process.env.CODELARK_DESKTOP_CI, '1', '只允许在一次性 macOS runner 中运行。');
if (process.argv.includes('--prepare')) {
  const remote = await prepareCodexDesktopRemote({ executable: process.env.CODELARK_CODEX_CLI_PATH!, env: process.env });
  assert(remote?.managed);
  process.stdout.write(JSON.stringify(remote));
  process.exit(0);
}

const evidence = path.resolve(process.env.CODELARK_DESKTOP_CI_EVIDENCE || '/tmp/codelark-desktop-gui-acceptance');
fs.mkdirSync(evidence, { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync('/tmp/clk-desktop-'));
const serviceRoot = path.join(home, '.codelark/codex-desktop');
assert(!fs.existsSync(serviceRoot), '拒绝替换既有共享 backend。');
const domain = `gui/${os.userInfo().uid}`;
const label = `${domain}/dev.codelark.codex-app-server`;
const plist = path.join(home, 'Library/LaunchAgents/dev.codelark.codex-app-server.plist');
assert(!fs.existsSync(plist), '拒绝覆盖既有 LaunchAgent。');
const app = path.join(home, 'Applications/Codex.app');
const result: Record<string, any> = {
  success: false, nativeMacOS: true, fullDesktopGuiTested: false, guiApprovalTested: false, guiQuestionTested: false,
  actualOsLoginTested: false, fixtureRoot: root, tuiRequiredForSubmission: false,
  runner: { githubActions: process.env.GITHUB_ACTIONS === 'true', name: process.env.RUNNER_NAME, os: process.env.RUNNER_OS,
    imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion, runId: process.env.GITHUB_RUN_ID },
  startupSequence: [],
};
const protocol: unknown[] = [];
const clients: Array<{ close(): void }> = [];
let gui: DesktopGui | undefined;
const originalPath = process.env.PATH!;
const executable = process.env.CODELARK_CODEX_CLI_PATH || (await execute('/usr/bin/which', ['codex'])).stdout.trim();
const nodePath = process.execPath;
// 不继承 CI 凭据、Bridge 身份、模型配置或任何代理环境。
for (const key of Object.keys(process.env)) delete process.env[key];
const model = await startFixtureModel();
Object.assign(process.env, fixtureEnvironment(root, model.baseUrl), {
  HOME: home, PATH: originalPath, SHELL: '/bin/bash', TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
  CODELARK_DESKTOP_CI: '1', CODELARK_CODEX_CLI_PATH: executable, GIT_TERMINAL_PROMPT: '0',
});
const run = async (command: string, args: string[]) => (await execute(command, args, {
  env: process.env, timeout: 40_000, maxBuffer: 4 * 1024 * 1024,
})).stdout.trim();
const sequence = (event: string, details: object = {}) => {
  const entry = { event, at: new Date().toISOString(), ...details };
  result.startupSequence.push(entry);
  fs.appendFileSync(path.join(evidence, 'startup-sequence.jsonl'), JSON.stringify(entry) + '\n');
};
const saveEvidence = () => {
  fs.writeFileSync(path.join(evidence, 'model-requests.json'), JSON.stringify(model.requests, null, 2));
  fs.writeFileSync(path.join(evidence, 'protocol.jsonl'), protocol.map((entry) => JSON.stringify(entry)).join('\n'));
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
};
async function backendPid(): Promise<number> {
  const description = await run('/bin/launchctl', ['print', label]);
  const pid = description.match(/\bpid = (\d+)/)?.[1];
  assert(pid, '隔离 LaunchAgent 未报告 backend PID');
  return Number(pid);
}
async function launch(name: string, threadId?: string) {
  assert(!gui, '每次只运行一个本 fixture 的 Desktop 实例');
  gui = new DesktopGui({ app, root, evidence, env: process.env, name });
  sequence('desktop-open', { name, threadId, launchdUrl: await run('/bin/launchctl', ['getenv', 'CODEX_APP_SERVER_WS_URL']).catch(() => '') });
  await gui.launch(threadId);
  const processes = gui.identity.processes as { processInfo: Array<{ type: string; id: number }> };
  const pid = processes.processInfo.find((process) => process.type === 'browser')?.id;
  assert(pid, 'CDP 必须报告本次 Electron 主进程');
  const binary = await run('/bin/ps', ['-p', String(pid), '-o', 'comm=']);
  assert(binary.startsWith(`${app}/Contents/MacOS/`), `窗口不是指定官方 App：${binary}`);
  gui.identity.binary = binary;
  // CoreGraphics 在 OS 层证明窗口属于本次 PID 且确实在屏幕上；不依赖 Chromium 的窗口管理扩展。
  assert(Number.isSafeInteger(pid));
  const windowQuery = `import Foundation
import CoreGraphics
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let own = windows.filter { ($0[kCGWindowOwnerPID as String] as? Int) == ${pid} && ($0[kCGWindowLayer as String] as? Int) == 0 }
print(String(data: try JSONSerialization.data(withJSONObject: own), encoding: .utf8)!)`;
  gui.identity.windows = await until(async () => {
    const windows = JSON.parse(await run('/usr/bin/swift', ['-e', windowQuery]));
    return windows.some((window: any) => window.kCGWindowBounds?.Width >= 500 && window.kCGWindowBounds?.Height >= 400)
      ? windows : false;
  }, 'CoreGraphics 确认官方 App 的可见窗口');
  // OS 截图作为补充；缺少 Screen Recording 权限时保留原因，不替代 CDP 窗口断言。
  await run('/usr/sbin/screencapture', ['-x', path.join(evidence, name, 'macos-display.png')])
    .catch((error) => { gui!.identity.osScreenshotError = String(error); });
  sequence('desktop-window-ready', { name, pid, binary });
  return gui;
}
async function closeGui() {
  if (!gui) return;
  await gui.close();
  gui = undefined;
  sequence('desktop-closed');
}
async function bootout() {
  const previous = await backendPid();
  await run('/bin/launchctl', ['bootout', label]);
  await until(async () => {
    if (await run('/bin/launchctl', ['print', label]).then(() => true, () => false)) return false;
    try { process.kill(previous, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; return true; }
  }, '本 fixture 的 LaunchAgent 和 backend 退出');
  sequence('backend-bootout', { pid: previous });
}
async function bootstrap(endpoint: string) {
  await run('/bin/launchctl', ['bootstrap', domain, plist]);
  const client = await until(async () => {
    try { return await CodexAppServerClient.connect(endpoint, 500); } catch { return false; }
  }, '保存的 LaunchAgent 启动');
  clients.push(client);
  sequence('backend-bootstrap-ready', { pid: await backendPid() });
  return client;
}

try {
  const guiDomain = await run('/bin/launchctl', ['print', domain]);
  result.loginEvidence = {
    uid: os.userInfo().uid, consoleUser: await run('/usr/bin/stat', ['-f', '%Su', '/dev/console']),
    who: await run('/usr/bin/who', []), os: await run('/usr/bin/sw_vers', []),
    domain: guiDomain.split('\n').filter((line) => /(?:type|handle|creator|session) =/.test(line)).slice(0, 20),
    actualOsLogin: { status: 'not-tested', reason: '本 job 已位于 GUI 会话中；只在当前会话操作自己的 LaunchAgent，没有注销、登录或新建登录会话证据。',
      required: '专用可登录 Mac、会话外监督器、跨 logout 存活的 mock 模型及持久证据目录；详见 docs/testing/codex-desktop.md。' },
  };
  for (const name of ['CODEX_APP_SERVER_WS_URL', 'CODEX_APP_SERVER_FORCE_CLI']) {
    assert.equal(await run('/bin/launchctl', ['getenv', name]).catch(() => ''), '', `拒绝改变已有 ${name}`);
  }
  assert.equal(await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')]), 'com.openai.codex');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  result.desktopVersion = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')]);
  result.desktopAsarSha256 = createHash('sha256').update(fs.readFileSync(path.join(app, 'Contents/Resources/app.asar'))).digest('hex');
  result.cliVersion = await run(executable, ['--version']);
  result.revision = await run('/usr/bin/git', ['rev-parse', 'HEAD']);
  result.sourceHashes = Object.fromEntries([script, ...['desktop-gui-cdp.ts', 'desktop-gui-onboarding.ts']
    .map((file) => fileURLToPath(new URL(`./fixtures/${file}`, import.meta.url)))]
    .map((file) => [path.basename(file), createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
  const first = JSON.parse(await run(nodePath, ['--import', 'tsx', script, '--prepare']));
  const originalBackendPid = await backendPid();
  result.backendPid = originalBackendPid;
  sequence('backend-prepared', { pid: originalBackendPid });
  const second = JSON.parse(await run(nodePath, ['--import', 'tsx', script, '--prepare']));
  assert.equal(first.endpoint, second.endpoint);
  assert.equal(await backendPid(), originalBackendPid);
  result.survivesBridgeProcessExit = true;
  result.reusesBackend = true;
  const wsUrl = appServerWebSocketUrl(first.endpoint);
  result.desktopConnectionUrl = wsUrl;
  result.desktopConnectionHostname = new URL(wsUrl).hostname;
  assert.equal(await run('/bin/launchctl', ['getenv', 'CODEX_APP_SERVER_WS_URL']), wsUrl);

  const connect = async () => {
    const client = await CodexAppServerClient.connect(first.endpoint);
    assert.equal(client.serverInfo.codexHome, process.env.CODEX_HOME);
    client.onMessage((message: AppServerMessage) => protocol.push({ source: 'bridge-observer', message }));
    return client;
  };
  const lifecycle = new CodexAppServerLifecycle(first.endpoint, { connect });
  clients.push(lifecycle);
  const threadId = await lifecycle.ensureThread({
    cwd: path.join(root, 'workspace'), model: fixtureModel, approvalPolicy: 'on-request', sandbox: 'read-only',
  });
  result.threadId = threadId;
  const complete = async (turnId: string) => until(async () => lifecycle.recordsAfter(threadId).records.some((record) =>
    record.turnId === turnId && record.type === 'task_complete' && !record.isError), `共享线程轮次 ${turnId} 完成`);
  const bridgeTurn = async (input: string, output: string) => {
    model.enqueue({ text: output });
    const turn = await lifecycle.submit(threadId, textInput(input));
    await complete(turn); return turn;
  };
  await bridgeTurn('DESKTOP_GUI_SEED', 'DESKTOP_GUI_SEED_RESPONSE');
  await launch('01-backend-before-desktop', threadId);
  result.guiOnboardingCompleted = await gui!.finishOnboarding(threadId, 'DESKTOP_GUI_SEED_RESPONSE');
  sequence('desktop-onboarding-ready', { completedThroughGui: result.guiOnboardingCompleted });
  await gui!.expectText('DESKTOP_GUI_SEED_RESPONSE');
  await gui!.capture('seed-shared-thread');
  // 由 Bridge 提交，必须在真实 GUI 中收到新内容。
  await bridgeTurn('BRIDGE_WITHOUT_TUI', 'BRIDGE_VISIBLE_IN_DESKTOP_GUI');
  await gui!.expectText('BRIDGE_VISIBLE_IN_DESKTOP_GUI');
  await gui!.capture('bridge-received');
  result.protocolSubmissionWithoutTui = true;
  // 由真实 Desktop 编辑框提交，Bridge 必须收到同一 thread 的新用户/助手消息。
  const beforeGui = model.requests.length;
  model.enqueue({ text: 'DESKTOP_GUI_REPLY' });
  await gui!.send('DESKTOP_GUI_INPUT');
  await gui!.expectText('DESKTOP_GUI_REPLY');
  const guiReply = await until(async () => lifecycle.recordsAfter(threadId).records.find((record) => record.role === 'assistant' && record.content.includes('DESKTOP_GUI_REPLY')) || false, 'Bridge 观察 GUI 回复');
  assert(guiReply.turnId, 'GUI 回复必须关联到实际 turn');
  await complete(guiReply.turnId);
  assert(lifecycle.recordsAfter(threadId).records.some((record) => record.role === 'user' && record.content.includes('DESKTOP_GUI_INPUT')));
  assert.equal(model.requests.length, beforeGui + 1, '一次 GUI 发送只能发起一个模型请求');
  assert(JSON.stringify(model.requests.at(-1)!.body.input).includes('DESKTOP_GUI_INPUT'));
  await gui!.capture('gui-sent-and-received');
  result.fullDesktopGuiTested = true;
  result.launchServicesEnvironment = true; // 由真实 App 可见同线程及双向轮次证明，非假 .app probe。

  // 只有模型返回受控工具；审批点击来自 GUI，观察端从不答复审批。
  model.enqueue((body) => {
    const names = (body.tools || []).map((tool) => tool.name);
    const tool = ['exec_command', 'shell_command', 'shell'].find((name) => names.includes(name));
    assert(tool, `官方 CLI 未提供命令工具：${names.join(',')}`);
    const command = 'printf DESKTOP_GUI_APPROVAL_EXECUTED';
    return { tool, arguments: {
      ...(tool === 'exec_command' ? { cmd: command } : tool === 'shell_command' ? { command } : { command: ['/bin/sh', '-c', command] }),
      sandbox_permissions: 'require_escalated', justification: '仅输出隔离 Desktop GUI 验收标记',
    } };
  });
  model.enqueue({ text: 'DESKTOP_GUI_APPROVAL_FINISHED' });
  const approvalTurn = await lifecycle.submit(threadId, textInput('DESKTOP_GUI_APPROVAL'));
  const approval = await until(async () => lifecycle.snapshot(threadId).requests.find((request) =>
    request.method === 'item/commandExecution/requestApproval') || false, '真实命令审批抵达 Bridge');
  await gui!.expectText('DESKTOP_GUI_APPROVAL_EXECUTED');
  await gui!.capture('approval-pending');
  await gui!.button(['Allow once']);
  await complete(approvalTurn);
  await until(async () => !lifecycle.snapshot(threadId).requests.some((request) => request.key === approval.key), 'GUI 答复后 Bridge 旧审批失效');
  assert(protocol.some((entry: any) => entry.message.method === 'item/completed' && entry.message.params.threadId === threadId
    && entry.message.params.item.type === 'commandExecution' && entry.message.params.item.exitCode === 0
    && entry.message.params.item.aggregatedOutput?.includes('DESKTOP_GUI_APPROVAL_EXECUTED')));
  await gui!.expectText('DESKTOP_GUI_APPROVAL_FINISHED');
  await gui!.capture('approval-completed');
  result.guiApprovalTested = true;

  const controller = await connect();
  clients.push(controller);
  model.enqueue((body) => {
    assert(body.tools?.some((tool) => tool.name === 'request_user_input'), 'Plan 模式没有 request_user_input，不能宣称 GUI 问答通过');
    return { tool: 'request_user_input', arguments: { questions: [{ id: 'desktop_color', header: '颜色', question: 'DESKTOP_GUI_QUESTION',
      options: [{ label: 'GUI_BLUE', description: '选择蓝色验收标记' }, { label: 'GUI_GREEN', description: '选择绿色验收标记' }] }] } };
  });
  model.enqueue({ text: 'DESKTOP_GUI_QUESTION_FINISHED' });
  const questionStart = await controller.request<any>('turn/start', { threadId, input: textInput('DESKTOP_GUI_QUESTION_INPUT'),
    collaborationMode: { mode: 'plan', settings: { model: fixtureModel, reasoning_effort: null, developer_instructions: null } } });
  const question = await until(async () => lifecycle.snapshot(threadId).requests.find((request) =>
    request.method === 'item/tool/requestUserInput') || false, '真实问答抵达 Bridge');
  await gui!.expectText('DESKTOP_GUI_QUESTION');
  await gui!.capture('question-pending');
  await gui!.button(['GUI_BLUE']);
  await gui!.button(['Submit']);
  await complete(questionStart.turn.id);
  await until(async () => !lifecycle.snapshot(threadId).requests.some((request) => request.key === question.key), 'GUI 问答提交后 Bridge 请求失效');
  const toolOutputs = model.requests.at(-1)!.body.input?.filter((item: any) => item.type === 'function_call_output');
  assert(JSON.stringify(toolOutputs).includes('GUI_BLUE'), '模型必须收到 GUI 选择的实际工具结果');
  await gui!.expectText('DESKTOP_GUI_QUESTION_FINISHED');
  await gui!.capture('question-completed');
  result.guiQuestionTested = true;
  controller.close();

  await closeGui();
  assert.equal(await backendPid(), originalBackendPid);
  await launch('02-desktop-reopen', threadId);
  await gui!.expectText('DESKTOP_GUI_QUESTION_FINISHED');
  await bridgeTurn('AFTER_DESKTOP_REOPEN', 'DESKTOP_REOPEN_SHARED_REPLY');
  await gui!.expectText('DESKTOP_REOPEN_SHARED_REPLY');
  await gui!.capture('reopened-thread');
  result.desktopReopenSharesThread = true;
  await closeGui();
  lifecycle.close();
  const afterDetach = await connect(); clients.push(afterDetach);
  assert.equal((await afterDetach.request<any>('thread/read', { threadId })).thread.id, threadId);
  assert.equal(await backendPid(), originalBackendPid);
  result.backendSurvivesClientExit = true;
  afterDetach.close();

  // 当前 GUI 会话内的受控先后顺序；绝不声称是真实 OS 注销/登录。
  await bootout();
  await run('/bin/launchctl', ['unsetenv', 'CODEX_APP_SERVER_WS_URL']);
  const restored = await bootstrap(first.endpoint);
  assert.notEqual(await backendPid(), originalBackendPid);
  assert.equal(await run('/bin/launchctl', ['getenv', 'CODEX_APP_SERVER_WS_URL']), wsUrl);
  await launch('03-persisted-service-before-desktop', threadId);
  await gui!.expectText('DESKTOP_REOPEN_SHARED_REPLY');
  await gui!.capture('restored-thread');
  assert.equal((await restored.request<any>('thread/resume', { threadId })).thread.id, threadId);
  result.persistedLaunchAgentRestarts = true;
  result.restoresEnvironmentWithoutBridge = true;
  result.resumesAfterBackendRestart = true;
  await closeGui(); restored.close();

  await bootout();
  await run('/bin/launchctl', ['unsetenv', 'CODEX_APP_SERVER_WS_URL']);
  // Desktop 先打开，可能恢复上次窗口；此时不能声称已经连接共享 backend。
  await launch('04-desktop-before-service');
  await gui!.capture('before-service');
  const late = await bootstrap(first.endpoint);
  await gui!.capture('service-started-existing-window');
  sequence('late-service-requires-desktop-reopen');
  await closeGui();
  await launch('05-reopen-after-late-service', threadId);
  await gui!.expectText('DESKTOP_REOPEN_SHARED_REPLY');
  await gui!.capture('late-service-recovered');
  result.desktopBeforeServiceRecoveredAfterReopen = true;
  result.desktopBeforeServiceWithoutReopen = 'not-verified';
  await closeGui(); late.close();

  fs.copyFileSync(plist, path.join(evidence, 'launchagent.plist'));
  await disableCodexDesktopRemote();
  assert.equal(await run('/bin/launchctl', ['getenv', 'CODEX_APP_SERVER_WS_URL']).catch(() => ''), '');
  assert.equal(await prepareCodexDesktopRemote({ executable, env: process.env }), undefined);
  result.disableClearsSharedConfiguration = true;
  await launch('06-disabled-default-desktop', threadId);
  await gui!.expectText('DESKTOP_REOPEN_SHARED_REPLY');
  const beforeDefault = model.requests.length;
  model.enqueue({ text: 'DESKTOP_DEFAULT_GUI_REPLY' });
  await gui!.send('DESKTOP_DEFAULT_GUI_INPUT');
  await gui!.expectText('DESKTOP_DEFAULT_GUI_REPLY');
  assert.equal(model.requests.length, beforeDefault + 1);
  assert(JSON.stringify(model.requests.at(-1)!.body.input).includes('DESKTOP_DEFAULT_GUI_INPUT'));
  assert.equal(await run('/bin/launchctl', ['print', label]).then(() => true, () => false), false);
  await gui!.capture('default-gui-after-disable');
  await closeGui();
  result.disabledDesktopDefaultGui = true;
  assert.deepEqual(model.unexpected, []);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(app, 'Contents/Resources/app.asar'))).digest('hex'), result.desktopAsarSha256);
  result.success = true;
} catch (error) {
  result.error = error instanceof Error ? error.stack : String(error);
  result.desktopStartupDiagnostics = gui?.startupDiagnostics();
  process.exitCode = 1;
  saveEvidence(); // 首次失败立即落盘，不能等 GUI 退出或截图成功才保留根因。
  if (gui) await gui.capture('failure').catch((error) => { result.captureError = String(error); });
  await run('/usr/sbin/screencapture', ['-x', path.join(evidence, 'failure-macos-display.png')])
    .catch((error) => { result.osScreenshotError = String(error); });
} finally {
  await closeGui().catch((error) => { result.desktopCleanupError = String(error); process.exitCode = 1; });
  for (const client of clients) client.close();
  if (fs.existsSync(path.join(serviceRoot, 'installation.json'))) await disableCodexDesktopRemote().catch((error) => { result.cleanupError = String(error); process.exitCode = 1; });
  const log = path.join(serviceRoot, 'app-server.log');
  if (fs.existsSync(log)) fs.copyFileSync(log, path.join(evidence, 'backend.log'));
  await model.close();
  if (process.exitCode) result.success = false;
  saveEvidence();
  console.log(JSON.stringify(result));
}
