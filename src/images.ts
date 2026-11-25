import { chmodSync, chownSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, paths, volatileName, type KiwinConfig } from "./config";
import { isRoot, pipeLines } from "./sandbox";

interface ImageMount {
  name: "system" | "user" | "log";
  image: string;
  target: string;
  options: string;
}

const run = (cmd: string[], env?: Record<string, string>) => {
  const p = Bun.spawnSync(cmd, {
    env: env ? { ...process.env, ...env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
};

/** "25GB" / "512MB" / "1TB" -> bytes (binary units, like truncate's G/M/T). */
export function parseSize(size: string): number | null {
  const m = /^(\d+)\s*(MB|GB|TB)$/i.exec(size.trim());
  if (!m) return null;
  return Number(m[1]) * 1024 ** { MB: 2, GB: 3, TB: 4 }[m[2].toUpperCase() as "MB" | "GB" | "TB"];
}

/** Run a slow command without blocking the daemon, passing its output to `out`. */
async function runLive(cmd: string[], out: (l: string) => void) {
  const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await Promise.all([pipeLines(p.stdout, out), pipeLines(p.stderr, out)]);
  return p.exited;
}

const bootId = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

/** Recreate the directory tree under `src` (no files) at `dest`, with owners and modes. */
function copyDirTree(src: string, dest: string) {
  const st = lstatSync(src);
  mkdirSync(dest);
  chownSync(dest, st.uid, st.gid);
  chmodSync(dest, st.mode & 0o7777);
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) copyDirTree(join(src, e.name), join(dest, e.name));
  }
}

/** Backing file of whatever is mounted exactly at `target`, or "" for a non-loop mount, or null if not a mountpoint. */
function mountedImage(target: string): string | null {
  const unescape = (s: string) => s.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  let source: string | null = null;
  for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
    const f = line.split(" ");
    if (f.length > 4 && unescape(f[4]) === target) source = unescape(f[f.indexOf("-") + 2] ?? ""); // last one wins
  }
  if (source === null) return null;
  if (!source.startsWith("/dev/loop")) return "";
  return run(["losetup", "-n", "-O", "BACK-FILE", source]).out;
}

/**
 * Loop-mounts system.img on the rootfs and user.img on <rootfs>/www, unpacks
 * uploaded .zst images, and creates user.img on request from inside. log.img
 * (logs, caches, temp files) is mounted host-side and recreated every boot.
 */
export class Images {
  private mounted: ImageMount[] = [];
  private volatileReady = false;
  readonly system: ImageMount;
  readonly user: ImageMount;
  readonly logImage: ImageMount;

  constructor(private cfg: KiwinConfig, private log: (l: string) => void) {
    this.system = { name: "system", image: cfg.images.system, target: cfg.rootfs, options: "loop,noatime,nodev" };
    this.user = { name: "user", image: cfg.images.user, target: join(cfg.rootfs, "www"), options: "loop,noatime,nodev,nosuid" };
    this.logImage = { name: "log", image: cfg.images.log, target: paths(cfg).volatileDir, options: "loop,noatime,nodev,nosuid" };
  }

  /** Mount the images that exist, system first. Missing images fall back to plain directories. */
  mountAll() {
    try {
      for (const m of [this.system, this.user]) {
        if (!isRoot()) {
          if (existsSync(m.image)) this.log(`images: not root, cannot mount ${m.image}; using ${m.target} as a plain directory`);
          continue;
        }
        this.unpackIfNeeded(m);
        if (!existsSync(m.image)) {
          this.log(`images: ${m.image} not found, using ${m.target} as a plain directory`);
          continue;
        }
        this.mount(m);
      }
    } catch (e) {
      this.unmountAll();
      throw e;
    }
    try {
      this.mountLog();
    } catch (e) {
      // Not fatal: volatile paths then stay on the system image.
      this.log(`images: log.img unavailable, logs stay on the system image: ${(e as Error).message}`);
    }
  }

  /** Host directory holding one subdirectory per images.volatile path, or null when log.img is not mounted. */
  volatileDir(): string | null {
    return this.volatileReady ? this.logImage.target : null;
  }

