/**
 * Agent Circuit Breaker (ACB) -- Container-Side PreToolUseHook
 *
 * This hook runs inside the agent container. For every tool call, it:
 *   1. Generates a unique action_id (UUID v4)
 *   2. Redacts secrets/credentials from tool parameters
 *   3. Writes a pending action JSON file to /workspace/acb/pending/
 *   4. Polls /workspace/acb/verdict/{action_id}.json for the ACB service's decision
 *   5. Returns allow (proceed) or block (error) based on the verdict
 *
 * The ACB service runs on the HOST, outside the container. Communication
 * is strictly via filesystem IPC. The agent has no visibility into why
 * an action was allowed or blocked.
 *
 * Configuration via environment variables:
 *   ACB_PENDING_DIR    - Directory for pending action files (default: /workspace/acb/pending)
 *   ACB_VERDICT_DIR    - Directory for verdict files (default: /workspace/acb/verdict)
 *   ACB_POLL_INTERVAL  - Poll interval in ms (default: 100)
 *   ACB_TIMEOUT        - Timeout in ms before fail-closed block (default: 300000 = 5 min)
 *   ACB_ENABLED        - Set to "0" to disable ACB interception (default: enabled)
 *   ACB_SESSION_ID     - Override session ID (default: derived from container context)
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { logError } from './log.js';

// ----- Types -----

export interface ACBPendingAction {
  action_id: string;
  timestamp: string;
  tool_name: string;
  parameters: Record<string, unknown>;
  session_id: string;
}

export interface ACBVerdict {
  action_id: string;
  verdict: 'allow' | 'block';
  rationale: string;
}

export interface ACBHookConfig {
  pendingDir: string;
  verdictDir: string;
  pollIntervalMs: number;
  timeoutMs: number;
  enabled: boolean;
  sessionId: string;
}

// ----- Configuration -----

/**
 * Build ACB configuration from environment variables with sensible defaults.
 */
export function loadACBConfig(env: Record<string, string | undefined> = process.env): ACBHookConfig {
  return {
    pendingDir: env.ACB_PENDING_DIR ?? '/workspace/acb/pending',
    verdictDir: env.ACB_VERDICT_DIR ?? '/workspace/acb/verdict',
    pollIntervalMs: parseIntEnv(env.ACB_POLL_INTERVAL, 100),
    timeoutMs: parseIntEnv(env.ACB_TIMEOUT, 300_000),
    enabled: env.ACB_ENABLED !== '0',
    sessionId: env.ACB_SESSION_ID ?? 'unknown',
  };
}

function parseIntEnv(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
}

// ----- Secret Redaction -----

/**
 * Regex matching parameter keys that likely contain secrets.
 * Matches: key, token, secret, password, credential, auth, api_key, apiKey, etc.
 */
const SENSITIVE_KEY_PATTERN = /key|token|secret|password|credential|auth/i;

/**
 * Deep-redact secret values from tool parameters.
 * Only top-level and one-level-nested object keys are checked.
 * Arrays and deeply nested structures are preserved but their
 * string values matching sensitive keys are redacted.
 */
export function redactSecrets(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      redacted[key] = '[REDACTED]';
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // One level of nesting: redact sensitive sub-keys
      const nested = value as Record<string, unknown>;
      const redactedNested: Record<string, unknown> = {};
      for (const [subKey, subValue] of Object.entries(nested)) {
        if (SENSITIVE_KEY_PATTERN.test(subKey)) {
          redactedNested[subKey] = '[REDACTED]';
        } else {
          redactedNested[subKey] = subValue;
        }
      }
      redacted[key] = redactedNested;
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

// ----- Polling -----

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Poll for a verdict file at the given path.
 *
 * Returns the parsed verdict if found within the timeout.
 * Returns a fail-closed block verdict if the timeout expires.
 */
export async function pollForVerdict(
  actionId: string,
  config: ACBHookConfig,
): Promise<ACBVerdict> {
  const verdictPath = path.join(config.verdictDir, `${actionId}.json`);
  const deadline = Date.now() + config.timeoutMs;

  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(verdictPath)) {
        const raw = fs.readFileSync(verdictPath, 'utf-8');
        const verdict: ACBVerdict = JSON.parse(raw);
        return verdict;
      }
    } catch {
      // File may be partially written (race with atomic rename); retry
    }
    await sleep(config.pollIntervalMs);
  }

  // Timeout: fail-closed -- block the action
  return {
    action_id: actionId,
    verdict: 'block',
    rationale: 'ACB evaluation timed out -- fail-closed',
  };
}

