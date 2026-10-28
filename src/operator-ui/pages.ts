// 由 src/operator-ui/shell.ts 按页面 section 拆分生成（结构重构，行为不变）。
// 每个导出渲染对应 <section class="page"> 的静态 HTML 模板；动态插值仅 version。

export function overviewPageHtml(version: string): string {
  return `        <section class="page active" data-page="overview">
          <div class="page-header">
            <div>
              <h1 class="page-title">概览</h1>
              <p class="page-copy">查看运行状态，控制 Bridge，并核对本机环境。</p>
            </div>
          </div>

          <section class="bridge-path" aria-label="CodeLark 当前运行链路">
            <article class="bridge-path-node">
              <span class="bridge-path-kicker">Web 工作台</span>
              <strong class="bridge-path-value">在线</strong>
              <span class="bridge-path-meta">v${version} · 当前页面</span>
            </article>
            <span class="bridge-path-arrow" aria-hidden="true">→</span>
            <article class="bridge-path-node">
              <span class="bridge-path-kicker">Bridge 服务</span>
              <strong class="bridge-path-value" id="bridgeStatus">检查中</strong>
              <span class="bridge-path-meta" id="bridgeStatusMeta">正在读取进程状态</span>
            </article>
            <span class="bridge-path-arrow" aria-hidden="true">→</span>
            <article class="bridge-path-node">
              <span class="bridge-path-kicker">通道实例</span>
              <strong class="bridge-path-value" id="channelStatus">检查中</strong>
              <span class="bridge-path-meta" id="channelStatusMeta">正在读取连接状态</span>
            </article>
            <span class="bridge-path-arrow" aria-hidden="true">→</span>
            <article class="bridge-path-node">
              <span class="bridge-path-kicker">活动会话</span>
              <strong class="bridge-path-value" id="activeSessionCount">检查中</strong>
              <span class="bridge-path-meta"><span id="runtimeStatus">-</span> · <span class="bridge-path-meta-item">本地 <span id="codexSessionCount">-</span></span> · <span class="bridge-path-meta-item">入口 <span id="bindingCount">-</span></span></span>
            </article>
          </section>

          <section class="panel runtime-status-panel" aria-label="Runtime 当前状态">
            <div class="panel-header">
              <div>
                <h2>Runtime 当前状态</h2>
                <p>区分“本机发现”“已绑定”和“正在运行”，点击任一 runtime 可直接筛选会话。</p>
              </div>
            </div>
            <div class="runtime-status-list">
              <button type="button" class="runtime-status-item" data-runtime="codex" aria-label="查看 Codex 会话">
                <span class="runtime-status-head"><strong>Codex</strong><span class="runtime-state" id="runtime-codex-state">检查中</span></span>
                <span class="runtime-status-counts" id="runtime-codex-counts">正在读取会话与入口</span>
                <span class="runtime-status-config" id="runtime-codex-config">默认配置检查中</span>
                <span class="runtime-status-recent" id="runtime-codex-backend">执行后端检查中</span>
                <span class="runtime-status-recent" id="runtime-codex-recent">最近活动检查中</span>
              </button>
              <button type="button" class="runtime-status-item" data-runtime="claude" aria-label="查看 Claude Code 会话">
                <span class="runtime-status-head"><strong>Claude Code</strong><span class="runtime-state" id="runtime-claude-state">检查中</span></span>
                <span class="runtime-status-counts" id="runtime-claude-counts">正在读取会话与入口</span>
                <span class="runtime-status-config" id="runtime-claude-config">默认配置检查中</span>
                <span class="runtime-status-recent" id="runtime-claude-recent">最近活动检查中</span>
              </button>
              <button type="button" class="runtime-status-item" data-runtime="kimi" aria-label="查看 Kimi Code 会话">
                <span class="runtime-status-head"><strong>Kimi Code</strong><span class="runtime-state" id="runtime-kimi-state">检查中</span></span>
                <span class="runtime-status-counts" id="runtime-kimi-counts">正在读取会话与入口</span>
                <span class="runtime-status-config" id="runtime-kimi-config">默认配置检查中</span>
                <span class="runtime-status-recent" id="runtime-kimi-recent">最近活动检查中</span>
              </button>
              <button type="button" class="runtime-status-item" data-runtime="cursor" aria-label="查看 Cursor Agent 会话">
                <span class="runtime-status-head"><strong>Cursor Agent</strong><span class="runtime-state" id="runtime-cursor-state">检查中</span></span>
                <span class="runtime-status-counts" id="runtime-cursor-counts">正在读取会话与入口</span>
                <span class="runtime-status-config" id="runtime-cursor-config">默认配置检查中</span>
                <span class="runtime-status-recent" id="runtime-cursor-recent">最近活动检查中</span>
              </button>
              <button type="button" class="runtime-status-item" data-runtime="zcode" aria-label="查看 ZCode 会话">
                <span class="runtime-status-head"><strong>ZCode</strong><span class="runtime-state" id="runtime-zcode-state">检查中</span></span>
                <span class="runtime-status-counts" id="runtime-zcode-counts">正在读取会话与入口</span>
                <span class="runtime-status-config" id="runtime-zcode-config">默认配置检查中</span>
                <span class="runtime-status-recent" id="runtime-zcode-recent">最近活动检查中</span>
              </button>
            </div>
          </section>

          <div class="overview-grid">
            <section class="panel">
              <div class="panel-header">
                <div>
                  <h2>运行控制</h2>
                  <p>启停 Bridge 或刷新整体状态。</p>
                </div>
              </div>
              <div class="actions">
                <button class="primary" id="startBridgeBtn">启动桥接服务</button>
                <button id="stopBridgeBtn">停止桥接服务</button>
                <button id="restartBridgeBtn">重启桥接服务</button>
                <button id="refreshBtn">刷新状态</button>
              </div>

              <div class="panel-block">
                <p class="panel-subtitle">当前能力</p>
                <div class="notice">已接通保存配置、后台启停、飞书凭据测试、本地会话发现、IM 绑定查看与网页改绑。</div>
              </div>

              <div class="panel-block">
                <div class="panel-subtitle-row"><p class="panel-subtitle">桥接服务开机自启动</p><span class="inline-status" id="autostartStatus">检查中</span></div>
                <div class="notice" id="autostartNotice">正在检查当前 Windows 任务计划程序状态…</div>
                <div class="actions" style="margin-top: 12px;">
                  <button id="refreshAutostartBtn">刷新开机自启动状态</button>
                </div>
              </div>

              <div class="panel-block">
                <div class="panel-subtitle-row"><p class="panel-subtitle">可选 Codex 技能</p><span class="inline-status" id="integrationStatus">检查中</span></div>
                <div class="notice">桥接服务不再注入发送附件的提示词。需要让 Codex 知道“可以把本地图片/文件回发到 IM”时，请安装这个可选技能。</div>
                <div class="actions" style="margin-top: 12px;">
                  <button id="installIntegrationBtn">安装可选 Codex 技能</button>
                </div>
              </div>

              <div class="message" id="opsMessage"></div>
            </section>

            <section class="panel">
              <div class="panel-header">
                <div>
                  <h2>当前环境</h2>
                  <p>本机运行时和关键目录，用于排查部署问题。</p>
                </div>
              </div>
              <div class="info-list">
                <div class="info-item">
                  <strong>包根目录</strong>
                  <div class="mono" id="packageRoot">-</div>
                </div>
                <div class="info-item">
                  <strong>配置目录</strong>
                  <div class="mono" id="overviewHomeStatus">-</div>
                </div>
                <div class="info-item">
                  <strong>本地会话根目录</strong>
                  <div class="mono" id="runtimeSessionsRootStatus">-</div>
                </div>
                <div class="info-item">
                  <strong>操作入口</strong>
                  <div>“会话”管理 Bridge/IM 与本地 runtime 会话；“通道”查看聊天绑定并直接改绑。</div>
                </div>
              </div>
            </section>
          </div>
        </section>
`;
}

