/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { createACBHook, createPostToolUseSyncHook } from './acb-hook.js';
import { logError } from './log.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
  /** Resolved path to the group's CLAUDE.md file (set by orchestrator) */
  claudeMdPath?: string;
  /** Group identifier for per-group session isolation */
  groupId?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  /** When true, the agent requested a session rotation */
  rotationRequested?: boolean;
  /** Source of the rotation request */
  rotationSource?: 'agent-self-determined' | 'pre-compact';
}

// ---------- LLM Usage Reporting ----------

interface ModelUsageData {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

function deriveTier(modelName: string): string {
  const lower = modelName.toLowerCase();
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('opus')) return 'opus';
  return 'sonnet'; // default to sonnet
}

function reportModelUsage(
  resultMessage: Record<string, unknown>,
): void {
  const rawUrl = process.env['GOCLAW_MANAGER_URL'];
  const agentName = process.env['GOCLAW_AGENT_NAME'] || process.env['GOCLAW_GROUP_ID'] || 'unknown';
  if (!rawUrl) {
    log('Usage reporting skipped: GOCLAW_MANAGER_URL not set');
    return;
  }

  // GOCLAW_MANAGER_URL may be a ws:// URL (for WebSocket); convert to http:// for REST calls
  const managerUrl = rawUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/ws\/child$/, '');

  // The Claude Agent SDK may use different field names for model usage.
  // Try known field names: modelUsage, model_usage, usage
  const perModel = (resultMessage['modelUsage'] ?? resultMessage['model_usage']) as
    | Record<string, ModelUsageData>
    | undefined;

  // Log available keys on the result message to help diagnose field name issues
  if (!perModel || typeof perModel !== 'object') {
    const keys = Object.keys(resultMessage).filter(k => k !== 'result');
    log(`Usage reporting: no modelUsage/model_usage found on result message. Available keys: [${keys.join(', ')}]`);
    return;
  }

  log(`Usage reporting: found model usage for ${Object.keys(perModel).length} model(s): ${Object.keys(perModel).join(', ')}`);

  for (const [model, usage] of Object.entries(perModel)) {
    if (!usage || typeof usage !== 'object') continue;
    const tier = deriveTier(model);
    const usageAny = usage as unknown as Record<string, unknown>;
    const inputTokens = usage.inputTokens ?? usageAny['input_tokens'] as number ?? 0;
    const outputTokens = usage.outputTokens ?? usageAny['output_tokens'] as number ?? 0;
    const cost = usage.costUSD ?? usageAny['cost_usd'] as number ?? 0;
    const payload = {
      agentName,
      tier,
      model,
      inputTokens,
      outputTokens,
      cost,
    };

    log(`Reporting usage: ${model} (${tier}) — ${inputTokens} in / ${outputTokens} out / ${cost.toFixed(4)}`);

    // Fire-and-forget — never block the agent loop
    const serviceKey = process.env['GOCLAW_SERVICE_KEY'] ?? '';
    fetch(`${managerUrl}/api/metrics/model-usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(serviceKey ? { Authorization: `Bearer ${serviceKey}` } : {}),
      },
      body: JSON.stringify(payload),
    }).then((resp) => {
      if (!resp.ok) {
        log(`Usage report failed: HTTP ${resp.status}`);
      }
    }).catch((err) => {
      log(`Failed to report usage: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}


// ---------- Invocation Reporting ----------

/**
 * Fire-and-forget report of a completed invocation to the Manager's invocation-log endpoint.
 * Called after each runQuery() to populate the admin Invocations tab.
 */
function reportInvocation(
  startMs: number,
  status: 'success' | 'error' | 'timeout',
  prompt: string,
  errorMessage?: string,
): void {
  const rawUrl = process.env['GOCLAW_MANAGER_URL'];
  if (!rawUrl) return;

  const managerUrl = rawUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/ws\/child$/, '');
  const childId = process.env['GOCLAW_CHILD_ID'] ?? process.env['GOCLAW_AGENT_NAME'] ?? 'unknown';
  const serviceKey = process.env['GOCLAW_SERVICE_KEY'] ?? '';
  const durationMs = Date.now() - startMs;

  let trigger: 'message' | 'cron' | 'webhook' | 'manual' = 'message';
  if (prompt.includes('[cron]') || prompt.includes('[scheduler]') || prompt.includes('[SCHEDULED TASK')) trigger = 'cron';
  else if (prompt.includes('[webhook]')) trigger = 'webhook';

  const inputSummary = prompt.length > 200 ? prompt.slice(0, 200) + '...' : prompt;

  fetch(`${managerUrl}/api/agents/${encodeURIComponent(childId)}/invocation-log`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(serviceKey ? { Authorization: `Bearer ${serviceKey}` } : {}),
    },
    body: JSON.stringify({ trigger, durationMs, status, errorMessage, inputSummary, timestamp: new Date().toISOString() }),
  }).then((resp) => {
    if (!resp.ok) log(`Invocation report failed: HTTP ${resp.status}`);
  }).catch((err) => {
    log(`Failed to report invocation: ${err instanceof Error ? err.message : String(err)}`);
  });
}
interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const DEFAULT_IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_POLL_MS = 500;