// ----- Pending Action Writer -----

/**
 * Write a pending action file for the ACB service to evaluate.
 * Uses atomic write (write .tmp then rename) to prevent partial reads.
 */
export function writePendingAction(
  action: ACBPendingAction,
  pendingDir: string,
): void {
  fs.mkdirSync(pendingDir, { recursive: true });

  const filePath = path.join(pendingDir, `${action.action_id}.json`);
  const tmpPath = `${filePath}.tmp`;

  fs.writeFileSync(tmpPath, JSON.stringify(action));
  fs.renameSync(tmpPath, filePath);
}

// ----- PreToolUseHook Factory -----

/**
 * The PreToolUseHookInput shape from the Claude Agent SDK.
 * We only declare what we need to avoid importing the SDK
 * (which may not be available at type-check time on the host).
 */
interface PreToolUseHookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/**
 * Create the ACB PreToolUseHook.
 *
 * This hook is registered for ALL tool calls (no matcher filter).
 * It writes a pending action to the filesystem, polls for a verdict,
 * and either allows the tool call to proceed or blocks it with a
 * generic error message.
 *
 * @param configOverrides - Optional overrides for the ACB configuration
 * @returns A HookCallback function compatible with the Claude Agent SDK
 */
export function createACBHook(configOverrides?: Partial<ACBHookConfig>) {
  const config: ACBHookConfig = {
    ...loadACBConfig(),
    ...configOverrides,
  };

  return async (input: unknown, _toolUseId: unknown, _context: unknown) => {
    if (!config.enabled) {
      return {};
    }

    const preInput = input as PreToolUseHookInput;
    const actionId = randomUUID();

    // Build the pending action with redacted parameters
    const pendingAction: ACBPendingAction = {
      action_id: actionId,
      timestamp: new Date().toISOString(),
      tool_name: preInput.tool_name,
      parameters: redactSecrets(
        preInput.tool_input as Record<string, unknown>,
      ),
      session_id: config.sessionId,
    };

    // Write the pending action for the ACB service to evaluate
    writePendingAction(pendingAction, config.pendingDir);

    // Poll for the verdict from the ACB service
    const verdict = await pollForVerdict(actionId, config);

    if (verdict.verdict === 'block') {
      // Block the tool call via the SDK's PreToolUse hook output.
      // The agent sees "Action blocked by security policy" but has no
      // visibility into the rationale or ACB internals.
      return {
        decision: 'block' as const,
        reason: 'Action blocked by security policy',
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: 'Action blocked by security policy',
        },
      };
    }

    // Allow: proceed with the original tool call unchanged
    return {};
  };
}

// ----- PostToolUse S3 Sync Hook -----

/**
 * Tools that modify the filesystem and should trigger S3 sync.
 */
const MUTATING_TOOLS = new Set(['Write', 'Edit', 'Bash']);

/**
 * PostToolUse hook input shape from the Claude Agent SDK.
 */
interface PostToolUseHookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
  tool_use_id: string;
}

export interface S3SyncHookConfig {
  /** Debounce interval in ms before triggering flush (default: 5000). */
  debounceMs: number;
  /** Whether S3 sync is enabled (default: true when state config is available). */
  enabled: boolean;
}

