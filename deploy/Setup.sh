#!/bin/sh
# Kiwin installer, shipped inside Kiwin-<date>-x64-Linux.tar (built by Compile.sh).
#
#   tar -xf Kiwin-*-x64-Linux.tar && sudo ./Kiwin-*-x64-Linux/Setup.sh
#
# Installs the dependencies (bubblewrap, zstd, e2fsprogs, util-linux,
# nftables, bun), puts Kiwin in /www/kiwin, sets up and starts the systemd
# service, and tells you where the panel is. On a machine that already has
# Kiwin it hands over to Upgrade.sh, which keeps your data and settings.
#
# Ubuntu/Debian and Fedora are set up automatically. On NixOS packages and
# services are declared in configuration.nix, so this prints what to add.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
DEST=/www/kiwin
LIB=/usr/local/lib/kiwin
PORT=8888

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root: sudo $0"
[ "$(uname -m)" = x86_64 ] || die "this release is for x86-64 (this machine is $(uname -m))"
[ -f "$HERE/kiwin.tar.zst" ] && [ -f "$HERE/system.img.zst" ] || die "kiwin.tar.zst / system.img.zst missing next to Setup.sh"

if [ -f "$DEST/kiwin.ts" ] && [ -x "$HERE/Upgrade.sh" ]; then
  echo "Kiwin is already installed in $DEST: upgrading it."
  exec "$HERE/Upgrade.sh"
fi

. /etc/os-release
DISTRO="${ID:-unknown} ${ID_LIKE:-}"

# ---- Verify the release -----------------------------------------------------------
if command -v sha256sum >/dev/null && [ -f "$HERE/SHA256SUMS" ]; then
  say "Checking the release files"
  (cd "$HERE" && sha256sum -c --quiet SHA256SUMS) || die "checksums don't match: the download is damaged"
fi

# ---- Dependencies -------------------------------------------------------------------
NEED="bwrap zstd tar mkfs.ext4 e2fsck resize2fs losetup mount nsenter setpriv truncate curl unzip"

nixos_help() {
  cat <<'NIX'

NixOS manages packages and services declaratively. Add this to
/etc/nixos/configuration.nix, run `sudo nixos-rebuild switch`, then run
Setup.sh again (it will install the files and skip this step):

  environment.systemPackages = with pkgs; [ bun bubblewrap zstd e2fsprogs util-linux nftables ];
  networking.firewall.allowedTCPPorts = [ 8888 2222 80 443 ];
  systemd.services.kiwin = {
    description = "Kiwin (bwrap isolation, panel, SSH)";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    path = with pkgs; [ bubblewrap zstd e2fsprogs util-linux nftables coreutils gnutar gzip ];
    serviceConfig = {
      WorkingDirectory = "/www/kiwin";
      ExecStart = "${pkgs.bun}/bin/bun /www/kiwin/kiwin.ts daemon";
      Restart = "always";
      RestartSec = 3;
      KillMode = "mixed";
      TimeoutStopSec = 60;
      LimitNOFILE = 65536;
    };
  };
NIX
}

missing() {
  m=""
  for t in $NEED; do command -v "$t" >/dev/null || m="$m $t"; done
  echo "$m"
}

say "Installing dependencies ($PRETTY_NAME)"
case " $DISTRO " in
  *" nixos "*)
    IS_NIXOS=1
    ;;
  *" ubuntu "*|*" debian "*)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -q
    apt-get install -y -q bubblewrap zstd e2fsprogs util-linux mount nftables curl unzip ca-certificates tar
    ;;
  *" fedora "*|*" rhel "*|*" centos "*)
    dnf install -y bubblewrap zstd e2fsprogs util-linux nftables curl unzip ca-certificates tar
    ;;
  *)
    echo "Unknown distribution ($DISTRO): checking for the tools instead of installing them."
    ;;
esac
IS_NIXOS=${IS_NIXOS:-0}

MISSING=$(missing)
if [ -n "$MISSING" ]; then
  [ "$IS_NIXOS" = 1 ] && { echo "Missing:$MISSING"; nixos_help; exit 1; }
  die "missing tools:$MISSING. Install them with your package manager and run Setup.sh again."
fi

# ---- Bun ------------------------------------------------------------------------------
if ! command -v bun >/dev/null; then
  [ "$IS_NIXOS" = 1 ] && { echo "bun is missing."; nixos_help; exit 1; }
  say "Installing Bun (bun.sh) to /usr/local"
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
  command -v bun >/dev/null || die "Bun did not install; see https://bun.sh"
