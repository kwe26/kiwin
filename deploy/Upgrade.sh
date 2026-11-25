#!/bin/sh
# Upgrade an installed Kiwin from this release (Kiwin-<date>-x64-Linux.tar).
#
#   sudo ./Upgrade.sh              upgrade /www/kiwin
#   sudo ./Upgrade.sh --rollback   go back to what the last upgrade replaced
#
# Kept: kiwin.json, state/ (keys), images/user.img (all your data).
# When the release has a new system image, what you added to the old one moves
# over: packages you installed (reinstalled with apt from your own sources),
# config files you edited and units you added in /etc/isol.
# The old code stays in .previous/ and the old image in images/system.img.old.
# If Kiwin doesn't come back up, the upgrade is rolled back automatically.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
DEST=/www/kiwin
LIB=/usr/local/lib/kiwin
PREV="$DEST/.previous"
IMG="$DEST/images/system.img"
STAMP="$DEST/images/system.img.release"
PORT=8888
CODE="src kiwi node_modules defaults deploy kiwin kiwin.ts package.json bun.lock compile.sh README.md kiwin.json.default VERSION"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root: sudo $0"
[ -f "$DEST/kiwin.ts" ] || die "no Kiwin in $DEST: run Setup.sh to install it"
command -v systemctl >/dev/null || die "systemd is required"

stop_kiwin() {
  systemctl stop kiwin 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    losetup -j "$IMG" 2>/dev/null | grep -q . || return 0
    sleep 1
  done
  die "$IMG is still mounted (is kiwin running outside systemd?); stop it and try again"
}

wait_healthy() {
  i=0
  while [ $i -lt 240 ]; do
    if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; then
      # /recovery answers on the same port. Only a missing swap file is fine:
      # any other reason means this version can't run the system.
      CODE_NOW=$(curl -s --max-time 2 "http://127.0.0.1:$PORT/recovery/ping" | sed -n 's/.*"code":"\([a-z]*\)".*/\1/p')
      case "$CODE_NOW" in ""|swap) return 0 ;; esac
    fi
    systemctl is-active --quiet kiwin || return 1
    i=$((i + 2)); sleep 2
  done
  return 1
}

