#!/bin/bash
# Bishop substrate recovery script for systemd OnFailure handler
# This script attempts to diagnose and fix bishop-substrate crashes using Claude CLI

set -euo pipefail

# Configuration
STATE_DIR="/var/lib/bishop-substrate"
ATTEMPT_FILE="$STATE_DIR/recovery-attempts"
MAX_ATTEMPTS=3
CLAUDE_TIMEOUT=300  # 5 minutes in seconds
RECIPIENT_EMAIL="lbsa71@hotmail.com"
SUBSTRATE_HOME="/home/bishop/substrate"
SERVICE_NAME="bishop-substrate.service"
LOG_TAG="bishop-substrate-recovery"

# Function to log to journald
log_info() {
    echo "$1"
    logger -t "$LOG_TAG" -p user.info "$1"
}

log_error() {
    echo "$1" >&2
    logger -t "$LOG_TAG" -p user.err "$1"
}

# Function to send email
send_email() {
    local subject="$1"
    local body="$2"
    local attachment="${3:-}"

    if command -v mail >/dev/null 2>&1; then
        if [ -n "$attachment" ] && [ -f "$attachment" ]; then
            echo "$body" | mail -s "$subject" -a "$attachment" "$RECIPIENT_EMAIL"
        else
            echo "$body" | mail -s "$subject" "$RECIPIENT_EMAIL"
        fi
    elif command -v sendmail >/dev/null 2>&1; then
        (
            echo "To: $RECIPIENT_EMAIL"
            echo "Subject: $subject"
            echo ""
            echo "$body"
        ) | sendmail -t
    else
        log_error "No mail command available (tried mail and sendmail)"
    fi
}

# Function to get current attempt count
get_attempt_count() {
    if [ -f "$ATTEMPT_FILE" ]; then
        cat "$ATTEMPT_FILE"
    else
        echo "0"
    fi
}

# Function to increment attempt count
increment_attempt_count() {
    local current
    current=$(get_attempt_count)
    local next=$((current + 1))
    echo "$next" > "$ATTEMPT_FILE"
    echo "$next"
}

# Function to reset attempt count
reset_attempt_count() {
    rm -f "$ATTEMPT_FILE"
    log_info "Reset recovery attempt counter"
}

# Function to clear systemd's start rate limit so restart is allowed
clear_failed_state() {
    log_info "Clearing systemd failed state for $SERVICE_NAME"
    sudo systemctl reset-failed "$SERVICE_NAME" 2>/dev/null || true
}

# Function to restart substrate via systemctl (requires sudo)
restart_substrate() {
    clear_failed_state
    sudo systemctl restart "$SERVICE_NAME"
}

# Export reset function for use by systemd ExecStartPost
if [ "${1:-}" = "--reset" ]; then
    reset_attempt_count
    exit 0
fi

