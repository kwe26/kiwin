import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { clean } from "./files";
import { SOFTWARE_BIN } from "./software";

// Archive applet for the file manager, backed by 7-Zip from the Software page
// (/www/softwares/bin/7zz). Compressed tarballs go through tar so they unpack
// in one step instead of leaving a .tar behind.

const SEVEN_ZIP = join(SOFTWARE_BIN, "7zz");
const TARBALL = /\.(tar\.(gz|xz|bz2|zst)|tgz|txz|tbz2?|tar)$/i;
export const ARCHIVE = /\.(7z|zip|rar|tar|gz|tgz|xz|txz|bz2|tbz2?|zst|lzma|cab|iso|arj|lzh|wim|jar|apk|deb|rpm)$/i;
const NAME = /^[^/\0]{1,255}$/;

async function exec(cmd: string[], cwd: string): Promise<void> {
    const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) {
        // 7-Zip prints its errors on stdout.
        const msg = (err.trim() || out.trim()).split("\n").filter((l) => /error|cannot|can not|wrong|unsupported/i.test(l)).slice(-3).join(" ");
        throw new Error(msg || `${basename(cmd[0])} exited ${code}`);
    }
}

export class KiwiArchive {
    static available(): boolean {
        return existsSync(SEVEN_ZIP);
    }

    static isArchive(name: string): boolean {
        return ARCHIVE.test(name);
    }

    /** Extract `path` into a new folder `folder` next to it. Returns the folder. */
    static async extract(path: string, folder: string): Promise<string> {
        if (!this.available()) throw new Error("Install 7-Zip from Software first");
        const file = clean(path);
        if (!NAME.test(folder) || folder === "." || folder === "..") throw new Error("Invalid folder name");
        const dest = join(dirname(file), folder);
        if (existsSync(dest)) throw new Error(`${folder} already exists`);
        if (TARBALL.test(file)) {
            await exec(["mkdir", "-p", dest], dirname(file));
            await exec(["tar", "-xaf", file, "-C", dest, "--no-same-owner"], dirname(file));
        } else {
            // x keeps paths; -aoa never prompts; 7-Zip drops "../" and absolute paths from entries.
            await exec([SEVEN_ZIP, "x", "-y", "-aoa", "-bd", `-o${dest}`, "--", file], dirname(file));
        }
        return dest;
    }

    /** Pack `paths` (all in one folder) into `archive` in that folder; format from its extension. */
    static async compress(paths: string[], archive: string): Promise<string> {
        if (!this.available()) throw new Error("Install 7-Zip from Software first");
        if (paths.length === 0) throw new Error("Nothing to compress");
        const files = paths.map(clean);
        const dir = dirname(files[0]);
        if (files.some((f) => dirname(f) !== dir)) throw new Error("Items must be in the same folder");
        if (!NAME.test(archive) || !/\.(7z|zip|tar|tar\.gz|tgz|tar\.xz|txz|tar\.zst)$/i.test(archive)) {
            throw new Error("Archive name must end in .7z, .zip, .tar, .tar.gz, .tar.xz or .tar.zst");
        }
        const out = join(dir, archive);
        if (existsSync(out)) throw new Error(`${archive} already exists`);
        const names = files.map((f) => basename(f));
        if (/\.(tar|tar\.gz|tgz|tar\.xz|txz|tar\.zst)$/i.test(archive)) {
            await exec(["tar", "-caf", out, "--", ...names], dir);
        } else {
            await exec([SEVEN_ZIP, "a", "-y", "-bd", archive.toLowerCase().endsWith(".zip") ? "-tzip" : "-t7z", "--", out, ...names], dir);
        }
        return out;
    }
}
