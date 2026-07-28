#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_LOG_PATH = path.join(os.homedir(), '.codelark', 'logs', 'bridge.log');
const DEFAULT_OUT_DIR = path.join(process.cwd(), 'work', `bridge-log-analysis-${timestampForPath(new Date())}`);

function parseArgs(argv) {
  const options = {
    logPath: DEFAULT_LOG_PATH,
    outDir: DEFAULT_OUT_DIR,
    sinceMs: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--log') {
      options.logPath = argv[++i] || options.logPath;
    } else if (arg.startsWith('--log=')) {
      options.logPath = arg.slice('--log='.length);
    } else if (arg === '--out') {
      options.outDir = argv[++i] || options.outDir;
    } else if (arg.startsWith('--out=')) {
      options.outDir = arg.slice('--out='.length);
    } else if (arg === '--since') {
      options.sinceMs = parseSince(argv[++i]);
    } else if (arg.startsWith('--since=')) {
      options.sinceMs = parseSince(arg.slice('--since='.length));
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/analyze-bridge-log.js [--log PATH] [--out DIR] [--since DATE_OR_MS]

Reads bridge.log JSONL and writes:
  - index.html

Examples:
  node scripts/analyze-bridge-log.js --out work/lane-flamegraph-latest
  node scripts/analyze-bridge-log.js --since 2026-06-05T04:46:57Z
`);
}

function parseSince(value) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid --since value: ${value}`);
  }
  return parsed;
}

function timestampForPath(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
}

function readJsonl(logPath, sinceMs) {
  const lines = fs.readFileSync(logPath, 'utf8').split(/\n/).filter(Boolean);
  const entries = [];
  let parseErrors = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const timeMs = Date.parse(entry.time || '');
      if (!Number.isFinite(timeMs)) continue;
      if (sinceMs !== null && timeMs < sinceMs) continue;
      entries.push({ ...entry, __time_ms: timeMs });
    } catch {
      parseErrors += 1;
    }
  }

  return { entries, parseErrors };
}

function buildAdapterSpans(entries) {
  const spans = new Map();
  const events = entries.filter((entry) => String(entry.event || '').startsWith('adapter.message.'));
  let fallbackSeq = 0;

  for (const entry of events) {
    fallbackSeq += 1;
    const id = entry.span_id || entry.message_id || entry.message || `adapter-message:missing:${fallbackSeq}`;
    const span = spans.get(id) || {
      span_id: id,
      events: [],
    };

    span.events.push(entry.event);
    for (const key of [
      'lane',
      'lane_kind',
      'channel',
      'chat',
      'category',
      'job_kind',
      'message_id',
      'message',
      'text',
      'status',
      'session_id',
      'uses_session_lock',
      'conversation_barrier',
      'blocked_by_span_id',
      'blocked_by_message_id',
      'blocked_by_session_id',
      'blocked_by_category',
      'blocked_by_age_ms',
      'message_timestamp_ms',
    ]) {
      if (entry[key] !== undefined && entry[key] !== null) span[key] = entry[key];
    }

    if (entry.event === 'adapter.message.scheduled') {
      span.scheduled_at_ms = entry.scheduled_at_ms || entry.__time_ms;
      span.message_age_ms_at_schedule = entry.message_age_ms;
    } else if (entry.event === 'adapter.message.started') {
      span.started_at_ms = entry.started_at_ms || entry.__time_ms;
      span.lane_wait_ms = entry.lane_wait_ms;
      span.session_lock_wait_ms = entry.session_lock_wait_ms;
    } else if (entry.event === 'adapter.session_lock.acquired') {
      span.session_lock_acquired_at_ms = entry.__time_ms;
      span.session_lock_wait_ms = entry.session_lock_wait_ms;
    } else if (entry.event === 'adapter.message.finished') {
      span.finished_at_ms = entry.finished_at_ms || entry.ended_at_ms || entry.__time_ms;
      span.ended_at_ms = entry.ended_at_ms || entry.__time_ms;
      span.duration_ms = entry.duration_ms;
      span.total_ms = entry.total_ms;
      span.lane_wait_ms = entry.lane_wait_ms ?? span.lane_wait_ms;
      span.session_lock_wait_ms = entry.session_lock_wait_ms ?? span.session_lock_wait_ms;
      span.status = entry.status || span.status;
    } else if (entry.event === 'adapter.message.error') {
      span.error_at_ms = entry.__time_ms;
      span.status = 'error';
      span.error = entry.error;
    }

    spans.set(id, span);
  }

  const all = Array.from(spans.values());
  return {
    events,
    spans: all,
    completed: all.filter((span) => Number.isFinite(span.scheduled_at_ms) && Number.isFinite(span.finished_at_ms)),
    pending: all.filter((span) => Number.isFinite(span.scheduled_at_ms) && !Number.isFinite(span.finished_at_ms)),
  };
}

