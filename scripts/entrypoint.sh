#!/bin/bash
# entrypoint.sh — goClaw agent container entrypoint
#
# Lifecycle:
#   1. Hydrate workspace from S3 (if configured) — agent vault bucket (read-write)
#      plus, in HQ Fleet vault mode, the company vault bucket (read-only mount)
#   2. Start the agent server (configurable via GOCLAW_SERVER_CMD)
#   3. On SIGTERM: snapshot workspace to S3 (agent vault bucket ONLY), then exit
#
# tini handles signal forwarding — this script sets up the SIGTERM trap
# and delegates to the server process.
#
# Storage env-var contract (see scripts/workspace-sync.sh header for full detail).
# HQ Fleet vault mode (preferred — DESIGN §4/§6, injected by the hq-pro fleet manager):
#   HQ_VAULT_AGENT_BUCKET    — agent's own vault bucket (read-write; sole push target)
#   HQ_VAULT_COMPANY_BUCKET  — company vault bucket (read-only mount; never pushed)
#   HQ_AGENT_UID             — agent agt_... uid for log correlation
#   HQ_COMPANY_MOUNT_PATH    — read-only company mount path (default /workspace/company)
# Legacy standalone mode (backward compatible — used when HQ_VAULT_AGENT_BUCKET is unset):
#   GOCLAW_S3_BUCKET, GOCLAW_AGENT_NAME
# Common: GOCLAW_SYNC_PUSH (periodic push interval, seconds; default 60)

set -euo pipefail

# Agent UID (when injected by the fleet manager) is woven into log lines so fleet
# logs can be correlated per agent (DESIGN US-013/US-017).
AGENT_UID="${HQ_AGENT_UID:-}"

log() {
    if [ -n "$AGENT_UID" ]; then
        echo "[entrypoint] $(date -u +%Y-%m-%dT%H:%M:%SZ) [${AGENT_UID}] $*" >&2
    else
        echo "[entrypoint] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >&2
    fi
}

SERVER_PID=""
SYNC_PID=""
SNAPSHOT_DONE=false

# Server command — override to use a custom server
SERVER_CMD="${GOCLAW_SERVER_CMD:-node /app/goclaw-agent/dist/server.js}"

# ─── SIGTERM handler ─────────────────────────────────────────────────────────

# shellcheck disable=SC2329  # invoked indirectly via `trap` below.
handle_sigterm() {
    log "SIGTERM received — initiating graceful shutdown"

    if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        log "Sending SIGTERM to server (PID ${SERVER_PID})"
        kill -TERM "$SERVER_PID" 2>/dev/null || true

        local timeout=10
        while [ "$timeout" -gt 0 ] && kill -0 "$SERVER_PID" 2>/dev/null; do
            sleep 1
            timeout=$((timeout - 1))
        done

        if kill -0 "$SERVER_PID" 2>/dev/null; then
            log "Server did not exit in time — sending SIGKILL"
            kill -9 "$SERVER_PID" 2>/dev/null || true
        fi
    fi

    if [ -n "$SYNC_PID" ] && kill -0 "$SYNC_PID" 2>/dev/null; then
        log "Stopping S3 push watcher (PID ${SYNC_PID})"
        kill -TERM "$SYNC_PID" 2>/dev/null || true
        wait "$SYNC_PID" 2>/dev/null || true
    fi

    if [ "$SNAPSHOT_DONE" = false ]; then
        SNAPSHOT_DONE=true
        log "Snapshotting workspace to S3 (agent vault bucket only)..."
        /app/scripts/workspace-sync.sh snapshot || log "WARN: Snapshot failed (non-fatal)"
    fi

    log "Shutdown complete"
    exit 0
}

trap handle_sigterm SIGTERM SIGINT

# ─── Step 1: Hydrate workspace from S3 ──────────────────────────────────────

log "Starting goClaw agent"
/app/scripts/workspace-sync.sh hydrate || log "WARN: Hydration failed (continuing with empty workspace)"

# Ensure /workspace/group is a git repo so Claude Code SDK finds .claude/settings.json
if [ ! -d /workspace/group/.git ]; then
    git init /workspace/group --quiet 2>/dev/null || true
    log "Initialized git repo at /workspace/group"
fi

# ─── Step 1b: Start periodic push to S3 ─────────────────────────────────────

/app/scripts/workspace-sync.sh watch &
SYNC_PID=$!
log "S3 push watcher started (PID ${SYNC_PID})"

# ─── Step 2: Start server ───────────────────────────────────────────────────

log "Starting server: $SERVER_CMD"
$SERVER_CMD &
SERVER_PID=$!

log "Server started (PID ${SERVER_PID})"

# ─── Step 3: Wait for server to finish ──────────────────────────────────────

wait "$SERVER_PID" 2>/dev/null
EXIT_CODE=$?

log "Server exited with code ${EXIT_CODE}"

# ─── Step 4: Stop watcher & final S3 snapshot ───────────────────────────────

if [ -n "$SYNC_PID" ] && kill -0 "$SYNC_PID" 2>/dev/null; then
    log "Stopping S3 push watcher (PID ${SYNC_PID})"
    kill -TERM "$SYNC_PID" 2>/dev/null || true
    wait "$SYNC_PID" 2>/dev/null || true
fi

if [ "$SNAPSHOT_DONE" = false ]; then
    SNAPSHOT_DONE=true
    log "Final workspace snapshot to S3 (agent vault bucket only)..."
    /app/scripts/workspace-sync.sh snapshot || log "WARN: Final snapshot failed (non-fatal)"
fi

log "Entrypoint complete"
exit $EXIT_CODE
