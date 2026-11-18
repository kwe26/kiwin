#!/bin/sh
# Build a Kiwin release: dist/Kiwin-<yyyymmdd>[.n]-x64-Linux.tar (KIWIN_VERSION=... to choose)
#
#   sudo ./Compile.sh              everything
#   sudo ./Compile.sh --no-system  reuse dist/.cache/system.img.zst from an earlier run
#
# The tar holds (already compressed, so the tar itself is not):
#   Setup.sh          installer: dependencies, /www/kiwin, systemd service
#   Upgrade.sh        upgrades an installed Kiwin (system-diff.ts is its helper)
#   kiwin.tar.zst     daemon, agent and the pre-built panel (production node_modules)
#   system.img.zst    the system image, shrunk to its data (caches and logs left out)
#   SHA256SUMS
# Never included: user.img (your data), state/ (keys, sockets), log.img.
#
# Needs root (the system image keeps file owners), bun, zstd, mkfs.ext4,
# e2fsck, resize2fs. The panel is built as the invoking user (SUDO_USER).
set -eu

ROOT=$(cd "$(dirname "$0")" && pwd)
DIST="$ROOT/dist"
# Another build on the same day becomes <date>.1, .2, ...: the updater compares these.
VERSION=$(date +%Y%m%d)
if ls "$ROOT/dist/Kiwin-$VERSION-x64-Linux.tar" "$ROOT/dist/Kiwin-$VERSION".*-x64-Linux.tar >/dev/null 2>&1; then
  N=1
  while [ -e "$ROOT/dist/Kiwin-$VERSION.$N-x64-Linux.tar" ]; do N=$((N + 1)); done
  VERSION="$VERSION.$N"
fi
VERSION=${KIWIN_VERSION:-$VERSION}
NAME="Kiwin-$VERSION-x64-Linux"
ZSTD_LEVEL=${ZSTD_LEVEL:-19}
BUILD_SYSTEM=1
[ "${1:-}" = "--no-system" ] && BUILD_SYSTEM=0

[ "$(id -u)" = 0 ] || { echo "run as root: sudo $0 $*" >&2; exit 1; }
for t in bun zstd tar mkfs.ext4 e2fsck resize2fs truncate sha256sum losetup find; do
  command -v "$t" >/dev/null || { echo "missing $t" >&2; exit 1; }
done
[ "$(uname -m)" = x86_64 ] || { echo "builds x64 releases only (this is $(uname -m))" >&2; exit 1; }

# Run as the invoking user where root isn't needed (builds, dependency installs).
as_user() {
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then sudo -u "$SUDO_USER" -H "$@"; else "$@"; fi
}

