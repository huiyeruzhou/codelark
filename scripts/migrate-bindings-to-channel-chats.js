#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function usage() {
  return [
    'Usage: node scripts/migrate-bindings-to-channel-chats.js [--codelark-home <path>] [--clk-home <path>] [--dry-run]',
    '',
    'Migrates data/bindings.json to data/channel-chats.json.',
    'For each channel/chat pair, keeps the newest active legacy record where active=true and drops inactive records.',
    'Moves binding workingDirectory/model/mode/chatDisplayName into the linked session when session fields are empty.',
  ].join('\n');
}

function parseArgs(argv) {
  const out = {
    codelarkHome: process.env.CODELARK_HOME || path.join(os.homedir(), '.codelark'),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg === '--codelark-home' || arg === '--clk-home') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a path`);
      out.codelarkHome = value;
    } else if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function readJsonObject(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return parsed;
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readString(record, key) {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
}

function readBoolean(record, key) {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeChatKind(value) {
  if (value === 'p2p' || value === 'group') return value;
  return undefined;
}

function updatedTime(record) {
  const parsed = Date.parse(readString(record, 'updatedAt') || readString(record, 'createdAt'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeMode(value) {
  return value === 'yolo' ? 'yolo' : 'normal';
}

function ensureRecord(parent, key) {
  if (!parent[key] || typeof parent[key] !== 'object' || Array.isArray(parent[key])) {
    parent[key] = {};
  }
  return parent[key];
}

function chooseActiveBinding(records) {
  return records
    .filter((record) => readBoolean(record, 'active') === true)
    .sort((a, b) => updatedTime(b) - updatedTime(a))[0];
}

function toChannelChat(binding) {
  return {
    id: readString(binding, 'id'),
    channelType: readString(binding, 'channelType'),
    ...(readString(binding, 'channelProvider') ? { channelProvider: readString(binding, 'channelProvider') } : {}),
    ...(readString(binding, 'channelAlias') ? { channelAlias: readString(binding, 'channelAlias') } : {}),
    chatId: readString(binding, 'chatId'),
    ...(normalizeChatKind(binding.chatKind) ? { chatKind: normalizeChatKind(binding.chatKind) } : {}),
    ...(readString(binding, 'chatUserId') ? { chatUserId: readString(binding, 'chatUserId') } : {}),
    bridgeSessionId: readString(binding, 'bridgeSessionId'),
    createdAt: readString(binding, 'createdAt') || new Date().toISOString(),
    updatedAt: readString(binding, 'updatedAt') || new Date().toISOString(),
  };
}

function migrateSessionFromBinding(session, binding) {
  let changed = false;
  const workingDirectory = readString(binding, 'workingDirectory');
  const model = readString(binding, 'model');
  const chatDisplayName = readString(binding, 'chatDisplayName');
  const mode = normalizeMode(binding?.mode);
  const runtime = ensureRecord(session, 'runtime');
  const codex = ensureRecord(runtime, 'codex');
  const existingModel = readString(session, 'model');
  const existingMode = readString(session, 'preferred_mode');

  if (existingModel && !readString(codex, 'model')) {
    codex.model = existingModel;
    changed = true;
  }
  if (existingMode && !readString(codex, 'mode')) {
    codex.mode = normalizeMode(existingMode);
    changed = true;
  }
  if ('model' in session) {
    delete session.model;
    changed = true;
  }
  if ('preferred_mode' in session) {
    delete session.preferred_mode;
    changed = true;
  }

  if (workingDirectory && !readString(session, 'working_directory')) {
    session.working_directory = workingDirectory;
    changed = true;
  }
  if (model && !readString(codex, 'model')) {
    codex.model = model;
    changed = true;
  }
  if (mode && !readString(codex, 'mode')) {
    codex.mode = mode;
    changed = true;
  }
  if (chatDisplayName && !readString(session, 'name')) {
    session.name = chatDisplayName;
    changed = true;
  }
  if (changed) {
    session.updated_at = readString(session, 'updated_at') || new Date().toISOString();
  }
  return changed;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dataDir = path.join(options.codelarkHome, 'data');
  const bindingsPath = path.join(dataDir, 'bindings.json');
  const channelChatsPath = path.join(dataDir, 'channel-chats.json');
  const sessionsPath = path.join(dataDir, 'sessions.json');

  const bindings = readJsonObject(bindingsPath);
  const sessions = readJsonObject(sessionsPath);
  const byChat = new Map();
  for (const [key, binding] of Object.entries(bindings)) {
    if (!binding || typeof binding !== 'object') continue;
    const id = readString(binding, 'id') || key;
    const normalized = { ...binding, id };
    const channelType = readString(normalized, 'channelType');
    const chatId = readString(normalized, 'chatId');
    const bridgeSessionId = readString(normalized, 'bridgeSessionId');
    if (!channelType || !chatId || !bridgeSessionId) continue;
    const chatKey = `${channelType}:${chatId}`;
    byChat.set(chatKey, [...(byChat.get(chatKey) || []), normalized]);
  }

  const channelChats = {};
  let sessionsChanged = 0;
  let droppedBindings = 0;
  let skippedInactiveBindings = 0;
  for (const records of byChat.values()) {
    const kept = chooseActiveBinding(records);
    if (!kept) {
      skippedInactiveBindings += records.length;
      droppedBindings += records.length;
      continue;
    }
    const inactiveCount = records.filter((record) => readBoolean(record, 'active') !== true).length;
    skippedInactiveBindings += inactiveCount;
    droppedBindings += records.length - 1;
    const chat = toChannelChat(kept);
    channelChats[chat.id] = chat;
    const session = sessions[chat.bridgeSessionId];
    if (session && typeof session === 'object' && migrateSessionFromBinding(session, kept)) {
      sessionsChanged += 1;
    }
  }

  const summary = {
    codelarkHome: options.codelarkHome,
    inputBindings: Object.keys(bindings).length,
    outputChannelChats: Object.keys(channelChats).length,
    droppedBindings,
    skippedInactiveBindings,
    sessionsChanged,
    dryRun: options.dryRun,
  };

  if (!options.dryRun) {
    atomicWriteJson(channelChatsPath, channelChats);
    atomicWriteJson(sessionsPath, sessions);
    fs.rmSync(bindingsPath, { force: true });
  }

  console.log(JSON.stringify(summary, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('');
  console.error(usage());
  process.exit(1);
}
