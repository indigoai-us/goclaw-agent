#!/usr/bin/env node

/**
 * goClaw Agent Server
 * Minimal HTTP server wrapping the goclaw agent-runner.
 *
 * Endpoints:
 *   GET  /health             — Health check
 *   POST /api/message        — Send a message to the agent
 *   POST /api/personality    — Write agent CLAUDE.md
 *   POST /api/knowledge      — Write knowledge entries
 *
 * Override this server for platform-specific functionality by setting
 * GOCLAW_SERVER_CMD in your entrypoint.
 */

import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(
  process.env['GOCLAW_AGENT_PORT'] ?? process.env['GOCLAW_HEALTH_PORT'] ?? '3000',
  10,
);
const AGENT_NAME =
  process.env['GOCLAW_AGENT_NAME'] ?? 'goclaw-agent';
const WORKSPACE_GROUP =
  process.env['WORKSPACE_GROUP'] ?? '/workspace/group';
const WORKSPACE_GLOBAL =
  process.env['WORKSPACE_GLOBAL'] ?? '/workspace/global';
const IPC_INPUT_DIR = join(WORKSPACE_GROUP, '..', 'ipc', 'input');
const CLAUDE_MD_PATH = join(WORKSPACE_GROUP, 'CLAUDE.md');
const KNOWLEDGE_DIR = join(WORKSPACE_GROUP, 'knowledge');

const startedAt = Date.now();
let agentProcess: ChildProcess | null = null;

function log(msg: string): void {
  console.log(`[nanoclaw-server] ${new Date().toISOString()} ${msg}`);
}

