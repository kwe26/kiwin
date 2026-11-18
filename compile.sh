#!/bin/sh
# Build, pack and unpack kiwin's images.
#
#   sudo ./compile.sh                  system/ -> images/system.img.zst
#   sudo ./compile.sh user             empty   -> images/user.img.zst
#   sudo ./compile.sh user --from DIR  DIR     -> images/user.img.zst
#   ./compile.sh pack [system|user]    images/<name>.img -> images/<name>.img.zst
#   ./compile.sh unpack [system|user]  images/<name>.img.zst -> images/<name>.img
#
# The .zst is the artifact you upload: the filesystem shrunk to its data, then
# compressed. The kiwin daemon unpacks it into a sparse --size ext4 image on
# start (system.img: when missing or older than the .zst; user.img: only when
# missing, it holds live data).
#
# Options:  --size SIZE   maximum image size when unpacked (default 1T); sparse,
#                         so it only uses the disk space its data needs
#           --force       unpack over an existing image (kept as <name>.img.old)
set -eu

ROOT=$(cd "$(dirname "$0")" && pwd)
IMAGES="$ROOT/images"
SIZE=1T
ACTION=build
TARGET=system
FROM=
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    pack|unpack) ACTION=$1 ;;
    system|user) TARGET=$1 ;;
    --size) SIZE=$2; shift ;;
    --from) FROM=$2; shift ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

need() {
  for t in "$@"; do
    command -v "$t" >/dev/null || { echo "missing $t" >&2; exit 1; }
  done
}
need mkfs.ext4 e2fsck resize2fs truncate zstd
mkdir -p "$IMAGES"
IMG="$IMAGES/$TARGET.img"

BUILD=$(mktemp -d "$IMAGES/.build.XXXXXX")
cleanup() {
  mountpoint -q "$BUILD/src" 2>/dev/null && umount "$BUILD/src"
  rm -rf "$BUILD"
}
trap cleanup EXIT INT TERM

# mkfs.ext4 -d copies a directory tree (ownership, modes, symlinks, devices,
# hardlinks, xattrs) straight into the new filesystem: no loop mount needed.
make_image() { # <out> <label> [srcdir]
  truncate -s "$SIZE" "$1"
  set -- "$1" "$2" "${3:-}"
  if [ -n "$3" ]; then
    mkfs.ext4 -q -F -L "$2" -m 0 -E lazy_itable_init=1,lazy_journal_init=1,root_owner=0:0 -d "$3" "$1"
  else
    mkfs.ext4 -q -F -L "$2" -m 0 -E lazy_itable_init=1,lazy_journal_init=1,root_owner=0:0 "$1"
  fi
}

is_mounted() { # <image>
  losetup -j "$1" 2>/dev/null | grep -q .
}

# fsck exit codes: 0 clean, 1 errors fixed; anything else needs a human.
fsck_fix() {
  rc=0
  e2fsck -fy "$1" >/dev/null 2>&1 || rc=$?
  [ $rc -le 1 ] || { echo "e2fsck $1 failed (exit $rc)" >&2; exit 1; }
}

# Shrink the filesystem in <img> to its data and compress it to <out.zst>.
# <img> is consumed.
compress_image() { # <img> <out.zst>
  fsck_fix "$1"
  resize2fs -M "$1" >/dev/null 2>&1
  zstd -q -f -T0 -10 --long=27 --rm "$1" -o "$BUILD/out.zst"
  mv -f "$BUILD/out.zst" "$2"
  echo "$2: $(du -h "$2" | cut -f1) (upload this; kiwin unpacks it on start)"
}

case "$ACTION" in
build)
  [ "$(id -u)" = 0 ] || { echo "run as root (file ownership must be preserved)" >&2; exit 1; }
  if [ "$TARGET" = system ]; then
    SRC="$ROOT/system"
    [ -d "$SRC/usr/bin" ] || { echo "$SRC does not look like a rootfs" >&2; exit 1; }
    # A non-recursive bind leaves out anything mounted below system/ (user.img
    # on system/www, a running isolation's mounts), so only the OS gets packed.
    mkdir "$BUILD/src"
    mount --bind "$SRC" "$BUILD/src"
    mount -o remount,bind,ro "$BUILD/src"
    echo "compiling $SRC -> $IMG.zst"
    make_image "$BUILD/build.img" kiwin-system "$BUILD/src"
    umount "$BUILD/src"
  else
    [ -z "$FROM" ] || [ -d "$FROM" ] || { echo "--from $FROM is not a directory" >&2; exit 1; }
    echo "creating $IMG.zst${FROM:+ from $FROM}"
    make_image "$BUILD/build.img" kiwin-user "$FROM"
  fi
  compress_image "$BUILD/build.img" "$IMG.zst"
  ;;

pack)
  [ -f "$IMG" ] || { echo "$IMG not found" >&2; exit 1; }
  if is_mounted "$IMG" && [ $FORCE = 0 ]; then
    echo "$IMG is mounted; stop kiwin first for a consistent copy (or --force)" >&2
    exit 1
  fi
  # Work on a sparse copy so the original image stays untouched.
  echo "packing $IMG -> $IMG.zst"
  cp --sparse=always "$IMG" "$BUILD/pack.img"
  compress_image "$BUILD/pack.img" "$IMG.zst"
  ;;

unpack)
  [ -f "$IMG.zst" ] || { echo "$IMG.zst not found" >&2; exit 1; }
  if [ -e "$IMG" ] && [ $FORCE = 0 ]; then
    echo "$IMG already exists; pass --force to replace it" >&2
    exit 1
  fi
  is_mounted "$IMG" && { echo "$IMG is mounted; stop kiwin first" >&2; exit 1; }
  echo "unpacking $IMG.zst -> $IMG (max $SIZE)"
  # --long=31 only raises the limit: memory use follows the window the file was made with.
  zstd -q -d -f --long=31 --sparse "$IMG.zst" -o "$BUILD/unpack.img"
  truncate -s ">$SIZE" "$BUILD/unpack.img" # grow only, never cut the filesystem
  fsck_fix "$BUILD/unpack.img"
  resize2fs "$BUILD/unpack.img" >/dev/null 2>&1
  e2fsck -fn "$BUILD/unpack.img" >/dev/null 2>&1 || { echo "unpacked image failed e2fsck" >&2; exit 1; }
  if [ -e "$IMG" ]; then
    mv -f "$IMG" "$IMG.old"
    echo "previous image kept as $IMG.old"
  fi
  mv -f "$BUILD/unpack.img" "$IMG"
  echo "$IMG: $(du -h --apparent-size "$IMG" | cut -f1) apparent, $(du -h "$IMG" | cut -f1) on disk"
  ;;
esac