  /**
   * Mount log.img on the state directory. It is wiped (recreated with mkfs)
   * when the host has rebooted since it was made, when it is missing, or when
   * it fails e2fsck, so logs survive a kiwin restart but not a reboot.
   */
  private mountLog() {
    if (!isRoot()) return;
    const m = this.logImage;
    const stampFile = m.image + ".boot";
    const boot = bootId();
    const stamp = existsSync(stampFile) ? readFileSync(stampFile, "utf8").trim() : null;

    if (existsSync(m.image) && stamp === boot && mountedImage(m.target) === realpathSync(m.image)) {
      this.log("images: log.img already mounted");
      this.volatileReady = true;
      return;
    }

    let fresh = false;
    if (!existsSync(m.image) || stamp !== boot) {
      this.createLog();
      fresh = true;
    }
    try {
      this.mount(m);
    } catch (e) {
      if (fresh) throw e;
      this.log(`images: ${(e as Error).message}; recreating log.img`);
      this.createLog();
      fresh = true;
      this.mount(m);
    }
    // Only seed a filesystem nothing inside has touched yet: chown/chmod follow
    // symlinks, and root inside can write to log.img once it is bound.
    if (fresh) {
      this.seedVolatile();
      writeFileSync(stampFile, boot + "\n", { mode: 0o600 });
    }
    this.volatileReady = true;
  }

