# Systemd Deployment with Automated Recovery

## Overview

This document provides a high-level overview of the systemd deployment architecture for Substrate with automated crash recovery. For detailed installation and troubleshooting, see [`scripts/systemd/README.md`](../scripts/systemd/README.md).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  substrate.service                       │
│  (Main service - runs npm run start)                    │
│                                                          │
│  OnFailure=substrate-recovery.service ────────┐         │
│  ExecStartPost=recovery.sh --reset            │         │
└───────────────────────────────────────────────┼─────────┘
                                                │
                                                │ triggers on failure
                                                ▼
┌─────────────────────────────────────────────────────────┐
│            substrate-recovery.service                    │
│  (OneShot - runs recovery.sh)                           │
│                                                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │           recovery.sh orchestration               │  │
│  │                                                   │  │
│  │  1. Check /var/lib/substrate/recovery-attempts   │  │
│  │  2. If >= 3, send final failure email, exit      │  │
│  │  3. Increment counter                             │  │
│  │  4. Wait (60s × attempt_number) - backoff         │  │
│  │  5. Run Claude CLI diagnostic (5min timeout)      │  │
│  │  6. If success → restart substrate.service        │  │
│  │  7. Send email notification                       │  │
│  │  8. On success, reset counter                     │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Recovery Flow

### Normal Operation

1. **Substrate starts** → `ExecStartPost` resets attempt counter to 0
2. **Substrate runs** → No recovery needed
3. **User stops service** → Clean shutdown, no recovery

### Failure Scenario

1. **Substrate crashes/fails** → systemd detects failure
2. **systemd triggers** → `substrate-recovery.service` via `OnFailure=`
3. **Recovery script runs**:
   - **Attempt 1**: Wait 60s → Claude diagnoses → Send email
   - **Attempt 2**: Wait 120s → Claude diagnoses → Send email
   - **Attempt 3**: Wait 180s → Claude diagnoses → Send email
   - **After 3 failures**: Send "manual intervention required" email with logs

### Success Path

- Claude identifies issue (e.g., build failure, disk full, stuck process)
- Claude fixes issue (e.g., runs `npm run build`, cleans disk, kills process)
- Recovery script restarts `substrate.service`
- Counter resets to 0 via `ExecStartPost`
- Email notification confirms recovery

## Claude Diagnostic Process

When invoked, Claude CLI:

1. **Checks logs**: `journalctl -u substrate -n 50`
2. **Checks build**: `cd /home/rook/substrate/server && npx tsc --noEmit`
3. **Checks resources**: `df -h`, `free -h`
4. **Checks processes**: `ps aux | grep substrate`
5. **Attempts repair**: Build, cleanup, restart as needed
6. **Reports status**: Indicates success/failure in output

## Key Features

### Graduated Response

- **60s delay** before first attempt (allows transient issues to resolve)
- **120s delay** before second attempt (escalating backoff)
- **180s delay** before third attempt (final automated attempt)
- **Manual intervention** required after 3 failures

### State Persistence

- Counter stored at `/var/lib/substrate/recovery-attempts`
- Survives system reboots
- Automatically reset on successful startup
- Can be manually reset: `recovery.sh --reset`

### Email Notifications

All recovery attempts send emails to `lbsa71@hotmail.com` including:
- Attempt number (X of 3)
- Hostname and timestamp
- Claude diagnostic output (truncated to 10KB)
- Recent substrate logs (30 lines, truncated to 10KB)

### Logging

All recovery activity logged to journald:
```bash
sudo journalctl -u substrate-recovery -f
```

## Quick Start

```bash
# Copy service units
sudo cp scripts/systemd/*.service /etc/systemd/system/

# Create state directory
sudo mkdir -p /var/lib/substrate
sudo chown rook:rook /var/lib/substrate

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable substrate.service
sudo systemctl start substrate.service
```

## Testing Recovery

To test the recovery mechanism:

