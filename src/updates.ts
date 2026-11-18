import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, type KiwinConfig } from "./config";
import { pipeLines } from "./sandbox";

export interface Release {
  tag: string;
  /** From the file name: Kiwin-<version>-x64-Linux.tar, e.g. 20261102 or 20261102.1. */
  version: string;
  name: string;
  publishedAt: string;
  prerelease: boolean;
  notes: string;
  pageUrl: string;
  asset: string;
  assetUrl: string;
  size: number;
}

export interface UpdateInfo {
  /** Date of the running build (VERSION). */
  current: string;
  latest: Release | null;
  /** Recent releases, newest version first. */
  releases: Release[];
  available: boolean;
  /** Upgrade.sh kept the version it replaced. */
  canRollback: boolean;
  /** End of the last upgrade's log. */
  lastLog: string | null;
  checkedAt: number | null;
  error: string | null;
  /** Outcome of the last upgrade. */
  last: { ok: boolean; at: number } | null;
}

const ASSET = /^Kiwin-(\d{8}(?:\.\d+)*)-x64-Linux\.tar$/;

/** Compare versions like 20261102 < 20261102.1 < 20261102.2 < 20261103. Anything else (a development build) is oldest. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (/^\d+(\.\d+)*$/.test(v) ? v.split(".").map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
const CACHE_MS = 10 * 60_000;
const FORCED_CACHE_MS = 60_000;

/**
 * Upgrades from the GitHub releases. Prereleases count, and tag names aren't
 * compared: the newest published release with a Linux tar is the latest.
 */