function buildFeishuRequests(entries) {
  return entries
    .filter((entry) => (
      entry.event === 'perf.feishu.request'
      && entry.status !== 'start'
      && entry.phase !== 'start'
      && Number.isFinite(entry.duration_ms)
    ))
    .map((entry) => {
      const endMs = entry.__time_ms;
      const durationMs = Number(entry.duration_ms);
      const operation = entry.operation || entry.target || 'unknown';
      return {
        time: entry.time,
        end_ms: endMs,
        start_ms: endMs - durationMs,
        duration_ms: durationMs,
        operation,
        target: operation,
        scope: entry.scope || '',
        status: entry.status || entry.phase || '',
        phase: entry.phase || entry.status || '',
        chat: entry.chat || entry.chatId || '',
        stream_key: entry.stream_key || entry.streamKey || '',
        card_id: entry.card_id || entry.cardId || '',
        response_card_id: entry.response_card_id || '',
        message_id: entry.message_id || entry.messageId || '',
        response_msg: entry.response_msg || '',
        detail: entry.detail || '',
      };
    });
}

function overlapMs(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function summarizeFeishuRequests(requests, adapterSpans) {
  const byOperation = new Map();
  const byScope = new Map();

  for (const request of requests) {
    addDurationGroup(byOperation, request.operation, request);
    if (request.scope) addDurationGroup(byScope, request.scope, request);
  }

  const operationRows = durationRows(byOperation);
  const scopeRows = durationRows(byScope);
  const slowRequests = [...requests].sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 30);
  const concurrency = summarizeRequestConcurrency(requests);
  const adapterOverlap = adapterSpans
    .filter((span) => Number.isFinite(span.started_at_ms) && Number.isFinite(span.finished_at_ms))
    .map((span) => {
      const globallyOverlappingRequests = requests
        .map((request) => ({
          ...request,
          overlap_ms: overlapMs(span.started_at_ms, span.finished_at_ms, request.start_ms, request.end_ms),
        }))
        .filter((request) => request.overlap_ms > 0)
        .sort((a, b) => b.overlap_ms - a.overlap_ms);
      const matchedRequests = globallyOverlappingRequests.filter((request) => requestMatchesSpan(request, span));
      const feishuOverlapMs = sum(matchedRequests.map((request) => request.overlap_ms));
      const globalOverlapMs = sum(globallyOverlappingRequests.map((request) => request.overlap_ms));
      return {
        span_id: span.span_id,
        message_id: span.message_id || span.message,
        lane: span.lane,
        chat: span.chat,
        category: span.category,
        job_kind: span.job_kind,
        text: span.text,
        started_at: iso(span.started_at_ms),
        finished_at: iso(span.finished_at_ms),
        total_ms: span.finished_at_ms - span.scheduled_at_ms,
        handler_ms: span.duration_ms || span.finished_at_ms - span.started_at_ms,
        lane_wait_ms: span.lane_wait_ms || 0,
        feishu_overlap_ms: feishuOverlapMs,
        global_feishu_overlap_ms: globalOverlapMs,
        global_feishu_request_count: globallyOverlappingRequests.length,
        feishu_request_count: matchedRequests.length,
        feishu_requests: matchedRequests.slice(0, 10).map((request) => ({
          operation: request.operation,
          status: request.status,
          duration_ms: request.duration_ms,
          overlap_ms: request.overlap_ms,
          scope: request.scope,
          chat: request.chat,
          stream_key: request.stream_key,
        })),
      };
    })
    .sort((a, b) => b.feishu_overlap_ms - a.feishu_overlap_ms)
    .slice(0, 20);

  return {
    count: requests.length,
    operationRows,
    scopeRows,
    slowRequests,
    concurrency,
    adapterOverlap,
  };
}

