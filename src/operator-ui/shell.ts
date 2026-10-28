// CodeLark 工作台外壳：页面骨架 + 模态框宿主，组装各页面模板与浏览器端脚本。
// 页面模板见 ./pages.ts，浏览器端脚本见 ./ui-script.ts，样式见 ./assets.ts。

import { resolveInstalledCodelarkVersion } from '../bridge/update/installed-version.js';
import { mainStyles } from './assets.js';
import { projectRuntimeStatusBrowserSource } from './runtime-status.js';
import {
  overviewPageHtml,
  appServerPageHtml,
  sessionsPageHtml,
  sessionHistoryPageHtml,
  configPageHtml,
  commandsPageHtml,
  channelsPageHtml,
  logsPageHtml,
} from './pages.js';
import { uiClientScript } from './ui-script.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderUiShellHtml(): string {
  const version = escapeHtml(resolveInstalledCodelarkVersion() || 'unknown');
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CodeLark</title>
    <style>${mainStyles}</style>
  </head>
  <body>
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-heading">
            <p class="brand-title">CodeLark</p>
            <span class="brand-version">v${version}</span>
          </div>
        </div>
        <nav class="nav">
          <button type="button" class="nav-link active" data-page="overview">概览</button>
          <button type="button" class="nav-link" data-page="app-server">app-server</button>
          <button type="button" class="nav-link" data-page="sessions">会话</button>
          <button type="button" class="nav-link" data-page="config">配置</button>
          <button type="button" class="nav-link" data-page="channels">通道</button>
          <button type="button" class="nav-link" data-page="logs">日志</button>
          <button type="button" class="nav-link" data-page="commands">命令说明</button>
        </nav>
      </aside>
      <main class="main">