```bash
# Simulate a failure (as root)
sudo systemctl kill -s SIGKILL substrate.service

# Watch recovery logs
sudo journalctl -u substrate-recovery -f

# Check attempt counter
cat /var/lib/substrate/recovery-attempts
```

## Common Scenarios

### Scenario 1: TypeScript Build Failure

**Symptom**: Substrate fails to start due to compilation errors

**Recovery Process**:
1. Claude runs `npx tsc --noEmit`, sees errors
2. Claude examines error messages
3. If simple fix (e.g., syntax error), Claude edits file
4. Claude rebuilds: `npm run build`
5. Recovery script restarts service
6. Counter resets on successful start

### Scenario 2: Disk Space Exhaustion

**Symptom**: Substrate crashes due to ENOSPC errors

**Recovery Process**:
1. Claude runs `df -h`, identifies full partition
2. Claude cleans up: old logs, build artifacts, tmp files
3. Claude verifies space: `df -h`
4. Recovery script restarts service
5. Email sent with cleanup details

### Scenario 3: Port Already in Use

**Symptom**: Substrate fails with EADDRINUSE

**Recovery Process**:
1. Claude runs `ps aux | grep substrate`
2. Claude identifies stuck process
3. Claude kills stuck process: `kill <PID>`
4. Recovery script restarts service
5. Service starts successfully

### Scenario 4: Repeated Failures (Bug in Code)

**Symptom**: Substrate crashes repeatedly, Claude can't fix

**Recovery Process**:
1. Attempt 1: Wait 60s, Claude tries, fails, email sent
2. Attempt 2: Wait 120s, Claude tries, fails, email sent
3. Attempt 3: Wait 180s, Claude tries, fails, email sent
4. Final email: "Manual intervention required" with full logs
5. Stefan SSHs in to debug

## Security Considerations

⚠️ **The recovery script runs Claude CLI with `--dangerously-skip-permissions`**

**Implications**:
- Claude has full access as the `rook` user
- Can read/write files, execute commands, install packages
- Necessary for system diagnostics and repairs
- Risk: Malicious prompt injection could cause harm

**Mitigations**:
- Run substrate service as non-root user (`rook`)
- Use systemd sandboxing if needed (ProtectSystem, etc.)
- Monitor recovery logs for unexpected activity
- Limit service user privileges in production

**Email Security**:
- Emails contain sensitive system information
- Consider encrypted email for production deployments
- Logs truncated to 10KB to limit exposure

## Monitoring

### Health Check

```bash
# Service status
sudo systemctl status substrate.service

# Recovery status
sudo systemctl status substrate-recovery.service

# Attempt counter
cat /var/lib/substrate/recovery-attempts

# Recent logs
sudo journalctl -u substrate -u substrate-recovery -n 100
```

### Metrics

Track recovery effectiveness:
- Number of recovery attempts per week
- Success rate (recoveries / attempts)
- Time to recovery (backoff + diagnostic time)
- Common failure patterns from emails

## Limitations

- **Max 3 attempts**: After 3 failures, manual intervention required
- **5-minute timeout**: Claude must complete diagnosis within 5 minutes
- **No parallel recovery**: Recovery attempts are sequential
- **Email dependency**: Relies on mail/sendmail being configured
- **Claude dependency**: Requires Claude CLI authenticated and on PATH

## Troubleshooting

See [`scripts/systemd/README.md`](../scripts/systemd/README.md) for:
- Installation issues
- Email configuration
- Path configuration
- Node.js version management
- Permission problems

## Maintenance

- **Daily**: Review recovery emails for patterns
- **Weekly**: Check attempt counter, should be 0
- **Monthly**: Review recovery logs for anomalies
- **Quarterly**: Test recovery mechanism manually

## Further Reading

- [Main README](../README.md) - General substrate documentation
- [Systemd Installation Guide](../scripts/systemd/README.md) - Detailed setup
- [Recovery Script](../scripts/recovery.sh) - Implementation details
