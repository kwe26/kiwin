#!/bin/sh
# Install kiwin as a systemd service. Run as root: sudo ./deploy/install.sh
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LIB=/usr/local/lib/kiwin

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
command -v bwrap >/dev/null || { echo "bubblewrap (bwrap) is required" >&2; exit 1; }

# NixOS: /etc/systemd/system is a read-only store symlink and /usr/local is not
# on PATH, so the unit and the `kiwin` wrapper belong in configuration.nix.
NIXOS=0
if [ -e /etc/NIXOS ]; then NIXOS=1; fi

# Root-owned bun for the host daemon. Never run the copy in system/ directly:
# root inside the isolation can modify it. On NixOS bun already sits read-only
# in /nix/store, so it is used from there and nothing is copied.
BUN_SRC=${BUN:-$(command -v bun || echo "$ROOT/system/usr/bin/bun")}
BUN=$BUN_SRC
if [ "$NIXOS" = 0 ]; then
  mkdir -p "$LIB"
  install -m 0755 "$BUN_SRC" "$LIB/bun"
  BUN=$LIB/bun
fi

# Unit definitions inside the isolation (only seeded on first install).
if [ ! -e "$ROOT/system/etc/isol" ]; then
  mkdir -p "$ROOT/system/etc/isol"
  cp "$ROOT"/defaults/etc/isol/*.json "$ROOT/system/etc/isol/"
fi
mkdir -p "$ROOT/state"
chmod 700 "$ROOT/state"

(cd "$ROOT" && "$BUN" install --production --frozen-lockfile 2>/dev/null || "$BUN" install --production)

if [ "$NIXOS" = 1 ]; then
  cat <<NIX
Files are ready. NixOS declares its services, so add this to configuration.nix
and run nixos-rebuild switch (deploy/Setup.sh prints the full snippet):

  systemd.services.kiwin = {
    wantedBy = [ "multi-user.target" ];
    path = with pkgs; [ bubblewrap zstd e2fsprogs util-linux nftables openssh coreutils gnutar gzip curl ];
    serviceConfig = {
      WorkingDirectory = "$ROOT";
      ExecStart = "$BUN $ROOT/kiwin.ts daemon";
      Restart = "always"; RestartSec = 3; KillMode = "mixed"; TimeoutStopSec = 60;
    };
  };

Until then: sudo $ROOT/kiwin daemon   (CLI: sudo $ROOT/kiwin status)
NIX
  exit 0
fi

sed -e "s#@ROOT@#$ROOT#g" -e "s#@BUN@#$BUN#g" "$ROOT/deploy/kiwin.service" > /etc/systemd/system/kiwin.service
mkdir -p /usr/local/bin
cat > /usr/local/bin/kiwin <<SH
#!/bin/sh
exec $BUN $ROOT/kiwin.ts "\$@"
SH
chmod 755 /usr/local/bin/kiwin

systemctl daemon-reload
systemctl enable --now kiwin.service
echo "kiwin installed. Try: kiwin status"