function requestMatchesSpan(request, span) {
  const spanChat = span.chat || chatFromLane(span.lane || '');
  const spanMessageId = span.message_id || span.message || '';
  if (spanChat && request.chat && request.chat === spanChat) return true;
  if (spanChat && request.scope && String(request.scope).includes(spanChat)) return true;
  if (spanChat && request.stream_key && String(request.stream_key).includes(spanChat)) return true;
  if (spanMessageId && request.scope && String(request.scope).includes(spanMessageId)) return true;
  return false;
}

function chatFromLane(lane) {
  const parts = String(lane || '').split(':');
  if (parts[0] !== 'chat' || parts.length < 3) return '';
  return parts.slice(2).join(':');
}

function addDurationGroup(groups, key, request) {
  const row = groups.get(key) || {
    key,
    count: 0,
    durations: [],
    statuses: new Map(),
    total_ms: 0,
  };
  row.count += 1;
  row.durations.push(request.duration_ms);
  row.total_ms += request.duration_ms;
  row.statuses.set(request.status, (row.statuses.get(request.status) || 0) + 1);
  groups.set(key, row);
}

function durationRows(groups) {
  return Array.from(groups.values())
    .map((row) => ({
      key: row.key,
      count: row.count,
      total_ms: row.total_ms,
      avg_ms: Math.round(row.total_ms / Math.max(1, row.count)),
      p50_ms: percentile(row.durations, 0.5),
      p90_ms: percentile(row.durations, 0.9),
      max_ms: Math.max(0, ...row.durations),
      statuses: Object.fromEntries(row.statuses.entries()),
    }))
    .sort((a, b) => b.total_ms - a.total_ms);
}

function summarizeRequestConcurrency(requests) {
  const points = [];
  for (const request of requests) {
    points.push({ time_ms: request.start_ms, delta: 1 });
    points.push({ time_ms: request.end_ms, delta: -1 });
  }
  points.sort((a, b) => a.time_ms - b.time_ms || b.delta - a.delta);

  let active = 0;
  let maxActive = 0;
  let activeWeightedMs = 0;
  let previousMs = null;
  const maxWindows = [];

  for (const point of points) {
    if (previousMs !== null && point.time_ms > previousMs) {
      activeWeightedMs += active * (point.time_ms - previousMs);
    }
    active += point.delta;
    if (active > maxActive) {
      maxActive = active;
      maxWindows.length = 0;
      maxWindows.push(point.time_ms);
    } else if (active === maxActive && point.delta > 0) {
      maxWindows.push(point.time_ms);
    }
    previousMs = point.time_ms;
  }

  const minMs = requests.length ? Math.min(...requests.map((request) => request.start_ms)) : 0;
  const maxMs = requests.length ? Math.max(...requests.map((request) => request.end_ms)) : 0;
  return {
    max_active: maxActive,
    avg_active: maxMs > minMs ? activeWeightedMs / (maxMs - minMs) : 0,
    max_active_at: maxWindows.slice(0, 5).map(iso),
  };
}