export const appServerPageHtml = `        <section class="page" data-page="app-server">
          <div class="page-header">
            <div>
              <h1 class="page-title">Codex app-server</h1>
              <p class="page-copy">查看本实例使用的对话服务。tmux 是独立的终端入口，不决定服务是否启动。</p>
            </div>
            <button type="button" id="refreshAppServersBtn">刷新状态</button>
          </div>
          <section class="panel" aria-label="app-server 启动情况">
            <div class="panel-header">
              <div><h2>启动与连接</h2><p id="appServerPolicy">正在读取新会话默认策略</p></div>
              <span class="inline-status" id="appServerSummary" role="status">检查中</span>
            </div>
            <p class="notice" id="appServerNotice">正在读取 Bridge 的服务状态。</p>
            <div id="appServerList" class="info-list" aria-live="polite"></div>
            <p class="small" id="appServerObservedAt"></p>
          </section>
          <p class="page-copy">服务按需启动。此页面每 5 秒读取一次状态；打开或刷新页面不会启动服务。Desktop 是否已连接需要在 Desktop 中确认。</p>
        </section>
`;

export const sessionsPageHtml = `        <section class="page" data-page="sessions">
          <div class="page-header">
            <div>
              <h1 class="page-title">会话</h1>
              <p class="page-copy">点击任意会话可以查看 chat_history，也可以直接删除不需要的会话。</p>
            </div>
            <div class="toolbar">
              <button id="refreshCodexBtn">刷新会话</button>
            </div>
          </div>

          <section class="panel" id="codex">
            <div class="notice">列表同时包含 Bridge/IM 会话和本机 runtime 会话。找到目标后可在“通道”页改绑；已有 thread 也可复制 <code>/thread 019d1da4</code> 发给机器人。</div>
            <div class="session-filter-bar" role="search" aria-label="筛选会话">
              <label class="session-search-field">搜索会话<input id="sessionSearch" type="search" autocomplete="off" placeholder="标题、目录、session id、provider" /></label>
              <label>Runtime<select id="sessionRuntimeFilter">
                <option value="">全部 runtime</option>
                <option value="codex">Codex</option>
                <option value="claude">Claude Code</option>
                <option value="kimi">Kimi Code</option>
                <option value="cursor">Cursor Agent</option>
                <option value="zcode">ZCode</option>
              </select></label>
              <button type="button" id="clearSessionFiltersBtn">清除筛选</button>
            </div>
            <div class="small" id="codexSessionMeta" style="margin: 14px 0 16px;">正在加载…</div>
            <div class="session-list">
              <section class="session-section">
                <div class="session-section-head">
                  <h2 class="session-section-title">当前已绑定会话</h2>
                  <div class="session-section-meta" id="boundSessionsMeta">正在加载…</div>
                </div>
                <div id="boundSessionsList"></div>
              </section>
              <section class="session-section">
                <div class="session-section-head">
                  <h2 class="session-section-title">全部会话</h2>
                  <div class="session-section-meta" id="allSessionsMeta">正在加载…</div>
                </div>
                <div id="codexSessionsList"></div>
              </section>
            </div>
            <div class="message" id="codexMessage"></div>
          </section>
        </section>
`;

