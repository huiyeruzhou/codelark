const fontStack = 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

const baseAuthStyles = `
  :root {
    color-scheme: light;
    --bg: #f6f7f9;
    --surface: #ffffff;
    --surface-strong: #ffffff;
    --line: rgba(15, 23, 42, 0.10);
    --line-strong: rgba(15, 23, 42, 0.16);
    --text: #0f172a;
    --muted: #64748b;
    --primary: #2563eb;
    --primary-strong: #1d4ed8;
    --danger: #dc2626;
    --shadow: 0 8px 24px rgba(16, 24, 40, 0.08);
    --ring: 0 0 0 4px rgba(37, 99, 235, 0.14);
    font-family: ${fontStack};
  }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 28px;
    color: var(--text);
    font: 14px/1.55 ${fontStack};
    background: var(--bg);
  }
  .auth-card, .card {
    width: min(460px, 100%);
    position: relative;
    overflow: hidden;
    background: var(--surface);
    border: 1px solid #d0d5dd;
    border-radius: 12px;
    padding: 28px;
    box-shadow: var(--shadow);
  }
  .auth-card::before, .card::before {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: 4px;
    background: var(--primary);
  }
  h1 {
    margin: 0 0 10px;
    font-size: 28px;
    line-height: 1.2;
    letter-spacing: -0.025em;
  }
  p {
    margin: 0 0 22px;
    color: var(--muted);
  }
  label {
    min-width: 0;
    display: grid;
    gap: 8px;
    color: #475569;
    font-weight: 700;
  }
  input {
    width: 100%;
    height: 46px;
    border: 1px solid var(--line-strong);
    border-radius: 8px;
    padding: 0 14px;
    color: var(--text);
    background: rgba(255, 255, 255, 0.86);
    font: inherit;
    outline: none;
    transition: border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
  }
  input:focus {
    border-color: rgba(37, 99, 235, 0.72);
    box-shadow: var(--ring);
    background: #ffffff;
  }
  button {
    width: 100%;
    min-height: 46px;
    margin-top: 18px;
    border: 0;
    border-radius: 8px;
    padding: 0 18px;
    color: #ffffff;
    background: var(--primary);
    font: inherit;
    font-weight: 800;
    cursor: pointer;
    box-shadow: none;
    transition: background 160ms ease;
  }
  button:hover {
    background: var(--primary-strong);
  }
  .message {
    display: none;
    margin-top: 14px;
    padding: 12px 14px;
    border-radius: 14px;
    background: rgba(220, 38, 38, 0.08);
    border: 1px solid rgba(220, 38, 38, 0.16);
    color: var(--danger);
  }
  .message.show { display: block; }
`;

export const loginStyles = baseAuthStyles;
export const accessDeniedStyles = baseAuthStyles;