  private createLog() {
    const m = this.logImage;
    const bytes = parseSize(this.cfg.images.logSize);
    if (bytes === null || bytes < 16 * 1024 ** 2) throw new Error(`invalid images.logSize ${JSON.stringify(this.cfg.images.logSize)}`);
    if (mountedImage(m.target) !== null) {
      if (run(["umount", m.target]).code !== 0) throw new Error(`${m.target} is busy`);
    }
    mkdirSync(dirname(m.image), { recursive: true, mode: 0o755 });
    rmSync(m.image + ".boot", { force: true });
    const tmp = `${m.image}.creating`;
    try {
      rmSync(tmp, { force: true });
      writeFileSync(tmp, "", { mode: 0o600 });
      run(["truncate", "-s", String(bytes), tmp]);
      const mkfs = run(["mkfs.ext4", "-q", "-F", "-L", "kiwin-log", "-m", "0", "-E", "root_owner=0:0", tmp]);
      if (mkfs.code !== 0) throw new Error(`mkfs.ext4 failed: ${mkfs.err}`);
      renameSync(tmp, m.image);
      this.log(`images: created empty ${m.image} (${this.cfg.images.logSize})`);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  /** Give each volatile path the directory layout it has in the system image (services expect e.g. /var/log/nginx). */
  private seedVolatile() {
    const rootReal = realpathSync(this.cfg.rootfs);
    rmSync(join(this.logImage.target, "lost+found"), { recursive: true, force: true });
    for (const inside of this.cfg.images.volatile) {
      const dest = join(this.logImage.target, volatileName(inside));
      let src: string | null = null;
      try {
        const real = realpathSync(join(this.cfg.rootfs, inside));
        if (real.startsWith(rootReal + "/") && statSync(real).isDirectory()) src = real;
      } catch {}
      if (src) copyDirTree(src, dest);
      else {
        mkdirSync(dest);
        chmodSync(dest, inside.endsWith("tmp") ? 0o1777 : 0o755);
      }
    }
  }

  unmountAll() {
    if (!this.cfg.images.unmountOnExit) return;
    for (const m of this.mounted.reverse()) {
      if (run(["umount", m.target]).code !== 0) {
        this.log(`images: ${m.target} busy, lazy unmount`);
        run(["umount", "-l", m.target]);
      } else this.log(`images: unmounted ${m.name}.img from ${m.target}`);
    }
    this.mounted = [];
  }

  userInfo() {
    const exists = existsSync(this.user.image);
    return {
      exists,
      mounted: exists && mountedImage(this.user.target) === realpathSync(this.user.image),
      sizeBytes: exists ? statSync(this.user.image).size : null,
      freeBytes: this.freeBytes(),
    };
  }

  freeBytes() {
    const dir = dirname(this.user.image);
    const s = statfsSync(existsSync(dir) ? dir : ROOT);
    return s.bavail * s.bsize;
  }

  /**
   * Create a sparse, empty ext4 user.img of `size` and mount it on <rootfs>/www
   * right away (the running isolation sees it at /www through mount propagation).
   * `force` allows a size beyond the free disk space: it is sparse, so this
   * works until the disk really fills up.
   */
  createUser(size: string, force = false): { ok: true } | { ok: false; error: string } {
    const bytes = parseSize(size);
    if (!isRoot()) return { ok: false, error: "kiwin daemon is not running as root" };
    if (bytes === null) return { ok: false, error: `invalid size ${JSON.stringify(size)} (use e.g. "25GB")` };
    const max = parseSize(this.cfg.images.userMaxSize) ?? Infinity;
    if (bytes < 1024 ** 3 || bytes > max) return { ok: false, error: `size must be between 1GB and ${this.cfg.images.userMaxSize}` };
    // Sparse, so this is not reserved up front, but never promise more than the disk has.
    if (!force && bytes > this.freeBytes()) return { ok: false, error: `not enough free disk space for ${size}` };
    if (existsSync(this.user.image) || existsSync(this.user.image + ".zst")) return { ok: false, error: "user.img already exists" };

    mkdirSync(dirname(this.user.image), { recursive: true, mode: 0o755 });
    const tmp = `${this.user.image}.creating`;
    try {
      rmSync(tmp, { force: true });
      writeFileSync(tmp, "", { mode: 0o600 });
      run(["truncate", "-s", String(bytes), tmp]);
      const mkfs = run(["mkfs.ext4", "-q", "-F", "-L", "kiwin-user", "-m", "0", "-E", "lazy_itable_init=1,lazy_journal_init=1,root_owner=0:0", tmp]);
      if (mkfs.code !== 0) throw new Error(`mkfs.ext4 failed: ${mkfs.err}`);
      renameSync(tmp, this.user.image);
      this.log(`images: created ${this.user.image} (${size}, sparse)`);
      this.mount(this.user);
      return { ok: true };
    } catch (e) {
      rmSync(tmp, { force: true });
      return { ok: false, error: (e as Error).message };
    }
  }

  /** Is the swap file active? If it exists but isn't, try turning it on. */
  ensureSwap(): { ok: boolean; detail: string } {
    const file = this.cfg.recovery.swapFile;
    if (this.swapActive()) return { ok: true, detail: `${file} is active` };
    let st;
    try {
      st = lstatSync(file);
    } catch {
      return { ok: false, detail: `${file} does not exist` };
    }
    if (!st.isFile()) return { ok: false, detail: `${file} is not a regular file` };
    chmodSync(file, 0o600);
    const on = run(["swapon", file]);
    if (on.code === 0 || this.swapActive()) {
      this.log(`swap: turned on ${file}`);
      return { ok: true, detail: `${file} is active` };
    }
    return { ok: false, detail: `${file} exists but could not be turned on: ${on.err || on.out}` };
  }

  private swapActive() {
    const swaps = readFileSync("/proc/swaps", "utf8").split("\n").slice(1);
    return swaps.some((l) => l.split(/\s+/)[0]?.replace(/\\040/g, " ") === this.cfg.recovery.swapFile);
  }

  /**
   * Make the swap file. Its space comes out of user.img when the disk has too
   * little free. Written with dd, not fallocate: swapon refuses files with holes.
   */
  async createSwap(out: (l: string) => void) {
    const file = this.cfg.recovery.swapFile;
    const bytes = parseSize(this.cfg.recovery.swapSize);
    if (bytes === null) throw new Error(`invalid recovery.swapSize ${JSON.stringify(this.cfg.recovery.swapSize)}`);
    if (existsSync(file)) throw new Error(`${file} already exists; check it from Manage Terminal, or remove it to make a new one`);
    const needed = bytes + 64 * 1024 ** 2;
    const free = () => {
      const s = statfsSync(dirname(file));
      return s.bavail * s.bsize;
    };
    if (free() < needed && existsSync(this.user.image)) {
      const size = statSync(this.user.image).size;
      out(`The disk has too little free space: taking ${this.cfg.recovery.swapSize} out of user.img`);
      await this.resizeUser(size - bytes, out);
    }
    if (free() < needed) throw new Error(`not enough free disk space for ${this.cfg.recovery.swapSize} of swap`);

    const tmp = `${file}.creating`;
    try {
      rmSync(tmp, { force: true });
      writeFileSync(tmp, "", { mode: 0o600 });
      out(`Writing ${this.cfg.recovery.swapSize} to ${tmp}`);
      const mb = String(Math.ceil(bytes / 1024 ** 2));
      if ((await runLive(["dd", "if=/dev/zero", `of=${tmp}`, "bs=1M", `count=${mb}`, "conv=fsync"], out)) !== 0) throw new Error("writing the swap file failed");
      if ((await runLive(["mkswap", tmp], out)) !== 0) throw new Error("mkswap failed");
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    const on = this.ensureSwap();
    if (!on.ok) throw new Error(on.detail);
    out(on.detail);
  }

  /**
   * Grow or shrink user.img. The isolation must be stopped: the image is
   * unmounted for this. A failed shrink leaves the image as it was, since it is
   * only truncated after resize2fs has moved the data.
   */
  async resizeUser(bytes: number, out: (l: string) => void, force = false) {
    const image = this.user.image;
    const max = parseSize(this.cfg.images.userMaxSize) ?? Infinity;
    if (!existsSync(image)) throw new Error("user.img does not exist yet");
    if (bytes < 1024 ** 3 || bytes > max) throw new Error(`size must be between 1GB and ${this.cfg.images.userMaxSize}`);
    const size = statSync(image).size;
    if (bytes === size) return out("user.img already has that size");
    if (!force && bytes - size > this.freeBytes()) throw new Error("not enough free disk space (Force allows it: the image is sparse)");

    const wasMounted = mountedImage(this.user.target) === realpathSync(image);
    if (wasMounted) {
      if (run(["umount", this.user.target]).code !== 0) throw new Error(`${this.user.target} is busy`);
      this.mounted = this.mounted.filter((m) => m !== this.user);
    }
    try {
      out("Checking user.img (e2fsck)");
      const fsck = await runLive(["e2fsck", "-fy", image], out);
      if (fsck === null || fsck > 1) throw new Error(`e2fsck found errors it could not fix (exit ${fsck})`);
      const kb = `${Math.floor(bytes / 1024)}K`;
      if (bytes > size) {
        if ((await runLive(["truncate", "-s", String(bytes), image], out)) !== 0) throw new Error("growing the image failed");
        if ((await runLive(["resize2fs", image], out)) !== 0) throw new Error("resize2fs failed");
      } else {
        out("Moving data below the new size (resize2fs): this can take a while");
        if ((await runLive(["resize2fs", image, kb], out)) !== 0) throw new Error("resize2fs failed: the data does not fit, or the filesystem needs attention. Nothing was cut off");
        if ((await runLive(["truncate", "-s", String(bytes), image], out)) !== 0) throw new Error("truncating the image failed");
      }
      out(`user.img is now ${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`);
    } finally {
      if (wasMounted) this.mount(this.user);
    }
  }

  /** True while exportUser() streams the image: nothing may mount or resize it meanwhile. */
  exporting = false;

  /**
   * Stream user.img compressed with zstd, unmounted so the copy is consistent
   * (the isolation must be stopped). Saved as images/user.img.zst on a server
   * without user.img, the daemon unpacks it on start. Remounts when the
   * download ends or is cancelled.
   */
  exportUser(): ReadableStream<Uint8Array> {
    const image = this.user.image;
    if (!existsSync(image)) throw new Error("user.img does not exist");
    if (this.exporting) throw new Error("user.img is already being downloaded");
    const wasMounted = mountedImage(this.user.target) === realpathSync(image);
    if (wasMounted) {
      if (run(["umount", this.user.target]).code !== 0) throw new Error(`${this.user.target} is busy: stop the system first`);
      this.mounted = this.mounted.filter((m) => m !== this.user);
    }
    this.exporting = true;
    const zstd = Bun.spawn(["nice", "-n", "10", "zstd", "-q", "-T0", "-3", "-c", image], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const finish = () => {
      if (!this.exporting) return;
      this.exporting = false;
      if (wasMounted) {
        try {
          this.mount(this.user);
        } catch (e) {
          this.log(`images: remounting user.img after the download failed: ${(e as Error).message}`);
        }
      }
    };
    zstd.exited.then(finish);
    const reader = zstd.stdout.getReader();
    return new ReadableStream({
      pull: async (controller) => {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel: () => {
        zstd.kill();
      },
    });
  }

  /**
   * images/<name>.img.zst is what gets uploaded (see compile.sh). Expand it to
   * the sparse runtime image when that is missing, or, for system.img only,
   * when the .zst is newer (a deployed update). user.img holds live data and is
   * never replaced automatically.
   */
  private unpackIfNeeded(m: ImageMount) {
    const zst = m.image + ".zst";
    if (!existsSync(zst)) return;
    const exists = existsSync(m.image);
    if (exists && (m.name !== "system" || statSync(zst).mtimeMs <= statSync(m.image).mtimeMs)) return;
    if (exists && mountedImage(m.target) === realpathSync(m.image)) {
      this.log(`images: ${zst} is newer than the mounted ${m.name}.img; unmount it (stop kiwin) to deploy`);
      return;
    }
    this.log(`images: unpacking ${zst}${exists ? " (newer than current image)" : ""}`);
    const r = run([join(ROOT, "compile.sh"), "unpack", m.name, "--size", this.cfg.images.unpackSize, ...(exists ? ["--force"] : [])]);
    if (r.code !== 0) throw new Error(`unpacking ${zst} failed: ${r.err || r.out}`);
    for (const line of r.out.split("\n").slice(1)) this.log(`images: ${line}`);
  }

  private mount(m: ImageMount) {
    const image = realpathSync(m.image);
    const current = mountedImage(m.target);
    if (current === image) {
      this.log(`images: ${m.name}.img already mounted at ${m.target}`);
      return;
    }
    if (current !== null) throw new Error(`${m.target} is already a mountpoint of ${current || "another filesystem"}`);

    if (this.cfg.images.fsck) {
      // 0 = clean, 1 = errors fixed; anything above needs a human.
      const fsck = run(["e2fsck", "-p", image]);
      if (fsck.code !== null && fsck.code > 1) throw new Error(`e2fsck ${image} exited ${fsck.code}: ${fsck.err || fsck.out}`);
      if (fsck.code === 1) this.log(`images: e2fsck repaired ${image}`);
    }

    // user.img's mountpoint lives inside the isolation's rootfs, which root
    // inside controls (and may be running right now). Pin the directory with
    // O_NOFOLLOW and mount onto the fd, so a swapped-in symlink can never
    // redirect the mount onto a host path.
    if (!existsSync(m.target)) mkdirSync(m.target, { recursive: m.name !== "user", mode: 0o755 });
    let fd: number;
    try {
      fd = openSync(m.target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch {
      throw new Error(`refusing to mount on ${m.target}: not a plain directory`);
    }
    try {
      // util-linux 2.42 (NixOS 26.05) mounts through the new fsopen/move_mount
      // API, which cannot take a /proc/<pid>/fd/<n> target while
      // --no-canonicalize keeps libmount from resolving that magic link: it
      // fails as "wrong fs type, bad option, bad superblock". The classic
      // mount(2) syscall resolves it in the kernel, so ask for that one and
      // keep the fd pinned; older libmount takes that path anyway and ignores
      // the variable.
      const r = run(
        ["mount", "--no-canonicalize", "-o", m.options, image, `/proc/${process.pid}/fd/${fd}`],
        { LIBMOUNT_FORCE_MOUNT2: "always" },
      );
      if (r.code !== 0) throw new Error(`mount ${image} on ${m.target} failed: ${r.err}`);
    } finally {
      closeSync(fd);
    }
    this.mounted.push(m);
    this.log(`images: mounted ${image} on ${m.target}`);
  }
}