export const sessionHistoryPageHtml = `        <section class="page" data-page="session-history">
          <div class="page-header session-history-header">
            <div class="session-history-titlebar">
              <button type="button" class="icon-btn ghost-icon" id="backToSessionsBtn" aria-label="返回会话列表" title="返回会话列表">
                <span aria-hidden="true">←</span>
              </button>
              <div>
                <h1 class="page-title session-history-title" id="sessionHistoryTitle">会话历史</h1>
                <p class="page-copy" id="sessionHistorySubtitle">查看当前 session 的 chat_history。</p>
              </div>
            </div>
            <div class="toolbar icon-toolbar">
              <button type="button" class="icon-btn" id="refreshSessionHistoryBtn" aria-label="刷新历史" title="刷新历史"><span aria-hidden="true">↻</span></button>
              <button type="button" class="icon-btn danger" id="deleteSessionBtn" aria-label="删除会话" title="删除会话"><span aria-hidden="true">⌫</span></button>
            </div>
          </div>

          <section class="panel session-history-layout">
            <div class="session-history-summary" id="sessionHistorySummary"></div>
            <div class="chat-history-list" id="sessionHistoryList">
              <div class="notice">请选择一个会话查看历史。</div>
            </div>
            <div class="message" id="sessionHistoryMessage"></div>
          </section>
        </section>
`;