function summarizeAdapterSpans(spans) {
  const completed = spans.filter((span) => Number.isFinite(span.scheduled_at_ms) && Number.isFinite(span.finished_at_ms));
  const byLane = new Map();

  for (const span of completed) {
    const lane = span.lane || 'unknown';
    const row = byLane.get(lane) || {
      lane,
      lane_kind: span.lane_kind || 'unknown',
      count: 0,
      total_ms: 0,
      wait_ms: 0,
      handler_ms: 0,
      max_ms: 0,
    };
    const totalMs = span.finished_at_ms - span.scheduled_at_ms;
    const handlerMs = span.duration_ms || span.finished_at_ms - (span.started_at_ms || span.scheduled_at_ms);
    row.count += 1;
    row.total_ms += totalMs;
    row.wait_ms += span.lane_wait_ms || 0;
    row.handler_ms += handlerMs;
    row.max_ms = Math.max(row.max_ms, totalMs);
    byLane.set(lane, row);
  }

  const blockers = completed
    .filter((span) => span.blocked_by_span_id || (span.lane_wait_ms || 0) > 0)
    .map((span) => ({
      span_id: span.span_id,
      message_id: span.message_id || span.message,
      lane: span.lane,
      category: span.category,
      text: span.text,
      lane_wait_ms: span.lane_wait_ms || 0,
      total_ms: span.finished_at_ms - span.scheduled_at_ms,
      blocked_by_span_id: span.blocked_by_span_id,
      blocked_by_message_id: span.blocked_by_message_id,
      blocked_by_category: span.blocked_by_category,
      blocked_by_age_ms: span.blocked_by_age_ms,
    }))
    .sort((a, b) => b.lane_wait_ms - a.lane_wait_ms);

  const topSpans = completed
    .map((span) => ({
      span_id: span.span_id,
      message_id: span.message_id || span.message,
      lane: span.lane,
      lane_kind: span.lane_kind,
      category: span.category,
      job_kind: span.job_kind,
      text: span.text,
      status: span.status,
      scheduled_at: iso(span.scheduled_at_ms),
      started_at: span.started_at_ms ? iso(span.started_at_ms) : null,
      finished_at: iso(span.finished_at_ms),
      lane_wait_ms: span.lane_wait_ms || 0,
      session_lock_wait_ms: span.session_lock_wait_ms || 0,
      handler_ms: span.duration_ms || Math.max(0, span.finished_at_ms - (span.started_at_ms || span.scheduled_at_ms)),
      total_ms: span.finished_at_ms - span.scheduled_at_ms,
      blocked_by_span_id: span.blocked_by_span_id,
      blocked_by_message_id: span.blocked_by_message_id,
    }))
    .sort((a, b) => b.total_ms - a.total_ms);

  return {
    completed,
    lanes: Array.from(byLane.values()).sort((a, b) => b.total_ms - a.total_ms),
    blockers,
    topSpans,
  };
}

function summarizePerf(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!String(entry.event || '').startsWith('perf.')) continue;
    const key = `${entry.event}${entry.operation || entry.target ? `:${entry.operation || entry.target}` : ''}`;
    const row = groups.get(key) || {
      key,
      event: entry.event,
      operation: entry.operation || entry.target || '',
      count: 0,
      durations: [],
      errors: 0,
      timeouts: 0,
    };
    row.count += 1;
    if (Number.isFinite(entry.duration_ms)) row.durations.push(Number(entry.duration_ms));
    if (entry.status === 'error' || entry.phase === 'error') row.errors += 1;
    if (entry.status === 'timeout' || entry.phase === 'timeout') row.timeouts += 1;
    groups.set(key, row);
  }
  return Array.from(groups.values())
    .map((row) => ({
      key: row.key,
      event: row.event,
      operation: row.operation,
      count: row.count,
      avg_ms: row.durations.length ? Math.round(sum(row.durations) / row.durations.length) : 0,
      p90_ms: percentile(row.durations, 0.9),
      max_ms: Math.max(0, ...row.durations),
      total_ms: sum(row.durations),
      errors: row.errors,
      timeouts: row.timeouts,
    }))
    .sort((a, b) => b.total_ms - a.total_ms);
}