${overviewPageHtml(version)}
${appServerPageHtml}
${sessionsPageHtml}
${sessionHistoryPageHtml}
${configPageHtml}
${commandsPageHtml}
${channelsPageHtml}
${logsPageHtml}      </main>
    </div>
    <div id="globalMessageHost" class="global-message-host" aria-live="polite"></div>
    <div id="sessionChannelModal" class="modal-backdrop" hidden>
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="sessionChannelModalTitle">
        <div class="modal-head">
          <div>
            <h2 id="sessionChannelModalTitle">指定通道</h2>
            <p id="sessionChannelModalSubtitle">选择一个聊天入口，将它切换到当前会话。</p>
          </div>
          <button type="button" class="icon-btn ghost-icon" data-action="close-session-channel-modal" aria-label="关闭" title="关闭"><span aria-hidden="true">×</span></button>
        </div>
        <div id="sessionChannelModalList" class="modal-list"></div>
      </section>
    </div>
    <div id="sessionRenameModal" class="modal-backdrop" hidden>
      <section class="modal-card modal-card-narrow" role="dialog" aria-modal="true" aria-labelledby="sessionRenameTitle">
        <div class="modal-head">
          <div>
            <h2 id="sessionRenameTitle">重命名会话</h2>
            <p id="sessionRenameSubtitle">给当前会话设置一个更好识别的名字。</p>
          </div>
          <button type="button" class="icon-btn ghost-icon" data-action="close-session-rename-modal" aria-label="关闭" title="关闭"><span aria-hidden="true">×</span></button>
        </div>
        <label>
          会话名称
          <input id="sessionRenameInput" />
        </label>
        <div class="toolbar modal-actions">
          <button type="button" data-action="close-session-rename-modal">取消</button>
          <button type="button" class="primary" data-action="save-session-rename">保存名称</button>
        </div>
      </section>
    </div>
    <div id="sessionConfigModal" class="modal-backdrop" hidden>
      <section class="modal-card modal-card-wide" role="dialog" aria-modal="true" aria-labelledby="sessionConfigTitle">
        <div class="modal-head">
          <div>
            <h2 id="sessionConfigTitle">会话配置</h2>
            <p id="sessionConfigSubtitle">这些设置只影响当前会话。</p>
          </div>
          <button type="button" class="icon-btn ghost-icon" data-action="close-session-config-modal" aria-label="关闭" title="关闭"><span aria-hidden="true">×</span></button>
        </div>
        <p id="sessionConfigBackendStatus" class="muted" hidden></p>
        <div class="fields">
          <div class="field-row">
            <label>会话名称<input id="sessionConfigName" /></label>
            <label>工作目录<input id="sessionConfigCwd" /></label>
          </div>
          <div class="field-row triple" id="sessionConfigCodexBlock">
            <label>Codex 模型<select id="sessionConfigModel"></select></label>
            <label>Codex 模式<select id="sessionConfigMode"><option value="normal">normal</option><option value="yolo">yolo</option></select></label>
            <label>Codex Provider<select id="sessionConfigProvider"><option value="">default</option><option value="tmux">tmux</option></select></label>
            <label>Codex 思考级别<select id="sessionConfigReasoning"><option value="">跟随全局</option><option value="medium">medium</option><option value="minimal">minimal</option><option value="low">low</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option><option value="ultra">ultra</option></select></label>
          </div>
          <div class="field-row" id="sessionConfigCodexSandboxBlock">
            <label>文件系统权限<select id="sessionConfigSandbox"><option value="">跟随全局</option><option value="workspace-write">workspace-write</option><option value="read-only">read-only</option><option value="danger-full-access">danger-full-access</option></select></label>
            <label>网络访问<select id="sessionConfigNetwork"><option value="">跟随全局</option><option value="on">允许</option><option value="off">禁止</option></select></label>
          </div>
          <div class="field-row triple" id="sessionConfigClaudeBlock" hidden>
            <label>Claude 模型<input id="sessionConfigClaudeModel" placeholder="留空跟随全局 Claude 默认模型" /></label>
            <label>Claude 思考级别<select id="sessionConfigClaudeReasoning"><option value="">跟随全局</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select></label>
          </div>
          <div class="field-row triple" id="sessionConfigKimiBlock" hidden>
            <label>Kimi 模型<input id="sessionConfigKimiModel" placeholder="留空跟随全局 Kimi 默认模型" /></label>
            <label>Kimi Provider<select id="sessionConfigKimiProvider"><option value="">跟随全局</option><option value="tmux">tmux</option></select></label>
            <label>Kimi Thinking<select id="sessionConfigKimiThinking"><option value="">跟随全局</option><option value="default">跟随 Kimi CLI</option><option value="on">on</option><option value="off">off</option></select></label>
          </div>
          <div class="field-row triple" id="sessionConfigCursorBlock" hidden>
            <label>Cursor 模型<input id="sessionConfigCursorModel" placeholder="留空跟随全局 Cursor 默认模型" /></label>
            <label>Cursor Provider<select id="sessionConfigCursorProvider"><option value="">跟随全局</option><option value="tmux">tmux</option></select></label>
            <label>Cursor 思考级别<select id="sessionConfigCursorReasoning"><option value="">跟随全局</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select></label>
            <label>Cursor force<select id="sessionConfigCursorForce"><option value="">跟随全局</option><option value="on">启用</option><option value="off">关闭</option></select></label>
          </div>
          <div class="field-row triple" id="sessionConfigZcodeBlock" hidden>
            <label>ZCode 模型<input id="sessionConfigZcodeModel" placeholder="留空跟随全局 ZCode 默认模型" /></label>
            <label>ZCode Provider<select id="sessionConfigZcodeProvider"><option value="">跟随全局</option><option value="tmux">tmux</option></select></label>
            <label>ZCode 模式<select id="sessionConfigZcodeMode"><option value="">跟随全局</option><option value="build">build</option><option value="edit">edit</option><option value="plan">plan</option><option value="yolo">yolo</option></select></label>
          </div>
          <label>系统提示<textarea id="sessionConfigPrompt" placeholder="留空则不覆盖系统提示"></textarea></label>
        </div>
        <div class="toolbar modal-actions">
          <button type="button" data-action="close-session-config-modal">取消</button>
          <button type="button" class="primary" data-action="save-session-config">保存配置</button>
        </div>
      </section>
    </div>

${uiClientScript(projectRuntimeStatusBrowserSource)}  </body>
</html>`;
}