export const configPageHtml = `        <section class="page" data-page="config">
          <div class="page-header">
            <div>
              <h1 class="page-title">配置</h1>
              <p class="page-copy">维护默认工作目录、runtime 参数和 Web 访问设置。</p>
            </div>
          </div>

          <section class="panel" id="config">
            <div class="panel-header">
              <div>
                <h2>全局配置</h2>
                <p>通用设置只出现一次，各 runtime 只维护自己的执行参数；少数选项保存后需要重启 Bridge。</p>
              </div>
              <div class="toolbar">
                <button class="primary" id="saveConfigBtn">保存配置</button>
              </div>
            </div>

            <div class="config-tabs" role="tablist" aria-label="配置分组">
              <button type="button" class="config-tab active" role="tab" aria-selected="true" data-config-tab="common">通用</button>
              <button type="button" class="config-tab" role="tab" aria-selected="false" data-config-tab="codex">Codex</button>
              <button type="button" class="config-tab" role="tab" aria-selected="false" data-config-tab="claude">Claude</button>
              <button type="button" class="config-tab" role="tab" aria-selected="false" data-config-tab="kimi">Kimi</button>
              <button type="button" class="config-tab" role="tab" aria-selected="false" data-config-tab="cursor">Cursor</button>
              <button type="button" class="config-tab" role="tab" aria-selected="false" data-config-tab="zcode">ZCode</button>
              <button type="button" class="config-tab" role="tab" aria-selected="false" data-config-tab="web">Web 与 Bridge</button>
            </div>

            <div class="fields">
              <div class="panel-block config-section-secondary" data-config-section="codex" hidden>
                <p class="panel-subtitle">Codex 默认值</p>
                <div class="field-row double">
                  <label>
                    Codex 默认模式
                    <select id="defaultMode">
                      <option value="normal">normal</option>
                      <option value="yolo">yolo</option>
                    </select>
                  </label>
                  <label>
                    <span class="field-title">Codex 默认模型 <span class="help-tip" tabindex="0" data-tip="留空则跟随 Codex 当前默认模型；隐藏模型不会展示，本机 Codex 不支持的模型会标成“仅 IM”。">?</span></span>
                    <select id="defaultModel"></select>
                  </label>
                  <label>
                    <span class="field-title">Codex 文件系统权限 <span class="help-tip" tabindex="0" data-tip="设置 Codex 默认 sandbox。IM 会话仍可用命令单独覆盖。">?</span></span>
                    <select id="codexSandboxMode">
                      <option value="workspace-write">workspace-write</option>
                      <option value="read-only">read-only</option>
                      <option value="danger-full-access">danger-full-access</option>
                    </select>
                  </label>
                  <label>
                    <span class="field-title">Codex 思考级别 <span class="help-tip" tabindex="0" data-tip="设置 Codex 默认 reasoning effort。IM 会话仍可用命令单独覆盖。">?</span></span>
                    <select id="codexReasoningEffort">
                      <option value="medium">medium</option>
                      <option value="minimal">minimal</option>
                      <option value="low">low</option>
                      <option value="high">high</option>
                      <option value="xhigh">xhigh</option>
                      <option value="max">max</option>
                      <option value="ultra">ultra</option>
                    </select>
                  </label>
                  <label>
                    <span class="field-title">Codex 网络访问 <span class="help-tip" tabindex="0" data-tip="允许 Codex 在 workspace-write sandbox 下访问网络；IM 会话仍可用 /net 单独覆盖。">?</span></span>
                    <span class="checkbox checkbox-field">
                      <input id="codexNetworkAccess" type="checkbox" checked />
                      允许 Codex 访问网络
                    </span>
                  </label>
                </div>
                <div class="checkbox-row">
                  <label class="checkbox"><input id="codexSkipGitRepoCheck" type="checkbox" checked /> 允许在未信任 Git 目录运行 Codex <span class="help-tip" tabindex="0" data-tip="如果新建会话报 Not inside a trusted directory，可以打开这个选项；修改后需要重启 Bridge。">?</span></label>
                </div>
              </div>

              <div class="panel-block" data-config-section="claude" hidden>
                <p class="panel-subtitle">Claude 默认值</p>
                <div class="field-row triple">
                  <label>
                    <span class="field-title">Claude executable <span class="help-tip" tabindex="0" data-tip="选择启动 Claude Code 的命令；这是全局 Claude 配置，不是 provider。">?</span></span>
                    <select id="claudeExecutable">
                      <option value="claude">claude</option>
                      <option value="ccr">ccr</option>
                    </select>
                  </label>
                  <label>
                    <span class="field-title">默认 Claude Provider <span class="help-tip" tabindex="0" data-tip="控制 Bridge 默认用 tmux、pty 还是 SDK 驱动 Claude Code；当前会话仍可用 /p 单独切换。">?</span></span>
                    <select id="claudeProvider">
                      <option value="sdk">sdk</option>
                      <option value="pty">pty</option>
                      <option value="tmux">tmux</option>
                    </select>
                  </label>
                  <label>
                    <span class="field-title">Claude 默认模型 <span class="help-tip" tabindex="0" data-tip="只作为 Claude Code runtime 的默认模型；不会回退到 Codex 默认模型。">?</span></span>
                    <input id="claudeDefaultModel" placeholder="留空则跟随 Claude Code 默认" />
                  </label>
                  <label>
                    <span class="field-title">Claude 默认模式 <span class="help-tip" tabindex="0" data-tip="设置新 Claude Code 会话的默认权限模式；当前会话仍可单独覆盖。">?</span></span>
                    <select id="claudeMode">
                      <option value="normal">normal</option>
                      <option value="yolo">yolo</option>
                    </select>
                  </label>
                  <label>
                    <span class="field-title">Claude 思考级别 <span class="help-tip" tabindex="0" data-tip="设置 Claude Code 的默认 reasoning effort；当前会话仍可单独覆盖。">?</span></span>
                    <select id="claudeReasoningEffort">
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                      <option value="xhigh">xhigh</option>
                      <option value="max">max</option>
                    </select>
                  </label>
                  <label>
                    <span class="field-title">Claude 空闲超时（分钟） <span class="help-tip" tabindex="0" data-tip="0 表示不启用全局空闲超时；后续会话级设置可以覆盖。">?</span></span>
                    <input id="claudeIdleTimeoutMinutes" type="number" min="0" max="120" value="0" />
                  </label>
                </div>
              </div>

              <div class="panel-block" data-config-section="common">
                <p class="panel-subtitle">通用默认值</p>
                <div class="field-row triple">
                  <label>
                    <span class="field-title">/new 相对路径根目录 <span class="help-tip" tabindex="0" data-tip="当 /new 使用项目名或相对路径时，以该目录为根；留空时使用 ~。">?</span></span>
                    <input id="defaultWorkspaceRoot" placeholder="留空时使用 ~" />
                  </label>
                  <label>
                    <span class="field-title">tmux 输出行数 <span class="help-tip" tabindex="0" data-tip="控制新 session 的 tmux 屏幕抓取行数；范围 1-500。">?</span></span>
                    <input id="tmuxCaptureLines" type="number" min="1" max="500" value="80" />
                  </label>
                  <label class="checkbox"><input id="tmuxEchoInput" type="checkbox" /> 回显 tmux 输入</label>
                  <label>
                    默认 Runtime
                    <select id="runtime">
                      <option value="codex" selected>codex</option>
                      <option value="claude">claude</option>
                      <option value="kimi">kimi</option>
                      <option value="cursor">cursor</option>
                      <option value="zcode">zcode</option>
                    </select>
                  </label>
                </div>
              </div>

              <div class="panel-block" data-config-section="kimi" hidden>
                <p class="panel-subtitle">Kimi 默认值</p>
                <div class="field-row triple">
                  <label>
                    <span class="field-title">默认 Kimi Provider <span class="help-tip" tabindex="0" data-tip="Kimi Code 当前只支持 tmux；当前会话仍可用 /p 查看或写入会话级覆盖。">?</span></span>
                    <select id="kimiProvider">
                      <option value="tmux">tmux</option>
                    </select>
                  </label>
                  <label>
                    <span class="field-title">Kimi 默认模型 <span class="help-tip" tabindex="0" data-tip="只作为 Kimi Code runtime 的默认模型；留空则跟随 Kimi Code 默认。">?</span></span>
                    <input id="kimiDefaultModel" placeholder="留空则跟随 Kimi Code 默认" />
                  </label>
                  <label>
                    <span class="field-title">Kimi Thinking 模式 <span class="help-tip" tabindex="0" data-tip="default 跟随 Kimi Code 自身配置；on/off 分别传入 --thinking/--no-thinking。">?</span></span>
                    <select id="kimiThinkingMode"><option value="default">default</option><option value="on">on</option><option value="off">off</option></select>
                  </label>
                </div>
              </div>

              <div class="panel-block" data-config-section="cursor" hidden>
                <p class="panel-subtitle">Cursor 默认值</p>
                <div class="field-row triple">
                  <label>
                    <span class="field-title">默认 Cursor Provider <span class="help-tip" tabindex="0" data-tip="Cursor Agent 当前直接运行官方 TUI，只支持 tmux。">?</span></span>
                    <select id="cursorProvider"><option value="tmux">tmux</option></select>
                  </label>
                  <label>
                    <span class="field-title">Cursor 默认模型 <span class="help-tip" tabindex="0" data-tip="留空则跟随 Cursor Agent 默认模型。">?</span></span>
                    <input id="cursorDefaultModel" placeholder="留空则跟随 Cursor Agent 默认" />
                  </label>
                  <label>
                    <span class="field-title">Cursor 思考级别 <span class="help-tip" tabindex="0" data-tip="写入参数化模型的 effort 覆盖；实际可用等级取决于所选 Cursor 模型和账号。留空则跟随 Cursor。">?</span></span>
                    <select id="cursorReasoningEffort"><option value="">跟随 Cursor</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select>
                  </label>
                  <label class="checkbox"><input id="cursorForce" type="checkbox" /> Cursor force 模式</label>
                </div>
              </div>

              <div class="panel-block" data-config-section="zcode" hidden>
                <p class="panel-subtitle">ZCode 默认值</p>
                <div class="field-row triple">
                  <label>
                    <span class="field-title">默认 ZCode Provider <span class="help-tip" tabindex="0" data-tip="ZCode 复用 CodeLark 的 tmux 生命周期与原生 TUI，只支持 tmux。">?</span></span>
                    <select id="zcodeProvider"><option value="tmux">tmux</option></select>
                  </label>
                  <label>
                    <span class="field-title">ZCode 默认模型 <span class="help-tip" tabindex="0" data-tip="格式由 ZCode 接受，例如 zai/glm-5.2；留空则跟随 ZCode。">?</span></span>
                    <input id="zcodeDefaultModel" placeholder="留空则跟随 ZCode 默认" />
                  </label>
                  <label>
                    <span class="field-title">ZCode 默认模式</span>
                    <select id="zcodeMode"><option value="build">build</option><option value="edit">edit</option><option value="plan">plan</option><option value="yolo">yolo</option></select>
                  </label>
                </div>
              </div>

              <div class="panel-block" data-config-section="codex" hidden>
                <p class="panel-subtitle">Codex 连接方式</p>
                <div class="field-row triple">
                  <label>
                    <span class="field-title">Codex Provider <span class="help-tip" tabindex="0" data-tip="Codex 固定使用 tmux Provider；app-server 是自动执行后端，协议会话中的 tmux 用于查看。">?</span></span>
                    <select id="defaultProvider">
                      <option value="">跟随默认</option>
                      <option value="tmux">tmux</option>
                    </select>
                  </label>
                </div>
              </div>

              <div class="panel-block" data-config-section="web" hidden>
                <p class="panel-subtitle">Web 与 Bridge 访问</p>
                <div class="checkbox-row">
                  <label class="checkbox"><input id="uiAllowLan" type="checkbox" /> 允许局域网访问 Web 控制台 <span class="help-tip" tabindex="0" data-tip="默认仅允许本机访问当前工作台。开启后，局域网设备需要先输入访问 token。">?</span></label>
                </div>
                <div class="notice" id="uiAccessSummary">局域网访问未开启。</div>
                <div id="uiLanDetails" hidden>
                  <div class="field-row" style="margin-top: 16px;">
                  <label>
                    访问 token
                    <input id="uiAccessToken" readonly />
                  </label>
                  <div style="display: grid; gap: 10px; align-content: end;">
                    <div class="toolbar">
                      <button type="button" id="copyUiTokenBtn">复制 token</button>
                      <button type="button" id="regenerateUiTokenBtn">重新生成 token</button>
                    </div>
                    <div class="toolbar">
                      <button type="button" id="copyUiLanLinkBtn">复制局域网登录链接</button>
                    </div>
                  </div>
                </div>
                <div class="info-list" id="uiAccessUrls" style="margin-top: 16px;"></div>
              </div>
              </div>
            </div>

            <div class="message" id="configMessage"></div>
          </section>
        </section>
`;

