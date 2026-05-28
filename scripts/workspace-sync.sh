#!/bin/bash
# workspace-sync.sh — S3 persistence for goClaw agent workspace
#
# Hydrates /workspace from S3 on boot and snapshots back on shutdown.
# Uses aws s3 sync for efficient differential transfers.
#
# ─── Two storage modes ─────────────────────────────────────────────────────────
#
# 1. HQ Fleet vault mode (preferred — HQ Fleet integration, DESIGN §4/§6):
#    Each agent owns a dedicated per-agent vault bucket (hq-vault-agent-{ulid})
#    and gets read-only access to its company's vault bucket. The fleet manager
#    (hq-pro) injects the following env vars:
#
#      HQ_VAULT_AGENT_BUCKET    — the agent's OWN vault bucket (read-write).
#                                 e.g. hq-vault-agent-01HX... The whole bucket is
#                                 the agent's workspace; hydrate from it and push
#                                 snapshots back to it. THIS is the only bucket we
#                                 ever write to.
#      HQ_VAULT_COMPANY_BUCKET  — the company's vault bucket (READ-ONLY). Hydrated
#                                 into HQ_COMPANY_MOUNT_PATH. NEVER pushed to.
#                                 (optional — omit for an agent with no company.)
#      HQ_AGENT_UID             — the agent's agt_... uid, used for log correlation
#                                 (optional but recommended; DESIGN US-013/US-017).
#      HQ_COMPANY_MOUNT_PATH    — local path for the read-only company files.
#                                 (optional; default /workspace/company)
#
#    Vault mode is selected whenever HQ_VAULT_AGENT_BUCKET is set.
#
# 2. Standalone mode (legacy — backward compatible):
#    A single shared bucket with an agents/{name}/ key prefix. Selected when
#    HQ_VAULT_AGENT_BUCKET is unset but the legacy env vars are present:
#
#      GOCLAW_S3_BUCKET    — S3 bucket name
#      GOCLAW_AGENT_NAME   — Agent name used as the S3 key prefix
#
# Common (both modes):
#      GOCLAW_SYNC_PUSH    — periodic push interval in seconds (default 60)
#
# Synced paths (under /workspace/group/):
#   CLAUDE.md           — Agent identity and directives
#   config.yaml         — Agent config
#   knowledge/          — Learned knowledge files
#   skills/             — Custom skills
#   conversations/      — Archived conversation transcripts
#   data/               — Agent data
#   public/             — Static public files
#   tools/              — Agent-created tool scripts
#   memory/             — Claude Code auto-memory entries
#   .claude/            — Claude Code hooks, commands, and settings

set -euo pipefail

WORKSPACE="/workspace/group"

# ─── Mode resolution ───────────────────────────────────────────────────────────
# Vault mode owns its own bucket root (no agents/{name}/ prefix); standalone mode
# partitions a shared bucket by an agents/{name}/ prefix.

VAULT_AGENT_BUCKET="${HQ_VAULT_AGENT_BUCKET:-}"
VAULT_COMPANY_BUCKET="${HQ_VAULT_COMPANY_BUCKET:-}"
AGENT_UID="${HQ_AGENT_UID:-}"
COMPANY_MOUNT="${HQ_COMPANY_MOUNT_PATH:-/workspace/company}"

# Legacy standalone vars.
LEGACY_BUCKET="${GOCLAW_S3_BUCKET:-}"
LEGACY_AGENT="${GOCLAW_AGENT_NAME:-}"

if [ -n "$VAULT_AGENT_BUCKET" ]; then
    MODE="vault"
    # The per-agent vault bucket IS the workspace — sync against its root.
    AGENT_S3="s3://${VAULT_AGENT_BUCKET}"
else
    MODE="standalone"
    AGENT_S3="s3://${LEGACY_BUCKET}/agents/${LEGACY_AGENT}"
fi

# Directories that round-trip to the agent's own (read-write) bucket.
SYNC_DIRS=(knowledge skills conversations data public tools memory .claude)

log() {
    # Include the agent UID (when known) so fleet logs can correlate by agent.
    if [ -n "$AGENT_UID" ]; then
        echo "[workspace-sync] $(date -u +%Y-%m-%dT%H:%M:%SZ) [${AGENT_UID}] $*" >&2
    else
        echo "[workspace-sync] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >&2
    fi
}

# ─── Validation ──────────────────────────────────────────────────────────────