fi
BUN_SRC=$(readlink -f "$(command -v bun)")
echo "bun $(bun --version) at $BUN_SRC"

# ---- Files ------------------------------------------------------------------------------
UPGRADE=0
[ -f "$DEST/kiwin.ts" ] && UPGRADE=1
if [ "$IS_NIXOS" = 0 ] && systemctl is-active --quiet kiwin 2>/dev/null; then
  say "Stopping the running Kiwin"
  systemctl stop kiwin
fi

say "Installing Kiwin to $DEST$( [ $UPGRADE = 1 ] && echo ' (upgrade: settings, keys and your data are kept)')"
mkdir -p "$DEST/images"
# Replace the code wholesale so removed files don't linger; never touch
# kiwin.json, state/, images/user.img*, images/log.img* or system/.
rm -rf "$DEST/src" "$DEST/kiwi" "$DEST/node_modules" "$DEST/defaults" "$DEST/deploy"
zstd -dc "$HERE/kiwin.tar.zst" | tar -C "$DEST" --no-same-owner -xf -
[ -f "$DEST/kiwin.json" ] || cp "$DEST/kiwin.json.default" "$DEST/kiwin.json"
mkdir -p "$DEST/state" "$DEST/system"
chmod 700 "$DEST/state"
# The daemon unpacks a system.img.zst that is newer than system.img on start
# (the previous image is kept as images/system.img.old).
cp "$HERE/system.img.zst" "$DEST/images/system.img.zst.tmp"
mv "$DEST/images/system.img.zst.tmp" "$DEST/images/system.img.zst"
touch "$DEST/images/system.img.zst"
sha256sum "$HERE/system.img.zst" | cut -d' ' -f1 > "$DEST/images/system.img.release"
chown -R root:root "$DEST/src" "$DEST/kiwi" "$DEST/kiwin.ts" "$DEST/images/system.img.zst"

# Root-owned bun for the host daemon (never the one inside the system image,
# which root inside the isolation could change).
mkdir -p "$LIB"
install -m 0755 "$BUN_SRC" "$LIB/bun"

cat > /usr/local/bin/kiwin <<SH
#!/bin/sh
exec $LIB/bun $DEST/kiwin.ts "\$@"
SH
chmod 755 /usr/local/bin/kiwin

# ---- Service -----------------------------------------------------------------------------
if [ "$IS_NIXOS" = 1 ]; then
  say "Files are installed."
  echo "Declare the service in configuration.nix (if you haven't yet) and run nixos-rebuild switch:"
  nixos_help
  exit 0
fi

say "Setting up the systemd service"
sed -e "s#@ROOT@#$DEST#g" -e "s#@BUN@#$LIB/bun#g" "$DEST/deploy/kiwin.service" > /etc/systemd/system/kiwin.service
systemctl daemon-reload
systemctl enable --now kiwin.service

# First start unpacks system.img (a minute or two on slow disks).
say "Starting Kiwin (unpacking the system image on first start)"
i=0
while [ $i -lt 180 ]; do
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; then break; fi
  if ! systemctl is-active --quiet kiwin; then
    journalctl -u kiwin -n 30 --no-pager || true
    die "the kiwin service stopped; see the log above (journalctl -u kiwin)"
  fi
  i=$((i + 2)); sleep 2
done

CODE=$("$LIB/bun" "$DEST/kiwin.ts" setup-code 2>/dev/null || echo "run: sudo kiwin setup-code")
IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')
[ -n "$IP" ] || IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$IP" ] || IP="<this server's IP>"

cat <<DONE

Kiwin is running.

  Panel:   http://$IP:$PORT
           (first visit: create your storage and the admin account)
  Setup code: $CODE
           (the panel asks for it on that first visit, so nobody else can
            claim this server; see it again with: sudo kiwin setup-code)
  SSH:     ssh -p 2222 root@$IP   (into the isolation, once you add a key)
  Service: systemctl status kiwin    Logs: journalctl -u kiwin -f
  CLI:     kiwin status

No swap file yet? The system then waits at the panel address on a recovery
page: sign in with this server's root password and create it there.

If a firewall is on (ufw, firewalld, cloud security groups), allow TCP $PORT
for the panel, and 80/443 for websites.
DONE
case " $DISTRO " in
  *" fedora "*|*" rhel "*|*" centos "*)
    if command -v getenforce >/dev/null && [ "$(getenforce)" = Enforcing ]; then
      echo "SELinux is enforcing: if the isolation fails to start, check 'ausearch -m avc -ts recent'."
    fi
    ;;
esac