function writeIpcMessage(text: string): void {
  mkdirSync(IPC_INPUT_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  writeFileSync(
    join(IPC_INPUT_DIR, filename),
    JSON.stringify({ type: 'message', text }),
  );
}

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function startAgentRunner(): Promise<void> {
  const hasIdentity =
    existsSync(CLAUDE_MD_PATH) &&
    readFileSync(CLAUDE_MD_PATH, 'utf-8').trim().length > 50;
  const hasKnowledge =
    existsSync(KNOWLEDGE_DIR) && readdirSync(KNOWLEDGE_DIR).length > 0;

  let startupPrompt: string;
  if (!hasIdentity) {
    startupPrompt =
      'You are now online. Your identity is not yet configured. When contacted, ask your owner what product/business you represent, who your audience is, and what your goals are. Save their answers to your CLAUDE.md immediately.';
  } else if (!hasKnowledge) {
    startupPrompt =
      'You are now online. Your identity is loaded but your knowledge base is empty. Wait for messages and build knowledge over time.';
  } else {
    startupPrompt =
      'You are now online. Your identity and knowledge base are loaded. Monitor for incoming messages and respond to users.';
  }

  const containerInput = {
    prompt: startupPrompt,
    groupFolder: 'default',
    chatJid: 'api',
    isMain: false,
    isScheduledTask: false,
    secrets: {
      ...(process.env['ANTHROPIC_API_KEY']
        ? { ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'] }
        : {}),
    },
  };

  const agentRunnerPath = resolve(__dirname, 'index.js');
  log(`Starting agent-runner from ${agentRunnerPath}`);

  const child = spawn('node', [agentRunnerPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WORKSPACE_GROUP,
      WORKSPACE_GLOBAL,
      WORKSPACE_IPC: join(WORKSPACE_GROUP, '..', 'ipc'),
      GOCLAW_GROUP_ID: AGENT_NAME,
    },
    cwd: WORKSPACE_GROUP,
  });

  agentProcess = child;
  child.stdin!.write(JSON.stringify(containerInput));
  child.stdin!.end();

  // Buffer for parsing agent-runner output markers
  let stdoutBuffer = '';
  const OUTPUT_START = '---NANOCLAW_OUTPUT_START---';
  const OUTPUT_END = '---NANOCLAW_OUTPUT_END---';

  child.stdout!.on('data', (data: Buffer) => {
    const text = data.toString();
    if (text.trim()) log(`[agent:stdout] ${text.trim().slice(0, 500)}`);

    stdoutBuffer += text;
    let startIdx: number;
    while ((startIdx = stdoutBuffer.indexOf(OUTPUT_START)) !== -1) {
      const endIdx = stdoutBuffer.indexOf(OUTPUT_END, startIdx);
      if (endIdx === -1) break;
      stdoutBuffer = stdoutBuffer.slice(endIdx + OUTPUT_END.length);
    }

    if (stdoutBuffer.length > 50_000 && !stdoutBuffer.includes(OUTPUT_START)) {
      stdoutBuffer = stdoutBuffer.slice(-1000);
    }
  });

  child.stderr!.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    if (text) console.error(`[agent:stderr] ${text.slice(0, 500)}`);
  });

  child.on('close', (code) => {
    log(`Agent-runner exited with code ${code}`);
    agentProcess = null;
  });

  child.on('error', (err) => {
    log(`Agent-runner spawn error: ${err.message}`);
    agentProcess = null;
  });

  log('Agent-runner started');
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  data: Record<string, unknown>,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  try {
    // GET /health
    if (method === 'GET' && url === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        agent: AGENT_NAME,
        uptime: Date.now() - startedAt,
      });
      return;
    }

    // POST /api/message — inject a message into the agent
    if (method === 'POST' && url === '/api/message') {
      const body = await parseBody(req);
      if (!body.text) {
        sendJson(res, 400, { error: 'Missing "text"' });
        return;
      }
      const text = String(body.text);
      const sender = body.sender ? String(body.sender) : undefined;
      const channel = body.channel ? String(body.channel) : 'api';
      const formatted = sender ? `[${channel}] ${sender}: ${text}` : text;
      writeIpcMessage(formatted);
      log(`Message injected: ${formatted.slice(0, 200)}`);
      sendJson(res, 200, { ok: true });
      return;
    }

    // POST /api/personality — write CLAUDE.md
    if (method === 'POST' && url === '/api/personality') {
      const body = await parseBody(req);
      if (!body.claudeMd) {
        sendJson(res, 400, { error: 'Missing "claudeMd"' });
        return;
      }
      const content = String(body.claudeMd);
      mkdirSync(dirname(CLAUDE_MD_PATH), { recursive: true });
      writeFileSync(CLAUDE_MD_PATH, content, 'utf-8');
      log(`Wrote CLAUDE.md (${content.length} bytes)`);
      sendJson(res, 200, { ok: true, bytes: content.length });
      return;
    }

    // POST /api/knowledge — write knowledge entries
    if (method === 'POST' && url === '/api/knowledge') {
      const body = await parseBody(req);
      const entries = body.entries as
        | Array<{ category?: string; slug?: string; content?: string }>
        | undefined;
      if (!entries || !Array.isArray(entries)) {
        sendJson(res, 400, { error: 'Missing "entries" array' });
        return;
      }
      let written = 0;
      for (const entry of entries) {
        if (!entry.slug || !entry.content) continue;
        const dir = entry.category
          ? join(KNOWLEDGE_DIR, entry.category)
          : KNOWLEDGE_DIR;
        mkdirSync(dir, { recursive: true });
        const safeName = entry.slug.replace(/[^a-z0-9_-]/gi, '-');
        const filename = safeName.endsWith('.md')
          ? safeName
          : `${safeName}.md`;
        writeFileSync(join(dir, filename), entry.content, 'utf-8');
        written++;
      }
      sendJson(res, 200, { ok: true, written, total: entries.length });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function main(): Promise<void> {
  // Ensure workspace directories
  for (const dir of [WORKSPACE_GROUP, WORKSPACE_GLOBAL, IPC_INPUT_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const subdir of ['knowledge', 'skills', 'conversations', 'memory']) {
    mkdirSync(join(WORKSPACE_GROUP, subdir), { recursive: true });
  }

  // Copy platform prompt if available and not already present
  const platformPromptPaths = [
    resolve(__dirname, '..', 'config', 'platform-prompt.md'),
    '/app/config/platform-prompt.md',
  ];
  const platformPromptDest = join(WORKSPACE_GLOBAL, 'CLAUDE.md');
  if (!existsSync(platformPromptDest)) {
    for (const src of platformPromptPaths) {
      if (existsSync(src)) {
        mkdirSync(dirname(platformPromptDest), { recursive: true });
        writeFileSync(platformPromptDest, readFileSync(src, 'utf-8'));
        log('Copied platform prompt to workspace');
        break;
      }
    }
  }

  // Start agent runner
  await startAgentRunner();

  // Start HTTP server
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
  server.listen(PORT, '0.0.0.0', () => {
    log(`Server listening on port ${PORT}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    log('Shutting down...');
    if (agentProcess) agentProcess.kill('SIGTERM');
    server.close();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[nanoclaw-server] Fatal:', err);
  process.exit(1);
});