function renderSvg(adapterSummary, sourceLog, window) {
  const spans = adapterSummary.completed;
  const lanes = [...new Set(spans.map((span) => span.lane || 'unknown'))].sort(laneSort);
  const minMs = window.start_ms;
  const maxMs = window.end_ms;
  const spanMs = Math.max(1, maxMs - minMs);
  const width = 1440;
  const left = 330;
  const right = 40;
  const top = 96;
  const rowH = 48;
  const laneGap = 10;
  const bottom = 80;
  const height = top + Math.max(1, lanes.length) * (rowH + laneGap) + bottom;
  const x = (ms) => left + ((ms - minMs) / spanMs) * (width - left - right);
  const colors = { chat: '#3b82f6', session: '#16a34a', control: '#dc2626', job: '#9333ea', unknown: '#64748b' };

  let svg = '';
  svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n`;
  svg += '<style>text{font-family:Inter,Arial,sans-serif;fill:#172033}.small{font-size:12px}.label{font-size:13px;font-weight:600}.muted{fill:#64748b}.title{font-size:22px;font-weight:700}.axis{stroke:#cbd5e1;stroke-width:1}.laneBg{fill:#f8fafc}.wait{fill:#f59e0b}.handler{opacity:.9}.outline{stroke:#0f172a;stroke-width:.5;opacity:.25}</style>\n';
  svg += '<rect width="100%" height="100%" fill="#ffffff"/>\n';
  svg += '<text class="title" x="24" y="36">Adapter Lane Flame Graph</text>\n';
  svg += `<text class="small muted" x="24" y="60">${esc(iso(minMs))} -> ${esc(iso(maxMs))} | ${spans.length} completed spans | ${lanes.length} lanes | source: ${esc(sourceLog)}</text>\n`;

  const tickCount = 8;
  for (let i = 0; i <= tickCount; i += 1) {
    const ms = minMs + (spanMs * i / tickCount);
    const tx = x(ms);
    svg += `<line class="axis" x1="${tx.toFixed(1)}" y1="${top - 28}" x2="${tx.toFixed(1)}" y2="${height - bottom + 10}" opacity="${i === 0 || i === tickCount ? 0.65 : 0.28}"/>\n`;
    svg += `<text class="small muted" text-anchor="middle" x="${tx.toFixed(1)}" y="${top - 36}">${esc(new Date(ms).toISOString().slice(11, 19))}</text>\n`;
  }

  lanes.forEach((lane, idx) => {
    const y = top + idx * (rowH + laneGap);
    const laneSpans = spans.filter((span) => span.lane === lane).sort((a, b) => a.scheduled_at_ms - b.scheduled_at_ms);
    svg += `<rect class="laneBg" x="16" y="${y - 6}" width="${width - 32}" height="${rowH + 10}" rx="6"/>\n`;
    svg += `<text class="label" x="24" y="${y + 15}">${esc(short(lane, 44))}</text>\n`;
    svg += `<text class="small muted" x="24" y="${y + 33}">${laneSpans.length} span${laneSpans.length === 1 ? '' : 's'}</text>\n`;

    for (const span of laneSpans) {
      const sy = y + 9;
      const scheduled = span.scheduled_at_ms;
      const started = span.started_at_ms || scheduled;
      const finished = span.finished_at_ms || started;
      const sx = x(scheduled);
      const startX = x(started);
      const fx = x(finished);
      const waitWidth = Math.max(1, startX - sx);
      const runWidth = Math.max(2, fx - startX);
      const fill = colors[span.lane_kind] || colors.unknown;
      if (startX > sx + 1) {
        svg += `<rect class="wait outline" x="${sx.toFixed(1)}" y="${sy}" width="${waitWidth.toFixed(1)}" height="20" rx="3"/>\n`;
      }
      svg += `<rect class="handler outline" x="${startX.toFixed(1)}" y="${sy}" width="${runWidth.toFixed(1)}" height="20" rx="3" fill="${fill}"/>\n`;
      const label = short(`${span.category || ''} ${span.text || span.message_id || ''}`, 34);
      if (runWidth > 70) {
        svg += `<text class="small" x="${(startX + 5).toFixed(1)}" y="${sy + 14}" fill="#ffffff">${esc(label)}</text>\n`;
      }
      if (span.blocked_by_span_id) {
        svg += `<circle cx="${sx.toFixed(1)}" cy="${sy + 10}" r="4" fill="#ef4444"><title>${esc(`blocked by ${span.blocked_by_span_id}`)}</title></circle>\n`;
      }
      svg += `<title>${esc(`span=${span.span_id}\nlane=${span.lane}\nwait=${fmtMs((span.started_at_ms || span.scheduled_at_ms) - span.scheduled_at_ms)} run=${fmtMs((span.finished_at_ms || span.started_at_ms || span.scheduled_at_ms) - (span.started_at_ms || span.scheduled_at_ms))}\nblocked_by=${span.blocked_by_span_id || ''}`)}</title>\n`;
    }
  });

  svg += `<g transform="translate(24 ${height - 42})"><rect x="0" y="-12" width="16" height="10" fill="#f59e0b"/><text class="small muted" x="22" y="-3">lane wait</text><rect x="110" y="-12" width="16" height="10" fill="#3b82f6"/><text class="small muted" x="132" y="-3">chat</text><rect x="194" y="-12" width="16" height="10" fill="#16a34a"/><text class="small muted" x="216" y="-3">session</text><rect x="294" y="-12" width="16" height="10" fill="#dc2626"/><text class="small muted" x="316" y="-3">control</text><rect x="394" y="-12" width="16" height="10" fill="#9333ea"/><text class="small muted" x="416" y="-3">job</text><circle cx="502" cy="-7" r="4" fill="#ef4444"/><text class="small muted" x="514" y="-3">blocked-by link recorded</text></g>\n`;
  svg += '</svg>\n';
  return svg;
}

function writeHtml(outPath, summary, flamegraphSvg) {
  const topOperation = summary.feishu.operationRows[0] || null;
  const slowestRequest = summary.feishu.slowRequests[0] || null;
  const topOverlap = summary.feishu.adapterOverlap[0] || null;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CodeLark Bridge Log Analysis</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #151922;
      --muted: #647084;
      --line: #d8dee8;
      --accent: #0f766e;
      --warn: #b45309;
      --bad: #b91c1c;
      --good: #15803d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      padding: 24px 28px 16px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    h1 { margin: 0 0 6px; font-size: 22px; line-height: 1.2; letter-spacing: 0; }
    h2 { margin: 0 0 12px; font-size: 16px; letter-spacing: 0; }
    main { padding: 20px 28px 36px; max-width: 1480px; margin: 0 auto; }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      margin: 0 0 18px;
      padding: 16px;
      overflow: hidden;
    }
    .muted { color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 16px; }
    .metric { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fbfcfe; }
    .metric .label { color: var(--muted); font-size: 12px; }
    .metric .value { margin-top: 4px; font-size: 20px; font-weight: 700; }
    .metric .detail { margin-top: 4px; color: var(--muted); font-size: 12px; word-break: break-word; }
    .table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; min-width: 780px; }
    th, td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; text-align: left; }
    th { background: #eef2f7; color: #334155; font-size: 12px; position: sticky; top: 0; z-index: 1; }
    .num, td.num, th.num { text-align: right; white-space: nowrap; }
    tr:last-child td { border-bottom: 0; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .scope { max-width: 560px; word-break: break-all; color: var(--muted); }
    .status-timeout, .status-error { color: var(--bad); font-weight: 700; }
    .status-success { color: var(--good); }
    .flamegraph { overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
    .flamegraph svg { display: block; min-width: 1120px; }
    .note { border-left: 4px solid var(--accent); padding: 10px 12px; background: #ecfdf5; margin: 12px 0 0; }
    @media (max-width: 720px) {
      header, main { padding-left: 14px; padding-right: 14px; }
      section { padding: 12px; }
      table { min-width: 680px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>CodeLark Bridge Log Analysis</h1>
    <div class="muted">${htmlEsc(summary.window.start)} -> ${htmlEsc(summary.window.end)} (${htmlEsc(fmtMs(summary.window.duration_ms))})</div>
    <div class="muted">Source: <code>${htmlEsc(summary.source_log)}</code></div>
  </header>
  <main>
    <section>
      <h2>Summary</h2>
      <div class="grid">
        ${metric('Feishu requests', String(summary.feishu.count), `max concurrent ${summary.feishu.concurrency.max_active}, avg ${summary.feishu.concurrency.avg_active.toFixed(2)}`)}
        ${metric('Adapter spans', String(summary.adapter.completed_span_count), `${summary.adapter.pending_span_count} pending, ${summary.adapter.event_count} events`)}
        ${metric('Top Feishu operation', topOperation ? topOperation.key : 'n/a', topOperation ? `${fmtMs(topOperation.total_ms)} total, avg ${fmtMs(topOperation.avg_ms)}` : '')}
        ${metric('Slowest request', slowestRequest ? slowestRequest.operation : 'n/a', slowestRequest ? `${fmtMs(slowestRequest.duration_ms)} ${slowestRequest.status || ''}` : '')}
        ${metric('Top matched overlap', topOverlap ? fmtMs(topOverlap.feishu_overlap_ms) : 'n/a', topOverlap ? `${topOverlap.text || topOverlap.message_id || ''}` : '')}
      </div>
      <div class="note">
        Matched Feishu overlap only counts requests with the same chat/scope/message relationship as the adapter span.
        Global overlap is shown separately so unrelated background API concurrency is visible without being treated as causality.
      </div>
    </section>

    <section>
      <h2>Adapter Lane Flame Graph</h2>
      <div class="flamegraph">${flamegraphSvg}</div>
    </section>

    ${sectionTable('Feishu Operations', ['Operation', 'Count', 'Total', 'Avg', 'P90', 'Max', 'Statuses'], summary.feishu.operationRows.slice(0, 20).map((row) => [
      code(row.key),
      num(row.count),
      num(fmtMs(row.total_ms)),
      num(fmtMs(row.avg_ms)),
      num(fmtMs(row.p90_ms)),
      num(fmtMs(row.max_ms)),
      htmlEsc(JSON.stringify(row.statuses)),
    ]))}

    ${sectionTable('Slow Feishu Requests', ['End time', 'Duration', 'Status', 'Operation', 'Scope'], summary.feishu.slowRequests.slice(0, 24).map((request) => [
      htmlEsc(request.time),
      num(fmtMs(request.duration_ms)),
      status(request.status),
      code(request.operation),
      `<div class="scope">${htmlEsc(short(request.scope || request.chat || request.stream_key, 140))}</div>`,
    ]))}

    ${sectionTable('Adapter Spans With Feishu Overlap', ['Matched Feishu', 'Global Feishu', 'Handler', 'Wait', 'Lane', 'Text', 'Top matched requests'], summary.feishu.adapterOverlap.slice(0, 16).map((span) => [
      num(fmtMs(span.feishu_overlap_ms)),
      num(fmtMs(span.global_feishu_overlap_ms)),
      num(fmtMs(span.handler_ms)),
      num(fmtMs(span.lane_wait_ms)),
      code(short(span.lane, 64)),
      htmlEsc(short(span.text || span.message_id || '', 120)),
      span.feishu_requests.slice(0, 4).map((request) => `<div>${code(request.operation)} ${htmlEsc(fmtMs(request.duration_ms))} overlap ${htmlEsc(fmtMs(request.overlap_ms))}</div>`).join(''),
    ]))}

    ${sectionTable('Adapter Lanes', ['Lane', 'Spans', 'Total', 'Max', 'Wait'], summary.adapter.lanes.slice(0, 16).map((row) => [
      code(row.lane),
      num(row.count),
      num(fmtMs(row.total_ms)),
      num(fmtMs(row.max_ms)),
      num(fmtMs(row.wait_ms)),
    ]))}

    ${sectionTable('Blocking Chains', ['Wait', 'Lane', 'Message', 'Blocked by', 'Category', 'Age'], summary.adapter.blockers.slice(0, 20).map((blocker) => [
      num(fmtMs(blocker.lane_wait_ms)),
      code(short(blocker.lane, 64)),
      htmlEsc(short(blocker.text || blocker.message_id || '', 120)),
      code(blocker.blocked_by_message_id || blocker.blocked_by_span_id || 'previous lane tail'),
      htmlEsc(blocker.blocked_by_category || 'unknown'),
      num(fmtMs(blocker.blocked_by_age_ms)),
    ]))}

    ${sectionTable('Overall Perf Events', ['Event / operation', 'Count', 'Total', 'Avg', 'P90', 'Max', 'Timeouts', 'Errors'], summary.perfHotspots.slice(0, 24).map((row) => [
      code(row.key),
      num(row.count),
      num(fmtMs(row.total_ms)),
      num(fmtMs(row.avg_ms)),
      num(fmtMs(row.p90_ms)),
      num(fmtMs(row.max_ms)),
      num(row.timeouts),
      num(row.errors),
    ]))}
  </main>
  <script type="application/json" id="analysis-data">${htmlEsc(JSON.stringify(summary))}</script>
</body>
</html>
`;
  fs.writeFileSync(outPath, html);
}