export const commandsPageHtml = `        <section class="page" data-page="commands">
          <div class="page-header">
            <div>
              <h1 class="page-title">命令说明</h1>
              <p class="page-copy">当前桥接聊天支持的命令与参数。</p>
            </div>
          </div>

          <section class="panel">
            <div class="panel-header">
              <div>
                <h2>命令使用说明</h2>
                <p>下面这些命令适用于当前桥接到的聊天通道。</p>
              </div>
            </div>

            <div class="notice" style="margin-bottom: 16px;">最短使用路径：先发 <code>/t</code> 查看本地 Codex / Claude Code / Kimi Code / Cursor Agent / ZCode 会话，再发 <code>/t 1</code> 接管；之后直接发送文本即可继续当前会话。</div>

            <div class="command-sections">
              <section class="command-section">
                <h3 class="command-section-title">最常用</h3>
                <div class="command-list">
                  <div class="command-list-head"><div>命令</div><div>原始命令</div><div>说明</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/</code></div><div class="command-col-original">—</div><div class="command-col-desc">查看当前聊天/当前会话诊断。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/status</code></div><div class="command-col-original"><code>/status</code></div><div class="command-col-desc">查看全局状态：通道、Bridge/UI 进程、PID、绑定与会话数量。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/check</code></div><div class="command-col-original"><code>/health</code></div><div class="command-col-desc">查看当前会话健康状态。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/check all</code></div><div class="command-col-original"><code>/health all</code></div><div class="command-col-desc">查看所有运行中会话的健康状态。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/doctor [bridge_id|描述]</code></div><div class="command-col-original"><code>/doctor</code></div><div class="command-col-desc">把目标 id、故障描述和结构化 JSONL bridge.log 路径交给当前会话诊断，不会把整段日志贴进上下文。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>//...</code></div><div class="command-col-original">—</div><div class="command-col-desc">向模型发送以 <code>/</code> 开头的文本，避免被当成桥接命令。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/h</code></div><div class="command-col-original"><code>/help</code></div><div class="command-col-desc">查看帮助。</div></div>
          <div class="command-item"><div class="command-col-command"><code>/t</code></div><div class="command-col-original"><code>/threads</code></div><div class="command-col-desc">默认显示当前 runtime 最近 20 条；飞书卡片是一张表，可用数量下拉切换 20/50/100，也可用 runtime 下拉切换 Codex/Claude/Kimi/Cursor/ZCode。</div></div>
          <div class="command-item"><div class="command-col-command"><code>/t all</code></div><div class="command-col-original"><code>/threads all</code></div><div class="command-col-desc">最多列出当前 runtime 最近 100 条本地会话。</div></div>
          <div class="command-item"><div class="command-col-command"><code>/t n 100</code></div><div class="command-col-original"><code>/threads n 100</code></div><div class="command-col-desc">列出当前 runtime 最近 100 条本地会话；也可用 <code>/t codex n 100</code>、<code>/t claude n 100</code>、<code>/t kimi n 100</code>、<code>/t cursor n 100</code> 或 <code>/t zcode n 100</code>。</div></div>
              <div class="command-item"><div class="command-col-command"><code>/t &lt;序号|thread/session id|bridge id|名称&gt;</code></div><div class="command-col-original"><code>/thread &lt;序号|thread/session id|bridge id|名称&gt;</code></div><div class="command-col-desc">按当前 runtime 表序号、thread/session id、bridge_id 或唯一名称接管本地会话，并设为当前会话；接管其他聊天已绑定的会话需要确认，目标运行中会拒绝。</div></div>
              <div class="command-item"><div class="command-col-command"><code>/t 标记</code></div><div class="command-col-original"><code>/t</code></div><div class="command-col-desc">卡片首列会标出当前激活的对话和其他人激活的对话，bridge_id 存在表示曾经接入过 codelark。</div></div>
              <div class="command-item"><div class="command-col-command"><code>/t archive [序号|bridge id|thread/session id|名称]</code></div><div class="command-col-original"><code>/t archive [序号|bridge id|thread/session id|名称]</code></div><div class="command-col-desc">归档当前或指定本地会话，并解除相关绑定。</div></div>
              <div class="command-item"><div class="command-col-command"><code>/t unbind</code></div><div class="command-col-original"><code>/t unbind</code></div><div class="command-col-desc">解绑当前聊天，并立即绑定到新的临时 BridgeSession；之后接管已有会话时会自动删除该临时 BridgeSession。</div></div>
              <div class="command-item"><div class="command-col-command"><code>/t rename &lt;名称&gt;</code></div><div class="command-col-original"><code>/t rename &lt;名称&gt;</code></div><div class="command-col-desc">重命名当前会话；群聊通道会同步修改群聊名称并自动带 [botname] 前缀；名称不能是纯数字或类似 runtime/绑定 ID。</div></div>
              <div class="command-item"><div class="command-col-command"><code>/t 序号范围</code></div><div class="command-col-original"><code>/t</code></div><div class="command-col-desc"><code>/t</code> 和 <code>/t archive</code> 使用当前 runtime 的本地会话表序号。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/n</code></div><div class="command-col-original"><code>/new</code></div><div class="command-col-desc">打开新建 IM 群聊会话表单；也可用 <code>/new &lt;name&gt; [path]</code> 直接创建，未指定路径时继承当前会话目录，未绑定时使用全局默认工作目录。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/clear [name] [path]</code></div><div class="command-col-original"><code>/clear [name] [path]</code></div><div class="command-col-desc">在当前聊天上下文创建新对话并绑定过去；名称或路径包含空格时，请使用英文双引号 <code>&quot;</code> 或英文单引号 <code>'</code>；可用 <code>/t</code> 附回旧对话，运行中会先确认是否终止。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>直接发送文本</code></div><div class="command-col-original">—</div><div class="command-col-desc">继续当前已绑定会话；未绑定时会自动进入临时草稿线程，等同先使用 <code>/t 0</code>。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/his [N]</code></div><div class="command-col-original"><code>/history</code></div><div class="command-col-desc">把最近 N 条消息渲染成卡片发送；优先读取 Codex / Claude Code / Kimi Code / Cursor Agent 本地 session 或 ZCode SQLite，找不到再退回 Bridge 缓存。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/his msg [N]</code></div><div class="command-col-original"><code>/history msg</code></div><div class="command-col-desc">把最近 N 条消息渲染成卡片发送，可临时指定本次条数。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/his raw [N]</code></div><div class="command-col-original"><code>/history raw</code></div><div class="command-col-desc">查看解析后的纯文本视图，可临时指定本次条数；不是原始 JSONL。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/his json</code></div><div class="command-col-original"><code>/history json</code></div><div class="command-col-desc">直接发送 Codex / Claude Code / Kimi Code / Cursor Agent 的原始 session 文件；ZCode 使用 SQLite，请改用 <code>/his</code> 查看解析结果。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/his limit 12</code></div><div class="command-col-original"><code>/history limit 12</code></div><div class="command-col-desc">修改 /his 默认返回条数限制（1-20）。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/shell [秒数] &lt;command&gt;</code></div><div class="command-col-original"><code>/shell</code></div><div class="command-col-desc">新特性：在当前会话目录通过 <code>codex sandbox</code> 流式执行命令；默认 workspace-write 且网络开启，支持 <code>--sandbox read-only</code>，卡片刷新最低 5 秒，高风险命令需 <code>--force</code>，不允许 danger-full-access，IM 自动链接按显示文本执行。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/every 10m 检查实验进度</code></div><div class="command-col-original"><code>/every &lt;时间&gt; &lt;prompt&gt;</code></div><div class="command-col-desc">创建定时输入；时间支持 s/m/h/d；每次触发都会复用当前会话。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/every</code></div><div class="command-col-original"><code>/every</code></div><div class="command-col-desc">查看当前聊天的定时输入；飞书会返回绿色卡片。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/every no 1</code></div><div class="command-col-original"><code>/every no &lt;序号&gt;</code></div><div class="command-col-desc">按 <code>/every</code> 表格序号取消定时输入。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/then 总结刚才的执行结果</code></div><div class="command-col-original"><code>/then &lt;prompt&gt;</code></div><div class="command-col-desc">创建一次性后续输入；当前会话 completed/interrupted 后会复用当前会话发送。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/then</code></div><div class="command-col-original"><code>/then</code></div><div class="command-col-desc">查看当前聊天待发送的后续输入；飞书会返回蓝色卡片，支持新建、修改、取消和刷新。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/then set 1 新 prompt</code></div><div class="command-col-original"><code>/then set &lt;序号&gt; &lt;prompt&gt;</code></div><div class="command-col-desc">修改 pending 后续输入；也可在 <code>/then</code> 卡片中选择后点击修改。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/then no 1</code></div><div class="command-col-original"><code>/then no &lt;序号&gt;</code></div><div class="command-col-desc">删除 pending 后续输入；若正在发送则中止当前发送，也可在卡片中选择后点击取消。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/tmux-switch</code></div><div class="command-col-original"><code>/tmux-switch</code></div><div class="command-col-desc">列出 tmux sessions，按 <code>/tmux-attach &lt;session&gt;</code> 选择。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/tmux-screen 5s</code></div><div class="command-col-original"><code>/tmux-screen [lines] [seconds]s</code></div><div class="command-col-desc">查看当前屏幕；可临时指定行数并按秒定时刷新，例如 <code>/tmux-screen 120 5s</code>。最低 3 秒一次，用 <code>/tmux-screen stop</code> 停止。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/pty-screen 5s</code></div><div class="command-col-original"><code>/pty-screen [lines] [seconds]s</code></div><div class="command-col-desc">查看当前 pty runtime 的 TUI 输出；Codex 和 Claude Code 都按当前 active runtime 读取，可临时指定行数并按秒定时刷新，例如 <code>/pty-screen 120 5s</code>。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/tmux pwd&lt;Enter&gt;</code></div><div class="command-col-original"><code>/tmux ...</code></div><div class="command-col-desc">向当前绑定的 tmux session 发送按键并自动截屏返回。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/tmux-keys git status&lt;Enter&gt;</code></div><div class="command-col-original"><code>/tmux-key ...</code></div><div class="command-col-desc">混合发送普通文本和特殊键；<code>/tmux-keys</code> 是 <code>/tmux-key</code> 的别名。</div></div>
                </div>
              </section>

              <section class="command-section">
                <h3 class="command-section-title">设置与切换</h3>
                <div class="command-list">
                  <div class="command-list-head"><div>命令</div><div>原始命令</div><div>说明</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/m</code></div><div class="command-col-original"><code>/mode</code></div><div class="command-col-desc">查看当前模式；可选 <code>normal</code>、<code>yolo</code>。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/provider</code></div><div class="command-col-original"><code>/provider</code></div><div class="command-col-desc">查看或切换当前 IM 会话 active runtime 的 Provider；Codex 固定 <code>tmux</code>（app-server 自动执行），Claude 可选 <code>sdk</code>、<code>pty</code>、<code>tmux</code>，Kimi、Cursor 与 ZCode 当前只支持 <code>tmux</code>。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/r</code></div><div class="command-col-original"><code>/reasoning</code></div><div class="command-col-desc">Codex 可选 <code>minimal</code> 到 <code>ultra</code>；Claude 可选 <code>low</code> 到 <code>max</code>；Kimi 使用 <code>on/off/default</code>；Cursor 使用模型 <code>effort</code>；ZCode 不映射该命令。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/sb</code></div><div class="command-col-original"><code>/sandbox</code></div><div class="command-col-desc">查看或切换当前 IM 会话的 Codex 沙箱；可选 <code>read-only</code>、<code>workspace-write</code>、<code>danger-full-access</code>、<code>default</code>。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/net</code></div><div class="command-col-original"><code>/network</code></div><div class="command-col-desc">查看或切换当前 IM 会话的网络访问；可选 <code>on</code>、<code>off</code>、<code>default</code>。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/ui</code></div><div class="command-col-original">—</div><div class="command-col-desc">查看 UI 显示策略；工具调用详情始终展示。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/require-at on|off</code></div><div class="command-col-original"><code>/require-at</code></div><div class="command-col-desc">查看或切换当前会话是否要求群聊 @bot，也支持 <code>/require_at</code>；默认 <code>off</code>，即群聊不 @bot 也会接收。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/customer on|off</code></div><div class="command-col-original"><code>/customer</code></div><div class="command-col-desc">查看、开启或关闭当前群客服模式；话题内执行也作用于所属群，是否需要 @ 沿用群设置。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/whitelist add|remove @成员</code></div><div class="command-col-original"><code>/whitelist</code></div><div class="command-col-desc">查看或管理客服控制白名单；空名单默认 bot 创始人拥有权限，可直接添加成员。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/model [slug|default]</code></div><div class="command-col-original"><code>/model [slug|default]</code></div><div class="command-col-desc">查看或切换当前 IM 会话使用的模型；Codex 共享 thread 只允许查看，Claude Code 会保存为后续 TUI 启动参数。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/tmux-attach &lt;session&gt;</code></div><div class="command-col-original"><code>/tmux-attach &lt;session&gt;</code></div><div class="command-col-desc">把当前 IM 会话绑定到一个远程 tmux session。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/tmux-new [session]</code></div><div class="command-col-original"><code>/tmux-new [session]</code></div><div class="command-col-desc">新建并绑定 tmux session；如果已存在，会提示并直接绑定。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/tmux-status</code></div><div class="command-col-original"><code>/tmux-status</code></div><div class="command-col-desc">查看当前 tmux 绑定和自动截屏行数。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/tmux-screen stop</code></div><div class="command-col-original"><code>/tmux-screen stop</code></div><div class="command-col-desc">停止当前聊天的 tmux 屏幕定时刷新。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/pty-screen stop</code></div><div class="command-col-original"><code>/pty-screen stop</code></div><div class="command-col-desc">停止当前聊天的 pty 屏幕定时刷新。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/tmux-set lines 120</code></div><div class="command-col-original"><code>/tmux-set lines 120</code></div><div class="command-col-desc">设置 <code>/tmux</code> 返回的截屏行数，范围 1-500。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/tmux-set echo on</code></div><div class="command-col-original"><code>/tmux-set echo on|off</code></div><div class="command-col-desc">设置 <code>/tmux</code> 发送内容后是否在回复里回显本次输入。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/t 0</code></div><div class="command-col-original"><code>/thread 0</code></div><div class="command-col-desc">切换到当前聊天的临时草稿线程。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/t 0 reset</code></div><div class="command-col-original"><code>/thread 0 reset</code></div><div class="command-col-desc">丢弃当前草稿上下文并重建一条新的草稿线程。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/stop</code></div><div class="command-col-original"><code>/stop</code></div><div class="command-col-desc">停止当前任务。</div></div>
                </div>
              </section>

              <section class="command-section">
                <h3 class="command-section-title">文件</h3>
                <div class="command-list">
                  <div class="command-list-head"><div>命令</div><div>原始命令</div><div>说明</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/cat &lt;path&gt; [start] [end]</code></div><div class="command-col-original"><code>/cat &lt;path&gt; [start] [end]</code></div><div class="command-col-desc">打印文件内容；未指定行号时默认读取前 200 行。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/file &lt;path&gt;</code></div><div class="command-col-original"><code>/file &lt;path&gt;</code></div><div class="command-col-desc">发送本地文件；超过 20 MB 时先确认，确认后后台上传并回链接。</div></div>
                </div>
              </section>

            </div>
          </section>
        </section>
`;