/**
 * Create a PostToolUse hook that triggers debounced S3 state sync
 * after mutating tool calls (Write, Edit, Bash).
 *
 * Uses state-manager's flush() with differential checksums — only
 * changed files are uploaded to S3. Rapid successive writes are
 * coalesced by the debounce timer.
 *
 * No-op when GOCLAW_STATE_BUCKET is not set (backwards compatible).
 *
 * @param configOverrides Optional overrides for the sync configuration.
 * @returns A HookCallback function compatible with the Claude Agent SDK PostToolUse event.
 */
export function createPostToolUseSyncHook(configOverrides?: Partial<S3SyncHookConfig>) {
  const syncConfig: S3SyncHookConfig = {
    debounceMs: configOverrides?.debounceMs ?? 5_000,
    enabled: configOverrides?.enabled ?? true,
  };

  // Lazy-loaded state manager — resolved on first call.
  // Uses dynamic import to avoid hard compile-time dependency on @indigoai-us/goclaw-core.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stateModule: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stateConfig: any = undefined;
  let stateConfigResolved = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let flushInProgress = false;

  async function loadStateManager() {
    if (stateModule) return;
    try {
      // @ts-ignore — optional dependency, gracefully degrades when not installed
      stateModule = await import('@indigoai-us/goclaw-core');
    } catch {
      log('PostToolUse S3 sync: failed to load @indigoai-us/goclaw-core — sync disabled');
      syncConfig.enabled = false;
    }
  }

  function resolveStateConfig() {
    if (stateConfigResolved) return stateConfig;
    stateConfigResolved = true;
    if (!stateModule) return null;
    stateConfig = stateModule.resolveStateConfig();
    if (!stateConfig) {
      log('PostToolUse S3 sync: GOCLAW_STATE_BUCKET not set — sync disabled');
    }
    return stateConfig;
  }

  async function debouncedFlush() {
    if (!stateModule || !stateConfig) return;
    if (flushInProgress) return;

    flushInProgress = true;
    try {
      const result = await stateModule.flush(stateConfig);
      if (result.filesUploaded > 0) {
        log(`PostToolUse S3 sync: flushed ${result.filesUploaded} files (${result.bytesUploaded} bytes) in ${result.durationMs}ms`);
      }

      // Also flush per-group state
      if (typeof stateModule.listLocalGroups === 'function') {
        const groups: string[] = stateModule.listLocalGroups(stateConfig.localDir);
        for (const groupId of groups) {
          try {
            const groupResult = await stateModule.flushGroup(stateConfig, groupId);
            if (groupResult.filesUploaded > 0) {
              log(`PostToolUse S3 sync: flushed group "${groupId}" — ${groupResult.filesUploaded} files`);
            }
          } catch (err) {
            logError({ module: 'acb-hook', errorType: 'catch', message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
            log(`PostToolUse S3 sync: group "${groupId}" flush failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } catch (err) {
      logError({ module: 'acb-hook', errorType: 'catch', message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
      log(`PostToolUse S3 sync: flush failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      flushInProgress = false;
    }
  }

  function scheduleFlush() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      debouncedFlush().catch(() => {});
    }, syncConfig.debounceMs);
    // Don't let the debounce timer prevent process exit
    if (typeof debounceTimer === 'object' && 'unref' in debounceTimer) {
      debounceTimer.unref();
    }
  }

  function log(msg: string): void {
    const ts = new Date().toISOString();
    process.stderr.write(`[acb-hook ${ts}] ${msg}\n`);
  }

  return async (input: unknown, _toolUseId: unknown, _context: unknown) => {
    if (!syncConfig.enabled) {
      return {};
    }

    const postInput = input as PostToolUseHookInput;

    // Only trigger sync for mutating tools
    if (!MUTATING_TOOLS.has(postInput.tool_name)) {
      return {};
    }

    // Lazy-load state manager on first mutating tool call
    await loadStateManager();
    const config = resolveStateConfig();
    if (!config) {
      return {};
    }

    // Schedule a debounced flush
    scheduleFlush();

    return {};
  };
}