function metric(label, value, detail) {
  return `<div class="metric"><div class="label">${htmlEsc(label)}</div><div class="value">${htmlEsc(value)}</div><div class="detail">${htmlEsc(detail || '')}</div></div>`;
}

function sectionTable(title, headers, rows) {
  return `<section>
    <h2>${htmlEsc(title)}</h2>
    <div class="table-wrap">
      <table>
        <thead><tr>${headers.map((header) => `<th>${htmlEsc(header)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td${String(cell).startsWith('<span class="num"') ? ' class="num"' : ''}>${cell}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>
  </section>`;
}

function num(value) {
  return `<span class="num">${htmlEsc(String(value))}</span>`;
}

function code(value) {
  return `<code>${htmlEsc(value)}</code>`;
}

function status(value) {
  const text = String(value || '');
  const className = text === 'timeout' || text === 'error'
    ? 'status-timeout'
    : text === 'success'
      ? 'status-success'
      : '';
  return `<span class="${className}">${htmlEsc(text)}</span>`;
}

function htmlEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

function laneSort(a, b) {
  return laneSortKey(a).localeCompare(laneSortKey(b));
}

function laneSortKey(lane) {
  if (lane.startsWith('control:')) return `0:${lane}`;
  if (lane.startsWith('job:')) return `1:${lane}`;
  if (lane.startsWith('session:')) return `2:${lane}`;
  if (lane.startsWith('chat:')) return `3:${lane}`;
  return `9:${lane}`;
}

function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function short(value, length = 72) {
  const text = String(value || '');
  return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)}s`;
  return `${Math.round(ms)}ms`;
}

function iso(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { entries, parseErrors } = readJsonl(options.logPath, options.sinceMs);
  if (entries.length === 0) {
    throw new Error(`No log entries found in ${options.logPath}`);
  }

  const adapter = buildAdapterSpans(entries);
  const adapterSummary = summarizeAdapterSpans(adapter.spans);
  const feishuRequests = buildFeishuRequests(entries);
  const feishu = summarizeFeishuRequests(feishuRequests, adapterSummary.completed);
  const minMs = Math.min(...entries.map((entry) => entry.__time_ms));
  const maxMs = Math.max(...entries.map((entry) => entry.__time_ms));
  const outDir = path.resolve(options.outDir);
  fs.mkdirSync(outDir, { recursive: true });

  const summary = {
    generated_at: new Date().toISOString(),
    source_log: options.logPath,
    parse_errors: parseErrors,
    window: {
      start: iso(minMs),
      end: iso(maxMs),
      start_ms: minMs,
      end_ms: maxMs,
      duration_ms: maxMs - minMs,
    },
    adapter: {
      event_count: adapter.events.length,
      span_count: adapter.spans.length,
      completed_span_count: adapter.completed.length,
      pending_span_count: adapter.pending.length,
      lanes: adapterSummary.lanes,
      topSpans: adapterSummary.topSpans.slice(0, 30),
      blockers: adapterSummary.blockers.slice(0, 30),
    },
    feishu,
    perfHotspots: summarizePerf(entries).slice(0, 50),
  };

  const htmlPath = path.join(outDir, 'index.html');
  const flamegraphSvg = renderSvg(adapterSummary, options.logPath, summary.window);
  writeHtml(htmlPath, summary, flamegraphSvg);

  console.log(JSON.stringify({
    outDir,
    html: htmlPath,
    adapterCompletedSpans: summary.adapter.completed_span_count,
    feishuRequests: summary.feishu.count,
    topFeishuOperation: summary.feishu.operationRows[0] || null,
    slowestFeishuRequest: summary.feishu.slowRequests[0] || null,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
