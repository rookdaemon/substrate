# Systemd Quick Reference

This is a quick reference for common systemd operations with Substrate.

## Installation

```bash
# 1. Build substrate
cd ~/substrate
npm install
cd server && npm run build

# 2. Copy service files
mkdir -p ~/.config/systemd/user
cp ~/substrate/systemd/substrate.service ~/.config/systemd/user/substrate@.service
cp ~/substrate/systemd/substrate-recovery.service ~/.config/systemd/user/substrate-recovery@.service

# 3. Configure environment (optional)
mkdir -p ~/.config/systemd/user/substrate@.service.d
cat > ~/.config/systemd/user/substrate@.service.d/override.conf <<'EOF'
[Service]
Environment="SUBSTRATE_ADMIN_EMAIL=your@email.com"
Environment="PATH=/usr/bin:/usr/local/bin:$HOME/.nvm/versions/node/v20.11.1/bin"
EOF

# 4. Reload and start
systemctl --user daemon-reload
systemctl --user start substrate@$(whoami).service
systemctl --user enable substrate@$(whoami).service
```

## Common Commands

```bash
# Status
systemctl --user status substrate@$(whoami).service

# Start/Stop/Restart
systemctl --user start substrate@$(whoami).service
systemctl --user stop substrate@$(whoami).service
systemctl --user restart substrate@$(whoami).service

# Logs (follow)
journalctl --user -u substrate@$(whoami).service -f

# Logs (last 100 lines)
journalctl --user -u substrate@$(whoami).service -n 100

# Recovery logs
journalctl --user -u substrate-recovery@$(whoami).service -f

# Check recovery attempts
cat /tmp/substrate-recovery-attempts
```

## Troubleshooting

```bash
# Reset recovery counter
rm -f /tmp/substrate-recovery-attempts

# Test recovery manually
bash -x ~/substrate/systemd/substrate-recovery.sh

# Check service configuration
systemctl --user cat substrate@$(whoami).service

# Check service state
systemctl --user show substrate@$(whoami).service

# Force immediate recovery test
systemctl --user stop substrate@$(whoami).service
systemctl --user start substrate-recovery@$(whoami).service
```

## Enable User Lingering

To run services when not logged in:
```bash
sudo loginctl enable-linger $(whoami)
```

## Full Documentation

See [docs/systemd-deployment.md](../docs/systemd-deployment.md) for complete guide.