export const mainStyles = `
  :root {
    color-scheme: light;
    --font: ${fontStack};
    --bg: #f4f6fb;
    --surface: rgba(255, 255, 255, 0.96);
    --surface-solid: #ffffff;
    --surface-soft: #f7f8fc;
    --surface-tint: #eef3ff;
    --text: #162033;
    --muted: #6b7690;
    --muted-strong: #465168;
    --line: #e3e7f0;
    --line-strong: #cbd3e2;
    --primary: #4f6df5;
    --primary-strong: #3c54d7;
    --primary-soft: #edf1ff;
    --violet-soft: #f2edff;
    --cyan: #0891b2;
    --green: #059669;
    --amber: #d97706;
    --violet: #7c3aed;
    --danger: #dc2626;
    --code-bg: #0b1220;
    --radius-xs: 6px;
    --radius-sm: 8px;
    --radius-md: 10px;
    --radius-lg: 12px;
    --shadow-sm: 0 1px 2px rgba(30, 41, 59, 0.04), 0 8px 24px rgba(72, 86, 130, 0.06);
    --shadow-md: 0 14px 36px rgba(47, 61, 105, 0.12);
    --shadow-lg: 0 24px 64px rgba(26, 38, 79, 0.20);
    --ring: 0 0 0 4px rgba(37, 99, 235, 0.14);
    font-family: var(--font);
  }

  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    color: var(--text);
    font: 14px/1.55 var(--font);
    background:
      radial-gradient(circle at 78% -18%, rgba(107, 126, 255, 0.18), transparent 34rem),
      radial-gradient(circle at 22% 112%, rgba(65, 197, 217, 0.10), transparent 30rem),
      var(--bg);
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }
  button, input, select, textarea { font: inherit; }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, .help-tip:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }
  h1, h2, h3, p { color: inherit; }
  code { font-family: "Cascadia Code", Consolas, "SF Mono", monospace; }

  .shell {
    min-height: 100vh;
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    gap: 0;
  }
  .sidebar {
    position: sticky;
    top: 0;
    height: 100vh;
    overflow: auto;
    padding: 24px 16px;
    color: rgba(255, 255, 255, 0.78);
    background:
      radial-gradient(circle at 18% 0%, rgba(99, 102, 241, 0.24), transparent 22rem),
      linear-gradient(180deg, #121a2d 0%, #0c1323 100%);
    box-shadow: inset -1px 0 0 rgba(255, 255, 255, 0.06);
  }
  .brand {
    position: relative;
    margin-bottom: 20px;
    padding: 6px 8px 18px;
  }
  .brand::before {
    content: "C";
    width: 28px;
    height: 28px;
    margin-bottom: 12px;
    display: grid;
    place-items: center;
    border-radius: 7px;
    color: #ffffff;
    background: linear-gradient(135deg, #667cff 0%, #5265e7 52%, #8b5cf6 100%);
    box-shadow: 0 8px 20px rgba(83, 102, 232, 0.34);
    font-size: 14px;
    font-weight: 800;
  }
  .brand-title {
    margin: 0;
    color: #ffffff;
    font-size: 18px;
    font-weight: 800;
    letter-spacing: -0.02em;
  }
  .brand-heading {
    display: flex;
    align-items: baseline;
    gap: 9px;
  }
  .brand-version {
    color: rgba(191, 219, 254, 0.88);
    font-size: 12px;
    font-weight: 750;
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
  }
  .brand-copy {
    margin: 8px 0 0;
    color: rgba(226, 232, 240, 0.72);
    font-size: 13px;
  }
  .nav { display: grid; gap: 4px; }
  .nav-link {
    width: 100%;
    min-height: 42px;
    border: 1px solid transparent;
    border-radius: 7px;
    padding: 10px 12px;
    color: rgba(226, 232, 240, 0.76);
    background: transparent;
    text-align: left;
    cursor: pointer;
    transition: background 160ms ease, color 160ms ease;
  }
  .nav-link:hover {
    color: #ffffff;
    background: rgba(255, 255, 255, 0.09);
  }
  .nav-link.active {
    color: #ffffff;
    border-color: rgba(255, 255, 255, 0.08);
    background: linear-gradient(135deg, rgba(92, 113, 240, 0.88), rgba(112, 78, 210, 0.78));
    box-shadow: 0 8px 20px rgba(44, 57, 126, 0.28);
  }

  .main {
    min-width: 0;
    height: 100vh;
    overflow: auto;
    padding: 32px clamp(24px, 3vw, 48px) 44px;
  }
  .page { display: none; animation: page-enter 180ms ease both; }
  .page.active { display: block; }
  @keyframes page-enter {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 18px;
    margin-bottom: 22px;
  }
  .page-title {
    margin: 0;
    font-size: 32px;
    line-height: 1.2;
    letter-spacing: -0.035em;
  }
  .page-copy {
    max-width: 780px;
    margin: 10px 0 0;
    color: var(--muted);
    font-size: 15px;
  }

  .panel, .project-group, .session-simple-list, .binding-table-wrap, .command-section {
    border: 1px solid var(--line);
    background: var(--surface);
    box-shadow: var(--shadow-sm);
  }
  .bridge-path {
    display: grid;
    grid-template-columns: minmax(150px, 0.9fr) 24px minmax(180px, 1fr) 24px minmax(180px, 1fr) 24px minmax(210px, 1.2fr);
    align-items: stretch;
    margin-bottom: 20px;
    border: 1px solid rgba(121, 138, 198, 0.22);
    border-radius: 16px;
    background: linear-gradient(120deg, rgba(249, 250, 255, 0.98), rgba(246, 242, 255, 0.88));
    box-shadow: 0 12px 30px rgba(79, 94, 150, 0.08);
    overflow: hidden;
  }
  .bridge-path-node {
    position: relative;
    min-width: 0;
    padding: 18px;
  }
  .bridge-path-node:not(:last-child)::after {
    content: "";
    position: absolute;
    top: 18px;
    right: -13px;
    bottom: 18px;
    width: 1px;
    background: linear-gradient(180deg, transparent, rgba(117, 130, 174, 0.24), transparent);
  }
  .bridge-path-kicker, .info-item strong, .session-label, .channel-action-label, .channel-editor-stat strong, .session-history-stat strong {
    display: block;
    color: var(--muted);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.02em;
  }
  .bridge-path-value {
    display: block;
    margin-top: 8px;
    font-size: 19px;
    line-height: 1.25;
    font-weight: 800;
    word-break: break-word;
  }
  .bridge-path-meta {
    display: block;
    margin-top: 6px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.45;
    font-variant-numeric: tabular-nums;
  }
  .bridge-path-meta-item { white-space: nowrap; }
  .bridge-path-arrow {
    display: grid;
    place-items: center;
    color: #7181c2;
    font-size: 16px;
  }
  .runtime-status-panel { margin-bottom: 20px; }
  .runtime-status-list {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }
  .runtime-status-item {
    position: relative;
    overflow: hidden;
    min-width: 0;
    display: grid;
    gap: 8px;
    padding: 16px;
    text-align: left;
    border-color: rgba(111, 126, 176, 0.16);
    border-radius: 13px;
    background: linear-gradient(145deg, #ffffff, #f7f9fe);
    box-shadow: 0 6px 18px rgba(57, 72, 120, 0.06);
    transition: transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease, background 160ms ease;
  }
  .runtime-status-item::after { content: ""; position: absolute; inset: 0 0 auto 0; height: 3px; background: #7c8bab; }
  .runtime-status-item[data-runtime="codex"]::after { background: linear-gradient(90deg, #4f6df5, #6d5ee7); }
  .runtime-status-item[data-runtime="claude"]::after { background: linear-gradient(90deg, #d97745, #f0a66c); }
  .runtime-status-item[data-runtime="kimi"]::after { background: linear-gradient(90deg, #5b5ce2, #9b6be8); }
  .runtime-status-item[data-runtime="cursor"]::after { background: linear-gradient(90deg, #1f2937, #64748b); }
  .runtime-status-item:hover {
    transform: translateY(-1px);
    border-color: rgba(79, 109, 245, 0.30);
    background: #ffffff;
    box-shadow: 0 12px 26px rgba(58, 72, 122, 0.12);
  }
  .runtime-status-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .runtime-status-head strong { min-width: 0; font-size: 15px; }
  .runtime-status-item[data-default-runtime="true"] .runtime-status-head strong::after {
    content: "默认";
    margin-left: 7px;
    padding: 2px 6px;
    border-radius: 999px;
    color: var(--primary);
    background: var(--primary-soft);
    font-size: 10px;
    font-weight: 750;
  }
  .runtime-state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    color: var(--muted-strong);
    font-size: 12px;
    font-weight: 750;
  }
  .runtime-state::before { content: ""; width: 7px; height: 7px; border-radius: 999px; background: #98a2b3; }
  .runtime-status-item[data-status="running"] .runtime-state { color: #027a48; }
  .runtime-status-item[data-status="running"] .runtime-state::before { background: #12b76a; }
  .runtime-status-item[data-status="queued"] .runtime-state { color: #175cd3; }
  .runtime-status-item[data-status="queued"] .runtime-state::before { background: #2e90fa; }
  .runtime-status-item[data-status="attention"] .runtime-state { color: #b54708; }
  .runtime-status-item[data-status="attention"] .runtime-state::before { background: #f79009; }
  .runtime-status-item[data-status="available"] .runtime-state { color: #6941c6; }
  .runtime-status-item[data-status="available"] .runtime-state::before { background: #9e77ed; }
  .runtime-status-counts, .runtime-status-config, .runtime-status-recent {
    min-width: 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .runtime-status-config { color: var(--muted-strong); }
  .panel {
    border-radius: 16px;
    padding: 24px;
  }
  .overview-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.9fr);
    gap: 20px;
  }
  .section-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 20px;
  }
  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 18px;
  }
  .panel-header h2, .panel-header h3 {
    margin: 0;
    font-size: 20px;
    line-height: 1.2;
    letter-spacing: -0.025em;
  }
  .panel-header p {
    margin: 7px 0 0;
    color: var(--muted);
  }
  .panel-block {
    margin-top: 18px;
    padding-top: 18px;
    border-top: 1px solid var(--line);
  }
  .panel-subtitle {
    margin: 0 0 10px;
    font-size: 14px;
    font-weight: 850;
  }
  .panel-subtitle-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
  }
  .panel-subtitle-row .panel-subtitle { margin-bottom: 0; }
  .inline-status {
    color: var(--muted-strong);
    font-size: 12px;
    font-weight: 750;
  }
  .config-tabs {
    display: flex;
    gap: 4px;
    margin: 0 -4px 2px;
    padding: 0 4px 12px;
    overflow-x: auto;
    border-bottom: 1px solid var(--line);
  }
  .config-tab {
    flex: 0 0 auto;
    min-height: 36px;
    border-color: transparent;
    padding: 7px 12px;
    color: var(--muted-strong);
    background: transparent;
  }
  .config-tab.active {
    border-color: var(--line-strong);
    color: var(--text);
    background: var(--surface-tint);
  }
  [data-config-section] { margin-top: 0; padding-top: 18px; border-top: 0; }
  [data-config-section][hidden] { display: none; }
  .config-section-secondary { margin-top: 18px; border-top: 1px solid var(--line); }

  .toolbar, .actions, .session-actions, .toolbar-danger {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  button {
    min-height: 40px;
    border: 1px solid var(--line-strong);
    border-radius: 8px;
    padding: 9px 14px;
    color: var(--text);
    background: #ffffff;
    box-shadow: none;
    cursor: pointer;
    font-weight: 750;
    transition: border-color 150ms ease, color 150ms ease, background 150ms ease;
  }
  button:hover {
    border-color: rgba(37, 99, 235, 0.42);
    color: var(--primary);
    background: var(--primary-soft);
  }
  button.primary {
    border-color: transparent;
    color: #ffffff;
    background: linear-gradient(135deg, #5b76f7, #4d5fd7 58%, #7654d8);
    box-shadow: 0 8px 18px rgba(76, 93, 215, 0.22);
  }
  button.primary:hover {
    color: #ffffff;
    background: linear-gradient(135deg, #4d68e9, #414fc3 58%, #6545c4);
    box-shadow: 0 10px 24px rgba(76, 93, 215, 0.30);
  }
  button.danger {
    border-color: rgba(220, 38, 38, 0.20);
    color: var(--danger);
  }
  button.danger:hover {
    border-color: rgba(220, 38, 38, 0.48);
    color: var(--danger);
  }
  button[disabled], button[disabled]:hover {
    transform: none;
    border-color: var(--line);
    color: #94a3b8;
    background: rgba(241, 245, 249, 0.74);
    box-shadow: none;
    cursor: not-allowed;
  }
  .icon-toolbar { align-items: center; }
  .icon-btn {
    width: 38px;
    height: 38px;
    min-height: 38px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border-radius: 8px;
    flex: 0 0 auto;
  }
  .icon-btn svg {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.9;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .ghost-icon {
    background: rgba(255, 255, 255, 0.52);
    box-shadow: none;
  }
  .mini-icon {
    width: 28px;
    height: 28px;
    min-height: 28px;
    border-radius: 10px;
  }
  .mini-icon svg {
    width: 14px;
    height: 14px;
  }
  .swap-icon {
    color: #0f766e;
    border-color: rgba(13, 148, 136, 0.30);
    background: rgba(20, 184, 166, 0.10);
  }

  .fields { display: grid; gap: 16px; }
  .field-row {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }
  .field-row.triple { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  label {
    display: grid;
    gap: 8px;
    color: var(--muted-strong);
    font-weight: 750;
  }
  input, select, textarea {
    min-width: 0;
    width: 100%;
    border: 1px solid var(--line-strong);
    border-radius: 8px;
    padding: 10px 12px;
    color: var(--text);
    background: #ffffff;
    outline: none;
    transition: border-color 150ms ease, box-shadow 150ms ease, background 150ms ease;
  }
  input, select { min-height: 42px; }
  select.uses-default { color: var(--muted); }
  select option { color: var(--text); }
  select option[value=""] { color: var(--muted); }
  textarea { min-height: 220px; resize: vertical; }
  input:focus, select:focus, textarea:focus {
    border-color: rgba(37, 99, 235, 0.66);
    background: #ffffff;
    box-shadow: var(--ring);
  }
  .field-title {
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }
  .help-tip {
    position: relative;
    z-index: 5200;
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(37, 99, 235, 0.34);
    border-radius: 999px;
    color: var(--primary);
    background: rgba(37, 99, 235, 0.08);
    font-size: 11px;
    font-weight: 900;
    line-height: 1;
    cursor: help;
  }
  .help-tip::after {
    content: attr(data-tip);
    position: absolute;
    left: 50%;
    bottom: calc(100% + 9px);
    width: max-content;
    max-width: min(320px, calc(100vw - 36px));
    transform: translateX(-50%) translateY(4px);
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    z-index: 9999;
    padding: 9px 11px;
    border: 1px solid rgba(15, 23, 42, 0.12);
    border-radius: 12px;
    color: #0f172a;
    background: rgba(255, 255, 255, 0.96);
    box-shadow: var(--shadow-md);
    font-size: 12px;
    font-weight: 650;
    line-height: 1.45;
    white-space: normal;
    transition: opacity 80ms ease, transform 80ms ease, visibility 80ms ease;
  }
  .help-tip:hover::after,
  .help-tip:focus::after {
    opacity: 1;
    visibility: visible;
    transform: translateX(-50%) translateY(0);
  }
  .checkbox-row { display: flex; gap: 14px; flex-wrap: wrap; }
  .checkbox { display: inline-flex; align-items: center; gap: 9px; color: var(--text); }
  .checkbox-field {
    min-height: 42px;
    width: 100%;
    border: 1px solid var(--line-strong);
    border-radius: 8px;
    padding: 10px 12px;
    background: #ffffff;
  }
  .checkbox input { width: 17px; height: 17px; margin: 0; accent-color: var(--primary); }
  .notice, .info-item, .binding-empty {
    padding: 13px 15px;
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--muted-strong);
    background: linear-gradient(145deg, #f9fafe, #f5f7fc);
  }
  .info-list { display: grid; gap: 12px; }
  .info-item strong { margin-bottom: 5px; }
  .mono, .project-group-path, .session-path, .binding-detail code { font-family: "Cascadia Code", Consolas, "SF Mono", monospace; }

  .message { display: none; }
  .global-message-host {
    position: fixed;
    top: 18px;
    left: 50%;
    transform: translateX(-50%);
    display: grid;
    gap: 12px;
    z-index: 2400;
    pointer-events: none;
  }
  .global-message {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-width: 280px;
    max-width: min(680px, calc(100vw - 32px));
    padding: 12px 14px;
    border: 1px solid var(--line-strong);
    border-radius: 8px;
    color: var(--text);
    background: #ffffff;
    box-shadow: var(--shadow-md);
    animation: message-enter 180ms ease;
  }
  .global-message-icon {
    width: 20px;
    height: 20px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 900;
    background: rgba(15, 23, 42, 0.06);
  }
  .global-message.success .global-message-icon { color: var(--green); background: rgba(5, 150, 105, 0.12); }
  .global-message.error .global-message-icon { color: var(--danger); background: rgba(220, 38, 38, 0.10); }
  .global-message-content { min-width: 0; word-break: break-word; }
  @keyframes message-enter {
    from { opacity: 0; transform: translateY(-8px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  .session-list, .session-section, .project-session-list, .binding-list, .command-sections { min-width: 0; display: grid; gap: 14px; }
  #boundSessionsList, #codexSessionsList { min-width: 0; max-width: 100%; }
  .session-filter-bar {
    display: grid;
    grid-template-columns: minmax(240px, 1fr) minmax(180px, 240px) auto;
    align-items: end;
    gap: 12px;
    margin-top: 16px;
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface-soft);
  }
  .session-filter-bar label { gap: 6px; font-size: 12px; }
  .session-section + .session-section { margin-top: 22px; }
  .session-section-head, .project-group-head, .binding-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
  }
  .session-section-title { margin: 0; font-size: 16px; font-weight: 850; }
  .session-section-meta, .small, .ghost { color: var(--muted); font-size: 12px; }
  .project-group {
    padding: 16px;
    border-radius: var(--radius-md);
    display: grid;
    gap: 14px;
  }
  .project-group-title, .session-title, .session-simple-title, .binding-title, .binding-table-title { font-weight: 850; }
  .project-group-path, .project-group-count, .session-thread, .session-value, .session-path, .session-simple-thread, .session-simple-time, .session-simple-path, .binding-detail, .binding-table-thread, .binding-table-path, .channel-list-item-provider, .channel-list-item-meta, .channel-list-item-stats, .channel-sidebar-meta, .channel-action-hint {
    color: var(--muted);
    font-size: 12px;
    word-break: break-word;
  }
  .session-card, .session-simple-item, .binding-item {
    border: 1px solid var(--line);
    border-radius: 10px;
    background: #ffffff;
    transition: border-color 150ms ease, background 150ms ease, box-shadow 150ms ease, transform 150ms ease;
  }
  .session-card { padding: 15px; }
  .session-card.current-thread { border-color: rgba(37, 99, 235, 0.38); background: var(--primary-soft); }
  .session-card.session-openable { cursor: default; }
  .session-card.session-openable:hover, .session-simple-item:hover {
    border-color: rgba(37, 99, 235, 0.32);
    background: var(--primary-soft);
    box-shadow: var(--shadow-sm);
  }
  .session-head {
    display: grid;
    grid-template-columns: minmax(0, 1.9fr) 150px minmax(220px, 1fr) auto;
    gap: 16px;
    align-items: center;
  }
  .session-main, .session-cell, .session-simple-main, .session-simple-side { min-width: 0; display: grid; gap: 5px; }
  .session-title-row { max-width: min(540px, 100%); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .session-title {
    min-width: 0;
    max-width: min(420px, 100%);
    flex: 1 1 240px;
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-height: 1.35;
    word-break: break-word;
  }
  .session-mark, .binding-table-mark, .pill, .session-binding-tag {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    border-radius: 999px;
    padding: 3px 9px;
    font-size: 12px;
    font-weight: 750;
    border: 1px solid rgba(37, 99, 235, 0.18);
    color: var(--primary);
    background: var(--primary-soft);
  }
  .session-inline-action {
    min-height: auto;
    margin-left: 8px;
    border: 0;
    padding: 0;
    color: var(--primary);
    background: transparent;
    box-shadow: none;
    font-size: 12px;
  }
  .session-binding-tags { display: grid; gap: 8px; margin-top: 10px; }
  .session-binding-tag { width: fit-content; max-width: 100%; border-radius: 13px; }
  .session-binding-tag button { min-height: 28px; padding: 4px 8px; border-radius: 999px; background: #ffffff; font-size: 12px; }
  .session-simple-list { border-radius: var(--radius-md); overflow: hidden; }
  .session-simple-item {
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(220px, 1fr) auto;
    gap: 16px;
    align-items: center;
    padding: 15px 16px;
    border-width: 1px 0 0;
    border-radius: 0;
    cursor: pointer;
  }
  .session-simple-item:first-child { border-top: 0; }
  .session-actions { justify-content: flex-end; align-items: center; }
  .compact-actions { gap: 8px; flex-wrap: nowrap; }
  .session-table-wrap { margin-top: 0; }
  .session-table { min-width: 1080px; table-layout: fixed; }
  .session-table th { text-align: center; }
  .session-table-row { cursor: default; transition: background 150ms ease; }
  .session-table-row:hover { background: rgba(37, 99, 235, 0.05); }
  .session-table th:nth-child(1) { width: 30%; }
  .session-table th:nth-child(2) { width: 20%; }
  .session-table th:nth-child(3) { width: 120px; }
  .session-table th:nth-child(4) { width: 100px; }
  .session-table th:nth-child(5) { width: 150px; }
  .session-table th:last-child,
  .session-table td:last-child { width: 190px; text-align: right; }
  .session-table td:nth-child(3) { text-align: center; }
  .session-table td:nth-child(3) .session-value { white-space: nowrap; }
  .session-table .pill { margin-left: 6px; }
  .session-date {
    white-space: nowrap;
    word-break: normal;
    font-variant-numeric: tabular-nums;
  }
  .pill-tui {
    border-color: rgba(245, 158, 11, 0.38);
    color: #b45309;
    background: rgba(245, 158, 11, 0.14);
  }
  .pill-bridge {
    border-color: rgba(37, 99, 235, 0.30);
    color: var(--primary);
    background: var(--primary-soft);
  }
  .pill-vscode {
    border-color: rgba(124, 58, 237, 0.30);
    color: var(--violet);
    background: rgba(124, 58, 237, 0.10);
  }
  .pill-sdk {
    border-color: rgba(100, 116, 139, 0.30);
    color: #64748b;
    background: rgba(100, 116, 139, 0.12);
  }
  .creator-toggle {
    min-height: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    color: inherit;
    background: transparent;
    box-shadow: none;
    vertical-align: middle;
    white-space: nowrap;
    word-break: normal;
  }
  .creator-toggle .pill {
    margin-left: 0;
    white-space: nowrap;
    word-break: normal;
  }
  .creator-toggle[data-action="toggle-creator-display"] {
    max-width: 220px;
    overflow: hidden;
    color: var(--muted);
    font-size: 12px;
    text-overflow: ellipsis;
  }

  .session-history-layout {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    gap: 16px;
    height: calc(100vh - 164px);
    min-height: 440px;
    overflow: hidden;
  }
  .session-history-header { align-items: flex-start; }
  .session-history-titlebar {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    min-width: 0;
  }
  .session-history-title {
    font-weight: 650;
    letter-spacing: -0.045em;
  }
  .session-history-summary, .channel-editor-summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }
  .channel-editor-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-bottom: 18px; }
  .session-history-stat, .channel-editor-stat {
    min-width: 0;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface-soft);
    padding: 13px 14px;
  }
  .session-history-stat span, .channel-editor-stat span { display: block; margin-top: 4px; font-weight: 850; word-break: break-word; }
  .chat-history-list {
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface-soft);
  }
  .chat-history-message {
    width: 100%;
    border: 1px solid var(--line);
    border-left: 4px solid var(--line-strong);
    border-radius: 8px;
    background: #ffffff;
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  }
  .chat-history-bubble { padding: 13px 15px; }
  .chat-history-message.user { border-left-color: var(--primary); background: rgba(37, 99, 235, 0.07); }
  .chat-history-message.assistant { border-left-color: var(--green); }
  .chat-history-message.system { border-left-color: var(--amber); background: rgba(245, 158, 11, 0.08); }
  .chat-history-message.tool { border-left-color: var(--violet); background: rgba(124, 58, 237, 0.07); }
  .chat-history-message-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    margin-bottom: 8px;
    color: var(--muted);
    font-size: 12px;
  }
  .chat-history-role { color: var(--text); font-weight: 850; }
  .chat-history-message-meta { display: inline-flex; align-items: center; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
  .chat-history-copy { min-height: 26px; padding: 2px 9px; border-radius: 999px; font-size: 12px; }
  .chat-history-icon {
    width: 30px;
    height: 30px;
    min-height: 30px;
    border-radius: 10px;
  }
  .chat-history-icon svg { width: 15px; height: 15px; }
  .chat-history-content { word-break: break-word; color: #1f2937; line-height: 1.68; }
  .chat-history-content.raw { white-space: pre-wrap; }
  .chat-history-content.markdown > :first-child { margin-top: 0; }
  .chat-history-content.markdown > :last-child { margin-bottom: 0; }
  .chat-history-content.markdown p, .chat-history-content.markdown ul, .chat-history-content.markdown ol, .chat-history-content.markdown blockquote, .chat-history-content.markdown pre { margin: 0 0 10px; }
  .chat-history-content.markdown ul, .chat-history-content.markdown ol { padding-left: 22px; }
  .chat-history-content.markdown blockquote { padding: 8px 12px; border-left: 3px solid var(--line-strong); background: rgba(15, 23, 42, 0.04); color: #475569; }
  .chat-history-content.markdown code { padding: 1px 5px; border-radius: 6px; background: rgba(15, 23, 42, 0.08); color: #334155; font-family: "Cascadia Code", Consolas, "SF Mono", monospace; font-size: 0.94em; }
  .chat-history-content.markdown pre { overflow: auto; padding: 13px 15px; border-radius: 14px; background: var(--code-bg); color: #e2e8f0; }
  .chat-history-content.markdown pre code { padding: 0; background: transparent; color: inherit; }
  .chat-history-content.markdown a { color: var(--primary); text-decoration: underline; text-underline-offset: 2px; }

  .channel-workspace { padding: 0; overflow: hidden; }
  .channel-workspace .panel-header {
    margin: 0;
    padding: 22px;
    border-bottom: 1px solid var(--line);
    align-items: stretch;
  }
  .channel-header-copy { max-width: 640px; }
  .channel-header-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, max-content));
    align-items: stretch;
    justify-content: flex-end;
    gap: 12px;
  }
  .channel-action-group {
    min-width: 224px;
    display: grid;
    gap: 8px;
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface-soft);
  }
  .channel-action-row { display: flex; align-items: center; gap: 10px; }
  .channel-action-row select { min-width: 112px; }
  .channel-create-button, .channel-refresh-button { min-height: 40px; white-space: nowrap; }
  .channel-layout {
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr);
    gap: 20px;
    padding: 22px;
  }
  .channel-sidebar {
    display: grid;
    align-content: start;
    gap: 12px;
    padding-right: 20px;
    border-right: 1px solid var(--line);
  }
  .channel-list { display: grid; gap: 9px; }
  .channel-list-item {
    width: 100%;
    display: grid;
    gap: 8px;
    padding: 13px 14px;
    text-align: left;
    border-radius: 8px;
  }
  .channel-list-item.active {
    border-color: rgba(37, 99, 235, 0.34);
    color: var(--text);
    background: var(--primary-soft);
  }
  .channel-list-item-head, .channel-list-item-stats {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
  }
  .channel-list-item-title, .channel-list-item-status { font-weight: 850; }
  .channel-editor { min-width: 0; }
  .editor-section { display: grid; gap: 14px; padding-top: 16px; border-top: 1px solid var(--line); }
  .editor-section-title { margin: 0; font-size: 14px; font-weight: 850; }
  .toolbar-split { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
  .inline-select { display: inline-grid; gap: 6px; color: var(--muted); font-size: 12px; font-weight: 750; }
  .channel-tabs { display: flex; align-items: flex-end; gap: 0; padding: 0 22px; border-bottom: 1px solid var(--line); background: var(--surface-soft); }
  .channel-tab { border: 0; border-bottom: 2px solid transparent; border-radius: 0; padding: 14px 18px 12px; color: var(--muted); background: transparent; box-shadow: none; }
  .channel-tab.active { color: var(--primary); border-bottom-color: var(--primary); }
  .channel-view { display: none; padding: 22px; }
  .channel-view.active { display: block; }

  .binding-tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
  .binding-tab { min-height: 36px; border-radius: 999px; color: var(--muted); background: rgba(255, 255, 255, 0.74); }
  .binding-tab.active { border-color: rgba(37, 99, 235, 0.32); color: var(--primary); background: var(--primary-soft); }
  .binding-item { padding: 14px; }
  .binding-detail { margin-top: 5px; }
  .binding-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; margin-top: 12px; }
  .binding-table-wrap { width: 100%; max-width: 100%; min-width: 0; margin-top: 12px; border-radius: 10px; overflow: auto; }
  .binding-table { width: 100%; min-width: 860px; border-collapse: collapse; }
  .binding-table th, .binding-table td { padding: 11px 12px; border-top: 1px solid var(--line); text-align: left; vertical-align: top; }
  .binding-table thead th { border-top: 0; color: var(--muted); font-size: 12px; font-weight: 850; background: rgba(248, 250, 252, 0.92); }
  .binding-table.session-table thead th { text-align: center; }
  .binding-table tbody tr.current { background: rgba(37, 99, 235, 0.05); }
  .pill { margin-left: 8px; border-color: var(--line); color: var(--muted); background: #ffffff; }
  .pill-bridge { border-color: rgba(37, 99, 235, 0.28); color: var(--primary); background: var(--primary-soft); }
  .pill-native { border-color: rgba(5, 150, 105, 0.30); color: var(--green); background: rgba(5, 150, 105, 0.10); }
  .pill-desktop { border-color: rgba(5, 150, 105, 0.30); color: var(--green); background: rgba(5, 150, 105, 0.10); }
  .pill-tui { border-color: rgba(245, 158, 11, 0.40); color: #b45309; background: rgba(245, 158, 11, 0.16); }
  .pill-vscode { border-color: rgba(124, 58, 237, 0.30); color: var(--violet); background: rgba(124, 58, 237, 0.10); }
  .pill-sdk { border-color: rgba(100, 116, 139, 0.30); color: #64748b; background: rgba(100, 116, 139, 0.12); }
  .binding-target-btn { white-space: nowrap; }
  .binding-target-btn.current { border-color: rgba(37, 99, 235, 0.32); color: var(--primary); background: var(--primary-soft); }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 2300;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(16, 24, 40, 0.48);
  }
  .modal-backdrop[hidden] { display: none; }
  .modal-card {
    width: min(560px, 100%);
    border: 1px solid var(--line-strong);
    border-radius: 12px;
    padding: 18px;
    background: #ffffff;
    box-shadow: var(--shadow-lg);
  }
  .modal-head {
    display: flex;
    justify-content: space-between;
    gap: 14px;
    align-items: flex-start;
    margin-bottom: 14px;
  }
  .modal-head h2 { margin: 0; font-size: 20px; letter-spacing: -0.03em; }
  .modal-head p { margin: 6px 0 0; color: var(--muted); }
  .modal-list { display: grid; gap: 10px; }
  .modal-list-item {
    width: 100%;
    display: grid;
    gap: 5px;
    text-align: left;
    padding: 13px 14px;
    border-radius: 8px;
  }
  .modal-list-item.active {
    border-color: rgba(37, 99, 235, 0.32);
    color: var(--primary);
    background: var(--primary-soft);
  }
  .modal-list-title { font-weight: 850; }
  .modal-list-meta { color: var(--muted); font-size: 12px; }

  .command-section { border-radius: 10px; overflow: hidden; }
  .command-section-title {
    margin: 0;
    padding: 12px 15px;
    font-size: 15px;
    font-weight: 850;
    border-bottom: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.72);
  }
  .command-list { display: grid; }
  .command-list-head, .command-item {
    display: grid;
    grid-template-columns: 220px 320px minmax(0, 1fr);
    gap: 16px;
    align-items: start;
    padding: 11px 15px;
  }
  .command-list-head {
    color: var(--muted);
    font-size: 12px;
    font-weight: 850;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    background: rgba(248, 250, 252, 0.88);
  }
  .command-item { border-top: 1px solid var(--line); }
  .command-item code { word-break: break-all; }
  .command-col-command, .command-col-original, .command-col-desc { min-width: 0; }
  .command-col-desc { color: var(--muted-strong); }

  .logs-panel {
    height: calc(100vh - 164px);
    min-height: 440px;
    overflow: hidden;
    padding: 12px;
    background: #101828;
  }
  .logs {
    height: 100%;
    overflow: auto;
    word-break: break-word;
    border-radius: 8px;
    padding: 18px;
    color: #dbeafe;
    background: var(--code-bg);
    font-family: "Cascadia Code", Consolas, "SF Mono", monospace;
    font-size: 12px;
    line-height: 1.7;
  }
  .log-line {
    min-height: 24px;
    white-space: pre-wrap;
    border-left: 3px solid transparent;
    padding-left: 10px;
  }
  .log-date { color: #93c5fd; }
  .log-tag {
    color: #c4b5fd;
    font-weight: 800;
  }
  .log-level {
    display: inline-flex;
    padding: 0 6px;
    border-radius: 999px;
    font-weight: 850;
    background: rgba(148, 163, 184, 0.16);
  }
  .log-error { border-left-color: #fb7185; color: #fecdd3; }
  .log-error .log-level { color: #fecdd3; background: rgba(244, 63, 94, 0.22); }
  .log-warn, .log-warning { border-left-color: #fbbf24; color: #fde68a; }
  .log-warn .log-level, .log-warning .log-level { color: #fef3c7; background: rgba(245, 158, 11, 0.22); }
  .log-info { border-left-color: #38bdf8; }
  .log-debug, .log-trace { border-left-color: #a78bfa; color: #ddd6fe; }

  @media (max-width: 1180px) {
    .overview-grid, .section-grid { grid-template-columns: 1fr; }
    .runtime-status-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 980px) {
    .shell { grid-template-columns: 1fr; }
    .sidebar { position: relative; height: auto; padding: 12px 14px; }
    .brand {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
      padding: 0 4px 8px;
    }
    .brand::before { grid-row: 1; margin: 0; }
    .brand-heading { grid-column: 2; }
    .brand-copy { display: none; }
    .nav { display: flex; gap: 2px; overflow-x: auto; padding-bottom: 2px; }
    .nav-link { width: auto; flex: 0 0 auto; min-height: 36px; padding: 7px 9px; }
    .main { height: auto; overflow: visible; padding: 24px 18px 32px; }
    .channel-layout { grid-template-columns: 1fr; }
    .channel-sidebar { border-right: 0; padding-right: 0; }
    .channel-header-actions { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); justify-content: stretch; }
    .channel-action-group { min-width: 0; }
    .channel-editor-summary { grid-template-columns: 1fr; }
    .field-row, .field-row.triple, .command-item, .command-list-head, .binding-controls { grid-template-columns: 1fr; }
    .session-history-layout, .logs-panel { height: calc(100vh - 190px); }
    .session-history-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 720px) {
    .help-tip::after {
      position: fixed;
      inset: auto 16px 16px;
      width: auto;
      transform: none;
    }
    .help-tip:hover::after,
    .help-tip:focus::after { transform: none; }
    .config-tabs { flex-wrap: wrap; overflow: visible; }
    .bridge-path { grid-template-columns: 1fr; }
    .runtime-status-list { grid-template-columns: 1fr; }
    .bridge-path-node {
      display: grid;
      grid-template-columns: 78px 76px minmax(0, 1fr);
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
    }
    .bridge-path-value, .bridge-path-meta { margin-top: 0; }
    .bridge-path-value { font-size: 15px; }
    .bridge-path-arrow { min-height: 14px; transform: rotate(90deg); font-size: 13px; }
    .session-history-summary { grid-template-columns: 1fr; }
    .session-filter-bar { grid-template-columns: 1fr; }
    .session-filter-bar button { width: 100%; }
    .page-header, .panel-header, .project-group-head, .binding-head, .session-section-head { flex-direction: column; align-items: stretch; }
    .channel-header-actions, .channel-action-row, .channel-action-group, .channel-refresh-button, .channel-create-button { width: 100%; }
    .channel-action-row { display: grid; grid-template-columns: 1fr; }
    .session-head, .session-simple-item { grid-template-columns: 1fr; }
    .session-actions { justify-content: flex-start; }
    .chat-history-list { padding: 12px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      scroll-behavior: auto !important;
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }
`;