# Put back the code in .previous/ and, if it was replaced, the old system image.
restore() {
  [ -d "$PREV" ] || die "nothing to roll back to ($PREV is missing)"
  for f in $CODE; do rm -rf "${DEST:?}/$f"; done
  for f in "$PREV"/* "$PREV"/.[!.]*; do
    [ -e "$f" ] || continue
    case "$(basename "$f")" in
      system.img.release) mv -f "$f" "$STAMP" ;;
      *) mv -f "$f" "$DEST/" ;;
    esac
  done
  rmdir "$PREV" 2>/dev/null || true
  # A leftover newer .zst would make the daemon unpack the release we just left.
  rm -f "$IMG.zst"
  if [ -f "$IMG.old" ]; then mv -f "$IMG.old" "$IMG"; fi
}

if [ "${1:-}" = "--rollback" ]; then
  [ -d "$PREV" ] || die "nothing to roll back to ($PREV is missing)"
  say "Rolling back"
  stop_kiwin
  restore
  systemctl start kiwin
  wait_healthy && echo "Rolled back; Kiwin is running." || die "Kiwin did not come back up: journalctl -u kiwin"
  exit 0
fi

[ -f "$HERE/kiwin.tar.zst" ] && [ -f "$HERE/system.img.zst" ] || die "kiwin.tar.zst / system.img.zst missing next to Upgrade.sh"
for t in zstd tar curl e2fsck resize2fs losetup mount chroot sha256sum; do
  command -v "$t" >/dev/null || die "missing $t"
done
BUN=$LIB/bun
[ -x "$BUN" ] || BUN=$(command -v bun 2>/dev/null) || die "bun is missing"

say "Checking the release files"
(cd "$HERE" && sha256sum -c --quiet SHA256SUMS) || die "checksums don't match: the download is damaged"

NEW_SUM=$(sha256sum "$HERE/system.img.zst" | cut -d' ' -f1)
OLD_SUM=$(cat "$STAMP" 2>/dev/null || echo)
NEW_IMAGE=1
[ "$NEW_SUM" = "$OLD_SUM" ] && NEW_IMAGE=0
FROM=$(cat "$DEST/VERSION" 2>/dev/null || echo unknown)
TO=$(zstd -dc "$HERE/kiwin.tar.zst" | tar -xOf - ./VERSION 2>/dev/null || echo unknown)
echo "Installed: $FROM -> release: $TO ($([ $NEW_IMAGE = 1 ] && echo 'new system image' || echo 'same system image, code only'))"

# Unpacking needs room for the image; the old one stays until the next upgrade.
FREE_KB=$(df -Pk "$DEST" | awk 'NR == 2 {print $4}')
NEED_KB=$(( $(stat -c %s "$HERE/kiwin.tar.zst") / 1024 * 8 ))
[ $NEW_IMAGE = 1 ] && NEED_KB=$(( NEED_KB + $(stat -c %s "$HERE/system.img.zst") / 1024 * 6 ))
[ "$FREE_KB" -gt "$NEED_KB" ] || die "not enough free disk space ($(( FREE_KB / 1024 )) MB free, about $(( NEED_KB / 1024 )) MB needed)"

WORK=$(mktemp -d "$DEST/.upgrade.XXXXXX")
PHASE=before
cleanup() {
  rc=$?
  trap - EXIT INT TERM
  for m in "$WORK/new/dev" "$WORK/new/proc" "$WORK/new/sys" "$WORK/new" "$WORK/old"; do
    mountpoint -q "$m" 2>/dev/null && umount -l "$m"
  done
  rm -rf "$WORK"
  if [ "$PHASE" = swapped ] && [ $rc != 0 ]; then
    printf '\nThe upgrade failed: going back to the previous version.\n' >&2
    stop_kiwin || true
    restore
    systemctl start kiwin || true
  elif [ "$PHASE" = stopped ]; then
    systemctl start kiwin || true
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

say "Stopping Kiwin"
stop_kiwin
PHASE=stopped

# ---- Code -------------------------------------------------------------------------
say "Installing the new code"
rm -rf "$PREV" "$IMG.old"
mkdir -p "$PREV"
for f in $CODE; do
  if [ -e "$DEST/$f" ]; then mv "$DEST/$f" "$PREV/"; fi
done
[ -f "$STAMP" ] && cp -p "$STAMP" "$PREV/system.img.release"
PHASE=swapped
zstd -dc "$HERE/kiwin.tar.zst" | tar -C "$DEST" --no-same-owner -xf -
[ -f "$DEST/kiwin.json" ] || cp "$DEST/kiwin.json.default" "$DEST/kiwin.json"
# Refresh the root-owned bun copy. On NixOS bun is a read-only /nix/store path
# declared in configuration.nix and $LIB may not exist: not having a copy is
# fine there, so a failure here must not abort the upgrade.
if [ -d "$LIB" ] && [ -x "$(command -v bun)" ]; then
  install -m 0755 "$(readlink -f "$(command -v bun)")" "$LIB/bun" || echo "could not refresh $LIB/bun; keeping the old one" >&2
fi

# ---- System image -------------------------------------------------------------------
if [ $NEW_IMAGE = 1 ]; then
  say "Unpacking the new system image"
  rc=0; e2fsck -fy "$IMG" >"$WORK/e2fsck.log" 2>&1 || rc=$?
  [ $rc -le 1 ] || { cat "$WORK/e2fsck.log" >&2; die "e2fsck found errors it could not fix in $IMG"; }
  cp "$HERE/system.img.zst" "$IMG.zst"
  "$DEST/compile.sh" unpack system --size 1T --force

  say "Comparing the old and new system"
  mkdir "$WORK/old" "$WORK/new"
  mount -o ro,loop "$IMG.old" "$WORK/old"
  mount -o loop "$IMG" "$WORK/new"
  "$BUN" "$HERE/system-diff.ts" packages "$WORK/old" "$WORK/new" > "$WORK/packages"
  N=$(wc -l < "$WORK/packages")

  FAILED=""
  if [ "$N" -gt 0 ]; then
    say "Reinstalling $N package(s) you added: $(tr '\n' ' ' < "$WORK/packages")"
    R="$WORK/new"
    # Your sources and keys, so packages from extra repositories are found.
    for d in sources.list sources.list.d trusted.gpg.d keyrings; do
      if [ -e "$WORK/old/etc/apt/$d" ]; then
        rm -rf "${R:?}/etc/apt/$d"
        cp -a "$WORK/old/etc/apt/$d" "$R/etc/apt/$d"
      fi
    done
    mount --bind /dev "$R/dev"
    mount --bind /proc "$R/proc"
    mount --bind /sys "$R/sys"
    cp "$R/etc/resolv.conf" "$WORK/resolv.conf" 2>/dev/null || : > "$WORK/resolv.conf"
    rm -f "$R/etc/resolv.conf"
    cp -L /etc/resolv.conf "$R/etc/resolv.conf"
    # Maintainer scripts must not try to start services in a chroot.
    printf '#!/bin/sh\nexit 101\n' > "$R/usr/sbin/policy-rc.d"
    chmod 755 "$R/usr/sbin/policy-rc.d"

    apt_in() { DEBIAN_FRONTEND=noninteractive chroot "$R" /usr/bin/apt-get -y -q "$@"; }
    apt_in update || echo "apt-get update reported problems; trying anyway" >&2
    # shellcheck disable=SC2046
    if ! apt_in install --no-install-recommends $(cat "$WORK/packages"); then
      # One bad package must not cost the others.
      for p in $(cat "$WORK/packages"); do
        apt_in install --no-install-recommends "$p" || FAILED="$FAILED $p"
      done
    fi
    apt_in clean || true
    rm -rf "$R/var/lib/apt/lists"/* || true
    rm -f "$R/usr/sbin/policy-rc.d" "$R/etc/resolv.conf"
    cp "$WORK/resolv.conf" "$R/etc/resolv.conf"
    umount "$R/dev" "$R/proc" "$R/sys"
  else
    echo "No added packages to reinstall."
  fi

  say "Carrying over edited config files and units"
  "$BUN" "$HERE/system-diff.ts" carry "$WORK/old" "$WORK/new" | tee "$WORK/carried"
  umount "$WORK/new" "$WORK/old"
  rc=0; e2fsck -fy "$IMG" >"$WORK/e2fsck.log" 2>&1 || rc=$?
  [ $rc -le 1 ] || { cat "$WORK/e2fsck.log" >&2; die "the upgraded image failed e2fsck"; }
  # Newer than the .zst, so the daemon doesn't unpack over it.
  touch "$IMG"
  echo "$NEW_SUM" > "$STAMP"
fi

# ---- Service --------------------------------------------------------------------------
# On NixOS the unit comes from configuration.nix and /etc/systemd/system is a
# read-only store symlink, so this step is skipped and the declared unit stands.
if [ -w /etc/systemd/system ] && [ -f "$DEST/deploy/kiwin.service" ] && [ -x "$LIB/bun" ]; then
  sed -e "s#@ROOT@#$DEST#g" -e "s#@BUN@#$LIB/bun#g" "$DEST/deploy/kiwin.service" > /etc/systemd/system/kiwin.service
  systemctl daemon-reload
fi

say "Starting Kiwin"
systemctl start kiwin
wait_healthy || { journalctl -u kiwin -n 30 --no-pager >&2 || true; die "Kiwin did not come back up"; }
PHASE=done

echo
echo "Kiwin is upgraded: $FROM -> $TO"
[ -n "${FAILED:-}" ] && echo "Could not reinstall:$FAILED (install them again from the host: sudo chroot /www/kiwin/system apt-get install ...)"
[ -s "${WORK}/carried" ] && echo "Your edits were carried over; check them against the new versions: $(tr '\n' ' ' < "$WORK/carried")"
echo "To go back: sudo $0 --rollback"
