#!/usr/bin/env node
/**
 * PostToolUse hook for S3 state sync (Claude Code CLI path).
 *
 * Triggers state-manager flush() after Write, Edit, or Bash tool calls.
 * This covers the Claude Code CLI deployment path. The Agent SDK path
 * is handled by the programmatic hook in acb-hook.ts (createPostToolUseSyncHook).
 *
 * Claude Code passes hook input as JSON on stdin. This script:
 *   1. Reads stdin (not used, but required by hook protocol)
 *   2. Dynamically imports @indigoai-us/goclaw-core
 *   3. Calls resolveStateConfig() to check S3 config
 *   4. Calls flush() + flushGroup() for all local groups
 *   5. Exits cleanly (non-zero exit does NOT block the tool call)
 *
 * No-op when GOCLAW_STATE_BUCKET is not set.
 */

// Consume stdin (Claude Code hook protocol requires it)
let stdinData = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { stdinData += chunk; });
process.stdin.on('end', async () => {
  try {
    const core = await import('@indigoai-us/goclaw-core');
    const config = core.resolveStateConfig();
    if (!config) {
      // No S3 config — nothing to sync
      process.exit(0);
    }

    // Flush main agent state
    const result = await core.flush(config);
    if (result.filesUploaded > 0) {
      process.stderr.write(
        `[s3-sync-hook] Flushed ${result.filesUploaded} files (${result.bytesUploaded} bytes)\n`
      );
    }

    // Flush per-group state
    if (typeof core.listLocalGroups === 'function') {
      const groups = core.listLocalGroups(config.localDir);
      for (const groupId of groups) {
        try {
          const groupResult = await core.flushGroup(config, groupId);
          if (groupResult.filesUploaded > 0) {
            process.stderr.write(
              `[s3-sync-hook] Flushed group "${groupId}" — ${groupResult.filesUploaded} files\n`
            );
          }
        } catch (err) {
          process.stderr.write(
            `[s3-sync-hook] Group "${groupId}" flush failed: ${err.message}\n`
          );
        }
      }
    }
  } catch (err) {
    // Non-fatal — don't block the agent
    process.stderr.write(`[s3-sync-hook] Flush failed: ${err.message}\n`);
  }
  process.exit(0);
});
