#!/bin/bash
# Periodic auto-update script: pull → build → lint → test → restart substrates
#
# Runs as a systemd timer (substrate-autoupdate.timer) on a configurable cadence.
# Sequence:
#   1. git pull (rebase + autostash)
#   2. npm ci
#   3. npm run lint
#   4. npm run test
#   5. Sleep gate: both substrate and nova-substrate must be SLEEPING (or idle enough)
#   6. sudo systemctl restart substrate.service
#   7. sudo systemctl restart nova-substrate.service
#
# On any step failure: log error and exit without restarting either service.
# If sleep gate not cleared: log deferral and exit 0 (retry on next timer tick).

set -euo pipefail

# ---------- Configuration (override via environment) ----------
SUBSTRATE_HOME="${SUBSTRATE_HOME:-/home/rook/substrate}"

# Dedicated log directory created and owned by the service user via systemd's
# LogsDirectory= directive (see substrate-autoupdate.service). This means systemd
# automatically creates /var/log/substrate-autoupdate/ owned by rook before ExecStart runs.
LOG_DIR="${LOGS_DIRECTORY:-/var/log/substrate-autoupdate}"
LOG_FILE="$LOG_DIR/auto-update.log"

LOG_TAG="substrate-autoupdate"

# HTTP API ports for the sleep-gate check
ROOK_API_PORT="${ROOK_API_PORT:-3000}"
NOVA_API_PORT="${NOVA_API_PORT:-3001}"

# Minimum consecutiveIdleCycles to consider a substrate idle enough for restart
# (fallback when state != SLEEPING but cycles have been idle for a while)
IDLE_THRESHOLD="${IDLE_THRESHOLD:-5}"

# Maximum log file size in bytes before rotation (10 MB)
# Rotation keeps one backup (.1); older backup is overwritten on the next rotation.
MAX_LOG_BYTES=10485760
# ---------- End Configuration ----------

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Rotate log if it exceeds the size limit
if [ -f "$LOG_FILE" ] && [ "$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)" -gt "$MAX_LOG_BYTES" ]; then
    mv "$LOG_FILE" "${LOG_FILE}.1"
fi

log_info() {
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    echo "$ts [INFO]  $1" | tee -a "$LOG_FILE"
    logger -t "$LOG_TAG" -p user.info "$1" 2>/dev/null || true
}

log_error() {
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    echo "$ts [ERROR] $1" | tee -a "$LOG_FILE" >&2
    logger -t "$LOG_TAG" -p user.err "$1" 2>/dev/null || true
}

# Check whether a substrate is sleeping via its HTTP status API.
# Returns 0 (true) if sleeping or idle enough; 1 (false) if active or unreachable.
is_substrate_sleeping() {
    local port="$1"
    local name="$2"
    local response

    response=$(curl -sf --max-time 5 "http://localhost:${port}/api/loop/status" 2>/dev/null) || {
        log_info "[$name] API unreachable on port $port — treating as not sleeping (deferring)"
        return 1
    }

    # Extract state field  ("state":"SLEEPING")
    local state=""
    state=$(echo "$response" | grep -o '"state":"[^"]*"' | cut -d'"' -f4) || true

    if [ "$state" = "SLEEPING" ]; then
        log_info "[$name] state=SLEEPING — sleep gate passed"
        return 0
    fi

    # Fallback: check consecutiveIdleCycles inside metrics object
    local consecutive_idle="0"
    consecutive_idle=$(echo "$response" | grep -o '"consecutiveIdleCycles":[0-9]*' | grep -o '[0-9]*$') || true
    # Default to 0 if extraction yielded an empty or non-numeric value
    if ! [[ "$consecutive_idle" =~ ^[0-9]+$ ]]; then
        consecutive_idle="0"
    fi

    if [ "$consecutive_idle" -ge "$IDLE_THRESHOLD" ]; then
        log_info "[$name] state=$state consecutiveIdleCycles=$consecutive_idle >= $IDLE_THRESHOLD — sleep gate passed"
        return 0
    fi

    log_info "[$name] state=${state:-unknown} consecutiveIdleCycles=$consecutive_idle — active, deferring restart"
    return 1
}

main() {
    echo "" >> "$LOG_FILE"
    log_info "=== Auto-update cycle started ==="

    # Source nvm so that npm/node commands are available
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    # nvm.sh uses unbound variables internally; disable nounset around it
    set +u
    # shellcheck source=/dev/null
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    set -u

    cd "$SUBSTRATE_HOME" || { log_error "Cannot cd to $SUBSTRATE_HOME — aborting"; exit 1; }

    # Step 1: git pull
    log_info "Step 1/7: git pull"
    if ! git pull --rebase --autostash >> "$LOG_FILE" 2>&1; then
        log_error "git pull failed — substrates untouched"
        exit 1
    fi

    # Step 2: npm ci (clean install from lock file)
    log_info "Step 2/7: npm ci"
    if ! npm ci >> "$LOG_FILE" 2>&1; then
        log_error "npm ci failed — substrates untouched"
        exit 1
    fi

    # Step 3: npm run lint
    log_info "Step 3/7: npm run lint"
    if ! npm run lint >> "$LOG_FILE" 2>&1; then
        log_error "Lint failed — substrates untouched"
        exit 1
    fi

    # Step 4: npm run test
    log_info "Step 4/7: npm run test"
    if ! npm test >> "$LOG_FILE" 2>&1; then
        log_error "Tests failed — substrates untouched"
        exit 1
    fi

    log_info "Build/lint/test all passed ✓"

    # Step 5: Sleep gate — both substrates must be sleeping (or idle enough)
    log_info "Step 5/7: Checking sleep gate"

    local rook_sleeping=false
    local nova_sleeping=false

    if is_substrate_sleeping "$ROOK_API_PORT" "substrate"; then
        rook_sleeping=true
    fi

    if is_substrate_sleeping "$NOVA_API_PORT" "nova-substrate"; then
        nova_sleeping=true
    fi

    if [ "$rook_sleeping" = false ] || [ "$nova_sleeping" = false ]; then
        log_info "Sleep gate not cleared — deferring restart to next timer tick"
        exit 0
    fi

    # Step 6: Restart substrate.service (rook)
    log_info "Step 6/7: Restarting substrate.service"
    if ! sudo systemctl restart substrate.service >> "$LOG_FILE" 2>&1; then
        log_error "Failed to restart substrate.service"
        exit 1
    fi
    log_info "substrate.service restarted ✓"

    # Step 7: Restart nova-substrate.service
    log_info "Step 7/7: Restarting nova-substrate.service"
    if ! sudo systemctl restart nova-substrate.service >> "$LOG_FILE" 2>&1; then
        log_error "Failed to restart nova-substrate.service"
        exit 1
    fi
    log_info "nova-substrate.service restarted ✓"

    log_info "=== Auto-update cycle completed successfully ==="
}

main
