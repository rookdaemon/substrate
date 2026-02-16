#!/bin/bash
# Substrate recovery script for systemd OnFailure handler
# This script attempts to diagnose and fix substrate service crashes using Claude CLI

set -euo pipefail

# Configuration
# Use persistent state directory (survives reboots unlike /tmp)
STATE_DIR="/var/lib/substrate"
ATTEMPT_FILE="$STATE_DIR/recovery-attempts"
MAX_ATTEMPTS=3
CLAUDE_TIMEOUT=300  # 5 minutes in seconds
RECIPIENT_EMAIL="lbsa71@hotmail.com"
SUBSTRATE_HOME="/home/rook/substrate"
LOG_TAG="substrate-recovery"

# Ensure state directory exists
mkdir -p "$STATE_DIR" 2>/dev/null || true

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

# Export reset function for use by systemd ExecStartPost
if [ "${1:-}" = "--reset" ]; then
    reset_attempt_count
    exit 0
fi

# Main recovery logic
main() {
    log_info "Substrate recovery service triggered"
    
    # Check attempt count
    local attempt_count
    attempt_count=$(get_attempt_count)
    
    if [ "$attempt_count" -ge "$MAX_ATTEMPTS" ]; then
        log_error "Maximum recovery attempts ($MAX_ATTEMPTS) reached. Manual intervention required."
        
        # Collect logs for final email
        local log_file="/tmp/substrate-recovery-final-logs.txt"
        journalctl -u substrate --no-pager -n 100 > "$log_file" 2>&1 || true
        
        send_email \
            "Substrate Recovery Failed - Manual Intervention Required" \
            "The substrate service has failed $MAX_ATTEMPTS times and automatic recovery has been exhausted.

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
    
    # Prepare Claude diagnostic prompt
    local claude_prompt="The substrate systemd service has crashed (attempt $attempt_count/$MAX_ATTEMPTS).

Please diagnose the issue by:
1. Checking recent logs: journalctl -u substrate --no-pager -n 50
2. Checking build state: cd $SUBSTRATE_HOME/server && npx tsc --noEmit
3. Checking disk space: df -h
4. Checking memory: free -h
5. Checking node version: node --version
6. Checking process state: ps aux | grep -i substrate

After diagnosis, attempt to fix the issue (e.g., rebuild if TypeScript compilation fails, clean up if disk space is low, restart if stuck process exists).

If you successfully fix the issue, indicate success in your response.
"
    
    # Run Claude with timeout
    log_info "Invoking Claude CLI for diagnosis (timeout: ${CLAUDE_TIMEOUT}s)..."
    
    local claude_output="/tmp/substrate-recovery-claude-output.txt"
    local claude_exit_code=0
    
    # Run claude with timeout
    if timeout "$CLAUDE_TIMEOUT" claude -p "$claude_prompt" --dangerously-skip-permissions > "$claude_output" 2>&1; then
        claude_exit_code=0
        log_info "Claude diagnostic completed successfully"
        
        # Check if Claude indicated success
        if grep -qiE "success|fixed|resolved" "$claude_output"; then
            log_info "Claude reported successful fix. Restarting substrate service..."
            
            # Restart the service
            if systemctl restart substrate.service; then
                log_info "Substrate service restarted successfully"
                
                # Send success notification
                send_email \
                    "Substrate Recovery Successful (Attempt $attempt_count)" \
                    "The substrate service has been successfully recovered by the automated recovery system.

Attempt: $attempt_count of $MAX_ATTEMPTS
Hostname: $(hostname)
Time: $(date -R)

Claude diagnostic output:
$(head -c 10000 < "$claude_output")
"
                
                # Reset counter on success
                reset_attempt_count
                rm -f "$claude_output"
                exit 0
            else
                log_error "Failed to restart substrate service after Claude fix"
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
    
    # Recovery attempt failed
    log_error "Recovery attempt $attempt_count failed"
    
    # Send failure notification
    send_email \
        "Substrate Recovery Attempt $attempt_count Failed" \
        "The automated recovery attempt $attempt_count of $MAX_ATTEMPTS has failed.

Hostname: $(hostname)
Time: $(date -R)
Claude exit code: $claude_exit_code

Claude diagnostic output:
$(head -c 10000 < "$claude_output" 2>/dev/null || echo "No output captured")

Recent substrate logs:
$(journalctl -u substrate --no-pager -n 30 2>&1 | head -c 10000 || echo "Failed to get logs")
"
    
    rm -f "$claude_output"
    
    # Exit with failure so systemd knows this attempt didn't work
    exit 1
}

# Run main function
main
