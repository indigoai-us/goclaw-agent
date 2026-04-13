#!/bin/bash
# workspace-sync.sh — S3 persistence for goClaw agent workspace
#
# Hydrates /workspace from S3 on boot and snapshots back on shutdown.
# Uses aws s3 sync for efficient differential transfers.
#
# Required env vars (S3 sync is disabled if these are not set):
#   GOCLAW_S3_BUCKET    — S3 bucket name
#   GOCLAW_AGENT_NAME   — Agent name used as S3 key prefix
#
# Synced paths (under /workspace/group/):
#   CLAUDE.md           — Agent identity and directives
#   knowledge/          — Learned knowledge files
#   skills/             — Custom skills
#   conversations/      — Archived conversation transcripts
#   public/             — Static public files
#   tools/              — Agent-created tool scripts
#   memory/             — Claude Code auto-memory entries
#   .claude/            — Claude Code hooks, commands, and settings

set -euo pipefail

BUCKET="${GOCLAW_S3_BUCKET:-}"
AGENT="${GOCLAW_AGENT_NAME:-}"
WORKSPACE="/workspace/group"

S3_PREFIX="s3://${BUCKET}/agents/${AGENT}"

log() {
    echo "[workspace-sync] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >&2
}

# ─── Validation ──────────────────────────────────────────────────────────────

validate() {
    if [ -z "$BUCKET" ]; then
        log "WARN: GOCLAW_S3_BUCKET not set — S3 sync disabled"
        return 1
    fi
    if [ -z "$AGENT" ]; then
        log "WARN: GOCLAW_AGENT_NAME not set — S3 sync disabled"
        return 1
    fi
    return 0
}

# ─── Hydrate ─────────────────────────────────────────────────────────────────

hydrate() {
    if ! validate; then
        log "Skipping hydration (missing config)"
        return 0
    fi

    log "Hydrating workspace from ${S3_PREFIX}..."

    aws s3 cp "${S3_PREFIX}/CLAUDE.md" "${WORKSPACE}/CLAUDE.md" 2>/dev/null || \
        log "No CLAUDE.md found in S3 (first boot?)"
    aws s3 cp "${S3_PREFIX}/config.yaml" "${WORKSPACE}/config.yaml" 2>/dev/null || \
        log "No config.yaml found in S3 (first boot?)"

    for dir in knowledge skills conversations data public tools memory .claude; do
        if aws s3 ls "${S3_PREFIX}/${dir}/" >/dev/null 2>&1; then
            mkdir -p "${WORKSPACE}/${dir}"
            aws s3 sync "${S3_PREFIX}/${dir}/" "${WORKSPACE}/${dir}/" --delete --quiet
            log "Synced ${dir}/ ($(find "${WORKSPACE}/${dir}/" -type f 2>/dev/null | wc -l) files)"
        else
            log "No ${dir}/ found in S3 (first boot?)"
        fi
    done

    log "Hydration complete"
}

# ─── Snapshot ────────────────────────────────────────────────────────────────

snapshot() {
    if ! validate; then
        log "Skipping snapshot (missing config)"
        return 0
    fi

    log "Snapshotting workspace to ${S3_PREFIX}..."

    if [ -f "${WORKSPACE}/CLAUDE.md" ]; then
        aws s3 cp "${WORKSPACE}/CLAUDE.md" "${S3_PREFIX}/CLAUDE.md" --quiet
        log "Synced CLAUDE.md"
    fi
    if [ -f "${WORKSPACE}/config.yaml" ]; then
        aws s3 cp "${WORKSPACE}/config.yaml" "${S3_PREFIX}/config.yaml" --quiet
        log "Synced config.yaml"
    fi

    for dir in knowledge skills conversations data public tools memory .claude; do
        if [ -d "${WORKSPACE}/${dir}" ]; then
            aws s3 sync "${WORKSPACE}/${dir}/" "${S3_PREFIX}/${dir}/" --delete --quiet
            log "Synced ${dir}/ ($(find "${WORKSPACE}/${dir}/" -type f 2>/dev/null | wc -l) files)"
        fi
    done

    log "Snapshot complete"
}

# ─── Watch ───────────────────────────────────────────────────────────────────

WATCH_PIDFILE="/tmp/workspace-sync-watch.pid"
PUSH_SEC="${GOCLAW_SYNC_PUSH:-60}"

watch() {
    if ! validate; then
        log "Cannot start watch (missing config)"
        return 1
    fi

    log "Starting push watcher (interval=${PUSH_SEC}s)"

    echo $$ > "$WATCH_PIDFILE"

    for dir in knowledge skills conversations data public tools memory .claude; do
        mkdir -p "${WORKSPACE}/${dir}"
    done

    while true; do
        sleep "$PUSH_SEC"
        snapshot 2>/dev/null && log "Push complete" || log "WARN: Push failed"
    done

    rm -f "$WATCH_PIDFILE"
    log "Watch stopped"
}

# ─── CLI ─────────────────────────────────────────────────────────────────────

case "${1:-}" in
    hydrate)
        hydrate
        ;;
    snapshot)
        snapshot
        ;;
    watch)
        watch
        ;;
    *)
        echo "Usage: workspace-sync.sh {hydrate|snapshot|watch}" >&2
        exit 1
        ;;
esac