export class Updates {
  private latest: Release | null = null;
  private releases: Release[] = [];
  private checkedAt: number | null = null;
  private error: string | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private cfg: KiwinConfig, private log: (l: string) => void) {}

  private get dir() {
    return join(ROOT, ".update");
  }

  private read(file: string) {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      return "";
    }
  }

  info(): UpdateInfo {
    const current = this.read(join(ROOT, "VERSION")) || "development";
    const latest = this.latest;
    // Versions come from the release files, not tags: tags can be renamed freely.
    const available = !!latest && compareVersions(latest.version, current) > 0;
    const status = join(this.cfg.stateDir, "upgrade.status");
    const code = this.read(status);
    return {
      current, latest, releases: this.releases, available, checkedAt: this.checkedAt, error: this.error,
      canRollback: existsSync(join(ROOT, ".previous")) && existsSync(join(ROOT, "deploy", "Upgrade.sh")),
      lastLog: this.read(join(this.cfg.stateDir, "upgrade.log")).split("\n").slice(-200).join("\n") || null,
      last: code ? { ok: code === "0", at: statSync(status).mtimeMs } : null,
    };
  }

  async check(force = false): Promise<UpdateInfo> {
    const age = this.checkedAt === null ? Infinity : Date.now() - this.checkedAt;
    if (age > (force ? FORCED_CACHE_MS : CACHE_MS)) {
      this.inFlight ??= this.fetchLatest().finally(() => (this.inFlight = null));
      await this.inFlight;
    }
    return this.info();
  }

  private async fetchLatest() {
    try {
      const res = await fetch(`https://api.github.com/repos/${this.cfg.recovery.repo}/releases?per_page=30`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "kiwin" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const releases = (await res.json()) as {
        tag_name: string; name: string | null; draft: boolean; prerelease: boolean; published_at: string;
        body: string | null; html_url: string; assets: { name: string; size: number; browser_download_url: string }[];
      }[];
      // The highest version wins; the most recently published breaks a tie.
      const usable = releases
        .filter((r) => !r.draft && r.published_at)
        .flatMap((r) => r.assets.filter((a) => ASSET.test(a.name)).map((asset) => ({ r, asset, version: ASSET.exec(asset.name)![1] })))
        .sort((a, b) => compareVersions(b.version, a.version) || Date.parse(b.r.published_at) - Date.parse(a.r.published_at));
      const seen = new Set<string>();
      this.releases = usable.filter(({ version }) => !seen.has(version) && !!seen.add(version)).slice(0, 10).map(({ r, asset, version }) => ({
        tag: r.tag_name, version,
        name: r.name || r.tag_name, publishedAt: r.published_at, prerelease: r.prerelease,
        notes: r.body ?? "", pageUrl: r.html_url, asset: asset.name, assetUrl: asset.browser_download_url, size: asset.size,
      }));
      this.latest = this.releases[0] ?? null;
      this.error = null;
    } catch (e) {
      this.error = `Could not reach GitHub: ${(e as Error).message}`;
    }
    this.checkedAt = Date.now();
  }

  /**
   * Download the latest release, then hand over to its Upgrade.sh. That script
   * stops this daemon, so it runs in its own systemd unit, outside our cgroup.
   * The URL comes from GitHub's answer here, never from the panel.
   */
  async upgrade(out: (l: string) => void, progress: (done: number, total: number) => void = () => {}) {
    if (!Bun.which("systemd-run")) throw new Error("upgrading from here needs systemd");
    const { latest } = await this.check(true);
    if (!latest) throw new Error(this.error ?? "no release found");

    const { dir } = this;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { mode: 0o700 });
    const s = statfsSync(dir);
    if (s.bavail * s.bsize < latest.size * 2) throw new Error("not enough free disk space for the download");

    let release: string;
    try {
      release = await this.download(latest, dir, out, progress);
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }

    out("Starting the upgrade: Kiwin stops now and comes back on the new version");
    this.log(`updates: upgrading to ${latest.version} (${latest.tag})`);
    rmSync(join(this.cfg.stateDir, "upgrade.status"), { force: true });
    // The file name is the version the updater compares, so it is what gets
    // recorded, even when the tar was renamed after it was built.
    const script = `"$1/Upgrade.sh" > "$2/upgrade.log" 2>&1
rc=$?
echo "$rc" > "$2/upgrade.status"
[ "$rc" = 0 ] && echo "$4" > "$5/VERSION"
rm -rf "$3"
exit "$rc"`;
    const run = Bun.spawnSync(
      ["systemd-run", "--unit=kiwin-upgrade", "--collect", "--quiet", "/bin/sh", "-c", script, "kiwin-upgrade", release, this.cfg.stateDir, dir, latest.version, ROOT],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (run.exitCode !== 0) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`could not start the upgrade: ${run.stderr.toString().trim()}`);
    }
  }

  /** Go back to what the last upgrade replaced, with the installed Upgrade.sh. Also stops this daemon. */
  rollback(out: (l: string) => void) {
    if (!Bun.which("systemd-run")) throw new Error("rolling back from here needs systemd");
    if (!this.info().canRollback) throw new Error("there is no previous version to go back to");
    out("Rolling back: Kiwin stops now and comes back on the previous version");
    this.log("updates: rolling back");
    rmSync(join(this.cfg.stateDir, "upgrade.status"), { force: true });
    const script = `"$1/deploy/Upgrade.sh" --rollback > "$2/upgrade.log" 2>&1
rc=$?
echo "$rc" > "$2/upgrade.status"
exit "$rc"`;
    const run = Bun.spawnSync(
      ["systemd-run", "--unit=kiwin-upgrade", "--collect", "--quiet", "/bin/sh", "-c", script, "kiwin-rollback", ROOT, this.cfg.stateDir],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (run.exitCode !== 0) throw new Error(`could not start the rollback: ${run.stderr.toString().trim()}`);
  }

  /** Download and unpack the release into `dir`; returns the directory holding its Upgrade.sh. */
  private async download(latest: Release, dir: string, out: (l: string) => void, progress: (done: number, total: number) => void): Promise<string> {
    out(`Downloading ${latest.asset} (${Math.round(latest.size / 1024 ** 2)} MB)`);
    const tar = join(dir, latest.asset);
    const res = await fetch(latest.assetUrl);
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    const file = Bun.file(`${tar}.part`).writer();
    let got = 0;
    for await (const chunk of res.body) {
      file.write(chunk);
      got += chunk.length;
      progress(got, latest.size);
    }
    out("Downloaded");
    await file.end();
    if (got !== latest.size) throw new Error(`download incomplete: got ${got} of ${latest.size} bytes`);
    renameSync(`${tar}.part`, tar);

    out("Unpacking");
    const untar = Bun.spawn(["tar", "-C", dir, "--no-same-owner", "-xf", tar], { stdout: "pipe", stderr: "pipe" });
    await pipeLines(untar.stderr, out);
    if ((await untar.exited) !== 0) throw new Error("the download could not be unpacked");
    rmSync(tar);
    // The folder inside is named after the version it was built as, which
    // differs from the file name when the tar was renamed: look for it.
    const isFile = (p: string) => {
      try {
        return lstatSync(p).isFile();
      } catch {
        return false;
      }
    };
    const folders = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
    const release = [dir, ...folders].find((d) => isFile(join(d, "Upgrade.sh")));
    if (!release) throw new Error("the release has no Upgrade.sh");
    return release;
  }
}