/** Per-group session state tracked independently within the runner */
interface GroupSessionState {
  sessionId?: string;
  resumeAt?: string;
}

/** Map of groupId -> session state for multi-group isolation */
const groupSessions = new Map<string, GroupSessionState>();

/** Resolve the group workspace directory based on groupId */
function resolveGroupCwd(groupId?: string): string {
  if (groupId) {
    return `/workspace/groups/${groupId}`;
  }
  return '/workspace/group';
}

/** Resolve the IPC input directory (may be overridden by env) */
function resolveIpcInputDir(): string {
  return process.env['WORKSPACE_IPC']
    ? path.join(process.env['WORKSPACE_IPC'], 'input')
    : DEFAULT_IPC_INPUT_DIR;
}

/** Get or create session state for a group */
function getGroupSessionState(groupId: string): GroupSessionState {
  let state = groupSessions.get(groupId);
  if (!state) {
    state = {};
    groupSessions.set(groupId, state);
  }
  return state;
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/** Extract a short content preview from an SDK message for logging. */
function messagePreview(message: { type: string; [key: string]: unknown }): string {
  const MAX = 200;
  if (message.type === 'assistant' && message.message) {
    const betaMsg = message.message as { content?: Array<{ type: string; text?: string; name?: string }> };
    if (Array.isArray(betaMsg.content)) {
      const parts = betaMsg.content.map(block => {
        if (block.type === 'text' && block.text) return block.text.slice(0, MAX);
        if (block.type === 'tool_use' && block.name) return `[tool_use:${block.name}]`;
        if (block.type === 'tool_result') return '[tool_result]';
        return `[${block.type}]`;
      });
      const preview = parts.join(' | ');
      return preview.length > MAX ? preview.slice(0, MAX) + '…' : preview;
    }
  }
  if (message.type === 'user' && message.message) {
    const userMsg = message.message as { content?: string | Array<{ type: string; text?: string }> };
    if (typeof userMsg.content === 'string') {
      return userMsg.content.length > MAX ? userMsg.content.slice(0, MAX) + '…' : userMsg.content;
    }
    if (Array.isArray(userMsg.content)) {
      const parts = userMsg.content.map(block => {
        if (block.type === 'text' && block.text) return block.text.slice(0, MAX);
        if (block.type === 'tool_result') return '[tool_result]';
        return `[${block.type}]`;
      });
      const preview = parts.join(' | ');
      return preview.length > MAX ? preview.slice(0, MAX) + '…' : preview;
    }
  }
  return '';
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    logError({ module: 'index', errorType: 'catch', message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction,
 * and write a _rotate sentinel to signal session rotation.
 */
function createPreCompactHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    // Write _rotate sentinel so the query loop rotates the session.
    // Content 'pre-compact' distinguishes from agent-initiated rotation.
    const ipcInputDir = resolveIpcInputDir();
    try {
      fs.mkdirSync(ipcInputDir, { recursive: true });
      fs.writeFileSync(path.join(ipcInputDir, '_rotate'), 'pre-compact');
      log('PreCompact hook wrote _rotate sentinel (source: pre-compact)');
    } catch (err) {
      logError({ module: 'index', errorType: 'catch', message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
      log(`Failed to write _rotate sentinel: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = path.join(
        resolveGroupCwd(process.env['GOCLAW_GROUP_ID']),
        'conversations',
      );
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      logError({ module: 'index', errorType: 'catch', message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Andy';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(ipcInputDir: string): boolean {
  const sentinel = path.join(ipcInputDir, '_close');
  if (fs.existsSync(sentinel)) {
    try { fs.unlinkSync(sentinel); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Check for _rotate sentinel. Returns the rotation source if found, null otherwise.
 * The _rotate sentinel signals 'end this session, start fresh on next message'
 * without shutting down the container (unlike _close).
 */
function checkRotateSentinel(ipcInputDir: string): 'agent-self-determined' | 'pre-compact' | null {
  const sentinel = path.join(ipcInputDir, '_rotate');
  if (fs.existsSync(sentinel)) {
    let source: 'agent-self-determined' | 'pre-compact' = 'agent-self-determined';
    try {
      const content = fs.readFileSync(sentinel, 'utf-8').trim();
      if (content === 'pre-compact') {
        source = 'pre-compact';
      }
    } catch { /* default to agent-self-determined */ }
    try { fs.unlinkSync(sentinel); } catch { /* ignore */ }
    return source;
  }
  return null;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(ipcInputDir: string): string[] {
  try {
    fs.mkdirSync(ipcInputDir, { recursive: true });
    const files = fs.readdirSync(ipcInputDir)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(ipcInputDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        logError({ module: 'index', errorType: 'catch', message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    logError({ module: 'index', errorType: 'catch', message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message, _close, or _rotate sentinel.
 * Returns the messages as a single string, or null if _close.
 * Note: _rotate is consumed here but the caller must handle rotation logic.
 */
function waitForIpcMessage(ipcInputDir: string): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose(ipcInputDir)) {
        resolve(null);
        return;
      }
      // Also consume _rotate during idle wait — treat as needing a fresh session
      // but still wait for the next message (container stays alive)
      const rotateSrc = checkRotateSentinel(ipcInputDir);
      if (rotateSrc) {
        log(`Rotate sentinel detected while waiting (source: ${rotateSrc})`);
        // Don't resolve null (that means _close / exit). Just log it —
        // rotation during idle is handled by orchestrator-side idle rotation.
      }
      const messages = drainIpcInput(ipcInputDir);
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean; rotationRequested: boolean; rotationSource?: 'agent-self-determined' | 'pre-compact' }> {
  const groupId = containerInput.groupId;
  const groupCwd = resolveGroupCwd(groupId);
  const ipcInputDir = resolveIpcInputDir();

  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages, _close and _rotate sentinels during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  let rotationRequested = false;
  let rotationSource: 'agent-self-determined' | 'pre-compact' | undefined;
  let turnStartMs = Date.now();
  let lastInputText = prompt; // Track latest input for invocation reporting

  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose(ipcInputDir)) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const rotateSrc = checkRotateSentinel(ipcInputDir);
    if (rotateSrc) {
      log(`Rotate sentinel detected during query (source: ${rotateSrc}), ending stream`);
      rotationRequested = true;
      rotationSource = rotateSrc;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput(ipcInputDir);
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      lastInputText = text; // Update for invocation reporting
      turnStartMs = Date.now(); // Reset turn timer for the new message
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let systemPromptAppend: string | undefined;
  if (!containerInput.isMain) {
    const parts: string[] = [];

    // Global CLAUDE.md first (global rules take precedence)
    if (fs.existsSync(globalClaudeMdPath)) {
      parts.push(fs.readFileSync(globalClaudeMdPath, 'utf-8'));
    }

    // Group-specific CLAUDE.md appended after global
    const groupClaudeMdPath = containerInput.claudeMdPath
      ?? path.join(groupCwd, 'CLAUDE.md');
    if (fs.existsSync(groupClaudeMdPath)) {
      const groupContent = fs.readFileSync(groupClaudeMdPath, 'utf-8');
      if (groupContent.trim()) {
        parts.push(groupContent);
      }
    }

    if (parts.length > 0) {
      systemPromptAppend = parts.join('\n\n---\n\n');
    }
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  if (!process.env['GOCLAW_MCP_SERVER_PATH']) {
    log('WARNING: GOCLAW_MCP_SERVER_PATH not set — goclaw MCP tools will be unavailable');
  } else {
    log(`goClaw MCP server path: ${process.env['GOCLAW_MCP_SERVER_PATH']}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: groupCwd,
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: systemPromptAppend
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: systemPromptAppend }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        'mcp__goclaw__*'
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: groupId ?? containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: groupId ?? containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
        // goClaw platform tools (knowledge, research, CRM, send_email, send_telegram, etc.)
        // Note: env merges with process.env in Claude Agent SDK, so we only need goclaw-specific vars
        // goClaw platform tools (knowledge, research, CRM, send_email, send_telegram, etc.)
        ...(process.env['GOCLAW_MCP_SERVER_PATH'] ? {
          goclaw: {
            command: '/bin/sh',
            args: ['-c', `cd /app/goclaw && exec node "${process.env['GOCLAW_MCP_SERVER_PATH']}"`],
            env: {
              // Spread sdkEnv (process.env + stdin secrets) so MCP server has everything:
              // PATH, module resolution, OPENAI_API_KEY, RESEND_API_KEY, etc.
              ...sdkEnv,
              // Ensure Node.js finds workspace packages from /app/goclaw/node_modules
              NODE_PATH: '/app/goclaw/node_modules',
              GOCLAW_DATA_DIR: process.env['GOCLAW_DATA_DIR'] ?? path.join(groupCwd, 'data'),
              GOCLAW_KNOWLEDGE_DIR: process.env['GOCLAW_KNOWLEDGE_DIR'] ?? path.join(groupCwd, 'knowledge'),
              GOCLAW_GROUP_ID: groupId ?? process.env['GOCLAW_GROUP_ID'] ?? 'default',
              GOCLAW_SENDER_ROLE: process.env['GOCLAW_SENDER_ROLE'] ?? 'owner',
              // Pass group-specific CLAUDE.md path so self-learn writes to the correct file
              GOCLAW_CLAUDE_MD_PATH: containerInput.claudeMdPath ?? '',
              // Pass API keys under goclaw-prefixed names in case the SDK strips the originals
              GOCLAW_ANTHROPIC_API_KEY: sdkEnv['ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'] ?? '',
              GOCLAW_OPENAI_API_KEY: sdkEnv['OPENAI_API_KEY'] ?? process.env['OPENAI_API_KEY'] ?? '',
              // Service key for HTTP fallback auth (e.g. blocker reporting to manager API)
              ...(process.env['GOCLAW_SERVICE_KEY'] ? { GOCLAW_SERVICE_KEY: process.env['GOCLAW_SERVICE_KEY'] } : {}),
              // PostBridge social media API key (optional)
              ...(process.env['POST_BRIDGE_API_KEY'] ? { POST_BRIDGE_API_KEY: process.env['POST_BRIDGE_API_KEY'] } : {}),
            },
          },
        } : {}),
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook()] }],
        PreToolUse: [
          // Bash-specific: strip secrets from subprocess environment
          { matcher: 'Bash', hooks: [createSanitizeBashHook()] },
        ],
        PostToolUse: [
          // S3 state sync: flush changed files after mutating tool calls (Write, Edit, Bash)
          { matcher: 'Write|Edit|Bash', hooks: [createPostToolUseSyncHook()] },
        ],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    const preview = messagePreview(message as { type: string; [key: string]: unknown });
    log(`[msg #${messageCount}] type=${msgType}${preview ? ` | ${preview}` : ''}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);

      // Report LLM usage to manager metrics (fire-and-forget)
      reportModelUsage(message as unknown as Record<string, unknown>);

      // Report invocation to manager for the Invocations tab
      reportInvocation(turnStartMs, 'success', lastInputText);
      turnStartMs = Date.now(); // Reset for next turn

      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId
      });
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}, rotationRequested: ${rotationRequested}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery, rotationRequested, rotationSource };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    const groupId = containerInput.groupId;
    log(`Received input for group: ${groupId ?? containerInput.groupFolder} (groupId: ${groupId ?? 'none'})`);
  } catch (err) {
    logError({ module: 'index', errorType: 'catch', message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  const ipcInputDir = resolveIpcInputDir();
  fs.mkdirSync(ipcInputDir, { recursive: true });

  // Ensure the group workspace directory exists with standard subdirectories
  const groupCwd = resolveGroupCwd(containerInput.groupId);
  fs.mkdirSync(groupCwd, { recursive: true });
  for (const subdir of ['inbox', 'knowledge', 'conversations', 'skills']) {
    fs.mkdirSync(path.join(groupCwd, subdir), { recursive: true });
  }
  // Ensure global shared state directory exists
  fs.mkdirSync('/workspace/global', { recursive: true });

  // Set GOCLAW_GROUP_ID in process env so the pre-compact hook can resolve the correct path
  if (containerInput.groupId) {
    process.env['GOCLAW_GROUP_ID'] = containerInput.groupId;
  }

  // Initialize per-group session state from the input.
  // When groupId is present, session state is tracked per-group so that
  // switching between groups resumes the correct session.
  const effectiveGroupId = containerInput.groupId ?? '__default__';
  const groupState = getGroupSessionState(effectiveGroupId);

  // Seed session state: prefer per-group tracked state, fall back to input
  let sessionId = groupState.sessionId ?? containerInput.sessionId;
  let resumeAt = groupState.resumeAt;

  // Clean up stale _close sentinel from previous container runs
  const closeSentinel = path.join(ipcInputDir, '_close');
  try { fs.unlinkSync(closeSentinel); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput(ipcInputDir);
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  try {
    while (true) {
      log(`Starting query (group: ${effectiveGroupId}, session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);
      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
        // Persist session state for this group
        groupState.sessionId = sessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
        groupState.resumeAt = resumeAt;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // If _rotate was consumed during the query, emit rotation signal and clear session.
      // The container stays alive but the next query starts a fresh session.
      if (queryResult.rotationRequested) {
        log(`Rotation requested (source: ${queryResult.rotationSource}), clearing session for fresh start`);
        writeOutput({
          status: 'success',
          result: null,
          newSessionId: sessionId,
          rotationRequested: true,
          rotationSource: queryResult.rotationSource,
        });
        // Clear local session state so next query starts fresh
        sessionId = undefined;
        resumeAt = undefined;
        groupState.sessionId = undefined;
        groupState.resumeAt = undefined;

        log('Session cleared, waiting for next IPC message...');
        const nextAfterRotate = await waitForIpcMessage(ipcInputDir);
        if (nextAfterRotate === null) {
          log('Close sentinel received after rotation, exiting');
          break;
        }
        log(`Got new message after rotation (${nextAfterRotate.length} chars), starting fresh query`);
        prompt = nextAfterRotate;
        continue;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage(ipcInputDir);
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    logError({ module: 'index', errorType: 'catch', message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