validate() {
    if [ "$MODE" = "vault" ]; then
        # HQ_VAULT_AGENT_BUCKET presence already selected this mode.
        return 0
    fi

    # Standalone mode requires both legacy vars.
    if [ -z "$LEGACY_BUCKET" ]; then
        log "WARN: GOCLAW_S3_BUCKET not set — S3 sync disabled"
        return 1
    fi
    if [ -z "$LEGACY_AGENT" ]; then
        log "WARN: GOCLAW_AGENT_NAME not set — S3 sync disabled"
        return 1
    fi
    return 0
}

# ─── Hydrate ─────────────────────────────────────────────────────────────────

# Pull the agent's own (read-write) bucket into the workspace.
hydrate_agent() {
    log "Hydrating workspace from ${AGENT_S3} (read-write)..."

    aws s3 cp "${AGENT_S3}/CLAUDE.md" "${WORKSPACE}/CLAUDE.md" 2>/dev/null || \
        log "No CLAUDE.md found in S3 (first boot?)"
    aws s3 cp "${AGENT_S3}/config.yaml" "${WORKSPACE}/config.yaml" 2>/dev/null || \
        log "No config.yaml found in S3 (first boot?)"

    for dir in "${SYNC_DIRS[@]}"; do
        if aws s3 ls "${AGENT_S3}/${dir}/" >/dev/null 2>&1; then
            mkdir -p "${WORKSPACE}/${dir}"
            aws s3 sync "${AGENT_S3}/${dir}/" "${WORKSPACE}/${dir}/" --delete --quiet
            log "Synced ${dir}/ ($(find "${WORKSPACE}/${dir}/" -type f 2>/dev/null | wc -l) files)"
        else
            log "No ${dir}/ found in S3 (first boot?)"
        fi
    done
}

# Pull the company's vault bucket into a SEPARATE, read-only mount path.
# This is a one-way copy from S3 → local; we NEVER push back to it.
hydrate_company() {
    if [ "$MODE" != "vault" ] || [ -z "$VAULT_COMPANY_BUCKET" ]; then
        return 0
    fi

    local company_s3="s3://${VAULT_COMPANY_BUCKET}"
    log "Hydrating company knowledge from ${company_s3} -> ${COMPANY_MOUNT} (read-only)..."

    mkdir -p "${COMPANY_MOUNT}"
    if aws s3 sync "${company_s3}/" "${COMPANY_MOUNT}/" --delete --quiet; then
        log "Company mount populated ($(find "${COMPANY_MOUNT}/" -type f 2>/dev/null | wc -l) files, read-only)"
    else
        log "WARN: Company mount hydration failed (continuing without company knowledge)"
    fi
}

hydrate() {
    if ! validate; then
        log "Skipping hydration (missing config)"
        return 0
    fi

    log "Storage mode: ${MODE}"
    hydrate_agent
    hydrate_company
    log "Hydration complete"
}

# ─── Snapshot ────────────────────────────────────────────────────────────────
#
# Snapshot ALWAYS targets the agent's own (read-write) bucket. The read-only
# company bucket is never a write target — it is intentionally untouched here.

snapshot() {
    if ! validate; then
        log "Skipping snapshot (missing config)"
        return 0
    fi

    log "Snapshotting workspace to ${AGENT_S3} (agent bucket only)..."

    if [ -f "${WORKSPACE}/CLAUDE.md" ]; then
        aws s3 cp "${WORKSPACE}/CLAUDE.md" "${AGENT_S3}/CLAUDE.md" --quiet
        log "Synced CLAUDE.md"
    fi
    if [ -f "${WORKSPACE}/config.yaml" ]; then
        aws s3 cp "${WORKSPACE}/config.yaml" "${AGENT_S3}/config.yaml" --quiet
        log "Synced config.yaml"
    fi

    for dir in "${SYNC_DIRS[@]}"; do
        if [ -d "${WORKSPACE}/${dir}" ]; then
            aws s3 sync "${WORKSPACE}/${dir}/" "${AGENT_S3}/${dir}/" --delete --quiet
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

    log "Starting push watcher (interval=${PUSH_SEC}s, target=${AGENT_S3})"

    echo $$ > "$WATCH_PIDFILE"

    for dir in "${SYNC_DIRS[@]}"; do
        mkdir -p "${WORKSPACE}/${dir}"
    done

    while true; do
        sleep "$PUSH_SEC"
        if snapshot 2>/dev/null; then
            log "Push complete"
        else
            log "WARN: Push failed"
        fi
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