# Main recovery logic
main() {
    log_info "Bishop substrate recovery service triggered"

    # Check attempt count
    local attempt_count
    attempt_count=$(get_attempt_count)

    if [ "$attempt_count" -ge "$MAX_ATTEMPTS" ]; then
        log_error "Maximum recovery attempts ($MAX_ATTEMPTS) reached. Manual intervention required."

        # Collect logs for final email
        local log_file="/tmp/bishop-substrate-recovery-final-logs.txt"
        journalctl -u "$SERVICE_NAME" --no-pager -n 100 > "$log_file" 2>&1 || true

        send_email \
            "Bishop Substrate Recovery Failed - Manual Intervention Required" \
            "The bishop-substrate service has failed $MAX_ATTEMPTS times and automatic recovery has been exhausted.

Please SSH in and diagnose the issue manually.

Recent logs are attached.

Hostname: $(hostname)
Time: $(date -R)
" \
            "$log_file"

        rm -f "$log_file"
        exit 1
    fi

    # Increment attempt count
    attempt_count=$(increment_attempt_count)
    log_info "Recovery attempt $attempt_count of $MAX_ATTEMPTS"

    # Calculate backoff delay
    local backoff_seconds=$((60 * attempt_count))
    log_info "Waiting ${backoff_seconds}s before recovery attempt (escalating backoff)..."
    sleep "$backoff_seconds"

    # Step 1: Try standard rebuild first (nvm use --lts, npm ci, npm run build)
    log_info "Attempting standard rebuild: nvm use --lts, npm ci, npm run build..."

    local rebuild_output="/tmp/bishop-substrate-recovery-rebuild-output.txt"
    local rebuild_success=false

    # Source nvm and attempt rebuild
    # Note: nvm.sh uses unbound variables, so we must disable nounset around it
    if (
        export NVM_DIR="$HOME/.nvm"
        # shellcheck source=/dev/null
        set +u
        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
        nvm use --lts || exit 1
        set -u

        cd "$SUBSTRATE_HOME" || exit 1

        echo "=== npm ci ==="
        npm ci || exit 1

        echo "=== npm run build ==="
        npm run build || exit 1

        echo "=== Rebuild completed successfully ==="
    ) > "$rebuild_output" 2>&1; then
        rebuild_success=true
        log_info "Standard rebuild succeeded"
    else
        log_error "Standard rebuild failed (see $rebuild_output)"
    fi

    if [ "$rebuild_success" = true ]; then
        # Rebuild worked, try restarting the service
        if restart_substrate; then
            log_info "Bishop substrate service restarted successfully after rebuild"

            send_email \
                "Bishop Substrate Recovery Successful via Rebuild (Attempt $attempt_count)" \
                "The bishop-substrate service was recovered by a standard rebuild (nvm use --lts, npm ci, npm run build).

Attempt: $attempt_count of $MAX_ATTEMPTS
Hostname: $(hostname)
Time: $(date -R)

Rebuild output:
$(head -c 10000 < "$rebuild_output")
"

            reset_attempt_count
            rm -f "$rebuild_output"
            exit 0
        else
            log_error "Service restart failed after successful rebuild, escalating to Claude..."
        fi
    fi

    # Step 2: Rebuild failed or service didn't restart — escalate to Claude
    log_info "Escalating to Claude CLI for full diagnosis and fix..."

    local claude_prompt="The bishop-substrate process has crashed and the recovery service isn't resurrecting it. Please fix the root cause, build, lint, test, push and restart services."

    local claude_output="/tmp/bishop-substrate-recovery-claude-output.txt"
    local claude_exit_code=0

    # Run claude with timeout
    if timeout "$CLAUDE_TIMEOUT" claude -p "$claude_prompt" --dangerously-skip-permissions > "$claude_output" 2>&1; then
        claude_exit_code=0
        log_info "Claude diagnostic completed successfully"

        # Check if Claude indicated success
        if grep -qiE "success|fixed|resolved" "$claude_output"; then
            log_info "Claude reported successful fix. Restarting bishop-substrate service..."

            # Restart the service
            if restart_substrate; then
                log_info "Bishop substrate service restarted successfully"

                # Send success notification
                send_email \
                    "Bishop Substrate Recovery Successful via Claude (Attempt $attempt_count)" \
                    "The bishop-substrate service has been successfully recovered by the Claude-assisted recovery system.

Attempt: $attempt_count of $MAX_ATTEMPTS
Hostname: $(hostname)
Time: $(date -R)

Rebuild output (failed):
$(head -c 5000 < "$rebuild_output" 2>/dev/null || echo "No rebuild output")

Claude diagnostic output:
$(head -c 10000 < "$claude_output")
"

                # Reset counter on success
                reset_attempt_count
                rm -f "$claude_output" "$rebuild_output"
                exit 0
            else
                log_error "Failed to restart bishop-substrate service after Claude fix"
                claude_exit_code=1
            fi
        else
            log_error "Claude did not report a successful fix"
            claude_exit_code=1
        fi
    else
        claude_exit_code=$?
        log_error "Claude invocation failed or timed out (exit code: $claude_exit_code)"
    fi

    rm -f "$rebuild_output"

    # Recovery attempt failed
    log_error "Recovery attempt $attempt_count failed"

    # Send failure notification
    send_email \
        "Bishop Substrate Recovery Attempt $attempt_count Failed" \
        "The automated recovery attempt $attempt_count of $MAX_ATTEMPTS has failed.

Hostname: $(hostname)
Time: $(date -R)
Claude exit code: $claude_exit_code

Claude diagnostic output:
$(head -c 10000 < "$claude_output" 2>/dev/null || echo "No output captured")

Recent bishop-substrate logs:
$(journalctl -u "$SERVICE_NAME" --no-pager -n 30 2>&1 | head -c 10000 || echo "Failed to get logs")
"

    rm -f "$claude_output"

    # Exit with failure so systemd knows this attempt didn't work
    exit 1
}

# Run main function
main
