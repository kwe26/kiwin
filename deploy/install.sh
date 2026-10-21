#!/bin/sh
# Install kiwin as a systemd service. Run as root: sudo ./deploy/install.sh
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LIB=/usr/local/lib/kiwin

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
command -v bwrap >/dev/null || { echo "bubblewrap (bwrap) is required" >&2; exit 1; }

# Root-owned bun for the host daemon. Never run the copy in system/ directly:
# root inside the isolation can modify it.
mkdir -p "$LIB"
BUN_SRC=${BUN:-$(command -v bun || echo "$ROOT/system/usr/bin/bun")}
install -m 0755 "$BUN_SRC" "$LIB/bun"

# Unit definitions inside the isolation (only seeded on first install).
if [ ! -e "$ROOT/system/etc/isol" ]; then
  mkdir -p "$ROOT/system/etc/isol"
  cp "$ROOT"/defaults/etc/isol/*.json "$ROOT/system/etc/isol/"
fi
mkdir -p "$ROOT/state"
chmod 700 "$ROOT/state"

(cd "$ROOT" && "$LIB/bun" install --production --frozen-lockfile 2>/dev/null || "$LIB/bun" install --production)

sed -e "s#@ROOT@#$ROOT#g" -e "s#@BUN@#$LIB/bun#g" "$ROOT/deploy/kiwin.service" > /etc/systemd/system/kiwin.service
cat > /usr/local/bin/kiwin <<SH
#!/bin/sh
exec $LIB/bun $ROOT/kiwin.ts "\$@"
SH
chmod 755 /usr/local/bin/kiwin

systemctl daemon-reload
systemctl enable --now kiwin.service
echo "kiwin installed. Try: kiwin status"