mkdir -p "$DIST/.cache"
WORK=$(mktemp -d "$DIST/.work.XXXXXX")
# mktemp makes it root-only; the dependency installs run as the invoking user inside it.
chmod 755 "$WORK"
cleanup() {
  for m in "$WORK/src" "$WORK/check"; do mountpoint -q "$m" 2>/dev/null && umount "$m"; done
  # Never leave kiwin stopped because the build failed half way.
  [ "${RESTART_KIWIN:-0}" = 1 ] && systemctl start kiwin
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM
step() { printf '\n==> %s\n' "$*"; }

# ---- 1. Panel -----------------------------------------------------------------
step "Building the panel (kiwi)"
(cd "$ROOT/kiwi" && as_user bun install --frozen-lockfile && as_user bun run build)

# ---- 2. Code + production dependencies --------------------------------------------
step "Staging code with production dependencies"
APP="$WORK/app"
mkdir -p "$APP/kiwi"
# What runs: the daemon and agent (src/, kiwin.ts), defaults, deploy files, the image tool.
tar -C "$ROOT" -cf - kiwin kiwin.ts package.json bun.lock compile.sh README.md src defaults deploy | tar -C "$APP" -xf -
cp "$ROOT/kiwin.json" "$APP/kiwin.json.default"
echo "$VERSION" > "$APP/VERSION"
# The panel: sources Next needs at runtime plus the build, without its cache.
tar -C "$ROOT/kiwi" --exclude=./.next/cache --exclude=./node_modules -cf - . | tar -C "$APP/kiwi" -xf -
chown -R "${SUDO_USER:-root}" "$APP"
(cd "$APP" && as_user bun install --production --frozen-lockfile)
(cd "$APP/kiwi" && as_user bun install --production --frozen-lockfile)
chown -R root:root "$APP"

step "Compressing code (zstd -$ZSTD_LEVEL)"
tar -C "$APP" -cf - . | zstd -q -T0 -"$ZSTD_LEVEL" --long=27 -o "$WORK/kiwin.tar.zst"

# ---- 3. System image ------------------------------------------------------------
# Built from the files, never by copying a live image file: a filesystem copied
# block-by-block while mounted read-write is what ends up corrupted.
if [ $BUILD_SYSTEM = 1 ]; then
  IMG="$ROOT/images/system.img"
  mkdir "$WORK/src" "$WORK/rootfs"
  if [ -f "$IMG" ]; then
    # The image is the system's source of truth. Stop kiwin for a moment so it is
    # unmounted and consistent, check it, and read it through a read-only mount.
    if systemctl is-active --quiet kiwin 2>/dev/null; then
      step "Stopping kiwin while the system image is copied (it starts again right after)"
      systemctl stop kiwin
      RESTART_KIWIN=1
    fi
    if losetup -j "$IMG" | grep -q .; then
      echo "$IMG is still mounted (kiwin running outside systemd?); stop it and try again" >&2
      exit 1
    fi
    step "Checking $IMG"
    rc=0; e2fsck -fy "$IMG" >"$WORK/e2fsck.log" 2>&1 || rc=$?
    [ $rc -le 1 ] || { cat "$WORK/e2fsck.log" >&2; echo "e2fsck found errors it could not fix in $IMG (exit $rc)" >&2; exit 1; }
    mount -o ro,loop "$IMG" "$WORK/src"
    SRC_DESC=$IMG
  else
    [ -d "$ROOT/system/usr/bin" ] || { echo "$ROOT/system does not look like a rootfs" >&2; exit 1; }
    # A non-recursive bind leaves out whatever is mounted below system/.
    mount --bind "$ROOT/system" "$WORK/src"
    mount -o remount,bind,ro "$WORK/src"
    SRC_DESC=$ROOT/system
  fi

  step "Copying the system from $SRC_DESC (without caches, logs, /www)"
  tar -C "$WORK/src" --numeric-owner --xattrs --acls --sparse \
    --exclude=./www/* --exclude=./run/* --exclude=./tmp/* --exclude=./var/tmp/* \
    --exclude=./var/log/* --exclude=./var/cache/apt/* --exclude=./var/lib/apt/lists/* \
    --exclude=./var/cache/man/* --exclude=./var/cache/fontconfig/* \
    --exclude=./root/.cache --exclude=./root/.bun/install/cache --exclude=./root/.npm \
    --exclude=./lost+found \
    -cpf - . | tar -C "$WORK/rootfs" --numeric-owner --xattrs --acls -xpf -
  umount "$WORK/src"
  if [ "${RESTART_KIWIN:-0}" = 1 ]; then
    step "Starting kiwin again"
    systemctl start kiwin
    RESTART_KIWIN=0
  fi
  mkdir -p "$WORK/rootfs/www"
  FILES=$(find "$WORK/rootfs" -xdev | wc -l)

  step "Making the filesystem ($FILES files)"
  # Room for the data and enough inodes for every file, with headroom; shrunk to fit afterwards.
  SIZE_KB=$(du -sk "$WORK/rootfs" | cut -f1)
  truncate -s "$(( SIZE_KB * 13 / 10 + 524288 ))K" "$WORK/system.img"
  mkfs.ext4 -q -F -L kiwin-system -m 0 -N "$(( FILES * 13 / 10 + 20000 ))" -E root_owner=0:0 -d "$WORK/rootfs" "$WORK/system.img"
  rm -rf "$WORK/rootfs"
  e2fsck -fn "$WORK/system.img" >"$WORK/e2fsck.log" 2>&1 || { cat "$WORK/e2fsck.log" >&2; echo "the new image failed e2fsck" >&2; exit 1; }
  resize2fs -M "$WORK/system.img" >"$WORK/resize.log" 2>&1 || { cat "$WORK/resize.log" >&2; echo "shrinking the image failed" >&2; exit 1; }
  e2fsck -fn "$WORK/system.img" >"$WORK/e2fsck.log" 2>&1 || { cat "$WORK/e2fsck.log" >&2; echo "the shrunk image failed e2fsck" >&2; exit 1; }

  step "Compressing system.img (zstd -$ZSTD_LEVEL)"
  # A 128 MB window (--long=27) keeps unpacking light enough for small servers.
  zstd -q -T0 -"$ZSTD_LEVEL" --long=27 --rm "$WORK/system.img" -o "$WORK/system.img.zst"

  step "Verifying system.img.zst the way the installer unpacks it"
  zstd -q -t "$WORK/system.img.zst"
  zstd -q -d -f --long=31 --sparse "$WORK/system.img.zst" -o "$WORK/check.img"
  e2fsck -fn "$WORK/check.img" >"$WORK/e2fsck.log" 2>&1 || { cat "$WORK/e2fsck.log" >&2; echo "the compressed image does not unpack to a clean filesystem" >&2; exit 1; }
  mkdir "$WORK/check"
  mount -o ro,loop "$WORK/check.img" "$WORK/check"
  GOT=$(find "$WORK/check" -xdev | wc -l)
  umount "$WORK/check"
  rm -f "$WORK/check.img"
  # The new filesystem adds lost+found (and its root entry counts in both).
  [ "$GOT" -ge "$FILES" ] || { echo "the image holds $GOT entries, the system had $FILES" >&2; exit 1; }
  echo "ok: clean filesystem, $GOT entries"
  mv "$WORK/system.img.zst" "$DIST/.cache/system.img.zst"
fi
[ -f "$DIST/.cache/system.img.zst" ] || { echo "no system image: run without --no-system first" >&2; exit 1; }

# ---- 4. Release tar -----------------------------------------------------------------
step "Packing $NAME.tar"
REL="$WORK/$NAME"
mkdir -p "$REL"
mv "$WORK/kiwin.tar.zst" "$REL/"
cp "$DIST/.cache/system.img.zst" "$REL/"
install -m 0755 "$ROOT/deploy/Setup.sh" "$REL/Setup.sh"
install -m 0755 "$ROOT/deploy/Upgrade.sh" "$REL/Upgrade.sh"
install -m 0644 "$ROOT/deploy/system-diff.ts" "$REL/system-diff.ts"
(cd "$REL" && sha256sum kiwin.tar.zst system.img.zst Setup.sh Upgrade.sh system-diff.ts > SHA256SUMS)
tar -C "$WORK" -cf "$DIST/$NAME.tar" "$NAME"
[ -n "${SUDO_USER:-}" ] && chown "$SUDO_USER" "$DIST/$NAME.tar"

echo
echo "$DIST/$NAME.tar ($(du -h "$DIST/$NAME.tar" | cut -f1))"
echo "  code:   $(du -h "$REL/kiwin.tar.zst" | cut -f1)"
echo "  system: $(du -h "$REL/system.img.zst" | cut -f1)"
echo "Install or upgrade a server: tar -xf $NAME.tar && sudo ./$NAME/Setup.sh"