export const channelsPageHtml = `        <section class="page" data-page="channels">
          <div class="page-header">
            <div>
              <h1 class="page-title">通道</h1>
              <p class="page-copy">管理机器人实例，以及各群聊和单聊的会话绑定。</p>
            </div>
          </div>

        <section class="panel channel-workspace">
          <div class="panel-header">
            <div class="channel-header-copy">
              <h2>通道实例</h2>
              <p>一个实例对应一个机器人账号；聊天绑定彼此独立。</p>
            </div>
            <div class="channel-header-actions">
              <div class="channel-action-group">
                <div class="channel-action-label">新通道</div>
                <div class="channel-action-row">
                  <select id="newChannelProvider">
                    <option value="feishu">飞书</option>
                  </select>
                  <button class="primary channel-create-button" id="createChannelBtn">新增通道</button>
                </div>
                <div class="channel-action-hint">选择通道类型后创建新的机器人实例。</div>
              </div>
              <div class="channel-action-group">
                <div class="channel-action-label">状态同步</div>
                <div class="channel-action-row">
                  <button class="channel-refresh-button" id="refreshChannelsBtn">刷新状态</button>
                </div>
                <div class="channel-action-hint">重新读取通道状态和聊天绑定。</div>
              </div>
            </div>
          </div>

            <div class="channel-layout">
              <aside class="channel-sidebar">
                <div class="channel-sidebar-meta" id="channelListMeta">正在加载…</div>
                <div class="channel-list" id="channelList"></div>
              </aside>
              <section class="channel-editor" id="channelEditor">
                <div class="binding-empty">正在加载通道配置…</div>
              </section>
            </div>
            <div class="message" id="channelMessage"></div>
          </section>
        </section>
`;

export const logsPageHtml = `        <section class="page" data-page="logs">
          <div class="page-header">
            <div>
              <h1 class="page-title">日志</h1>
              <p class="page-copy">查看结构化 Bridge JSONL，定位 runtime、通道和投递问题。</p>
            </div>
            <div class="toolbar">
              <button id="refreshLogsBtn">刷新日志</button>
            </div>
          </div>

          <section class="panel logs-panel" id="logs">
            <div class="logs" id="logsOutput">等待加载日志…</div>
          </section>
        </section>
`;
