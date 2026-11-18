import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSecret, registerSecret, sealSecret } from "./host";

// Encrypted key/value settings on user.img. Every value is sealed with the
// host-only key, stored as /www/db/<name>.txt and listed in /www/redir.json,
// so the host can read it with `./kiwin get <name>` too.
//
//   await KiwiConfig.get("mysql_password")
//   await KiwiConfig.setCreate("master_password", "admin")
//
// Files are root-only (0600) inside root:mysql 0750 /www/db, so nginx
// (www-data) and other services cannot read them.

const STORAGE = "/www";
const DB_DIR = join(STORAGE, "db");
const REDIR = join(STORAGE, "redir.json");
const NAME = /^[a-z0-9_]{1,64}$/;

/** Managed elsewhere: changing them here would desync the real credential. */
const READ_ONLY = new Set(["mysql_password"]);

function checkName(name: string) {
    if (!NAME.test(name)) throw new Error(`invalid config name ${JSON.stringify(name)} (a-z, 0-9, _ only)`);
}

function readRedir(): Record<string, string> {
    if (!existsSync(REDIR)) return {};
    try {
        return JSON.parse(readFileSync(REDIR, "utf8"));
    } catch {
        throw new Error(`${REDIR} is not valid JSON; fix or remove it`);
    }
}

function ensureDbDir() {
    if (existsSync(DB_DIR)) return;
    mkdirSync(DB_DIR, { mode: 0o750 });
    // Group mysql when it exists, so a later MySQL setup can still reach its data.
    const gid = Number(Bun.spawnSync(["id", "-g", "mysql"]).stdout.toString().trim());
    chownSync(DB_DIR, 0, Number.isInteger(gid) && gid > 0 ? gid : 0);
    chmodSync(DB_DIR, 0o750);
}

export class KiwiConfig {
    /** Decrypted value of `name`, or null when it is not set. */
    static async get(name: string): Promise<string | null> {
        if (!(name in readRedir())) return null;
        return getSecret(name);
    }

    static has(name: string): boolean {
        return name in readRedir();
    }

    /** Names that are set (values stay encrypted until get()). */
    static keys(): string[] {
        return Object.keys(readRedir());
    }

    /**
     * Encrypt and store `value` under `name`, creating it if it does not exist
     * yet (/www/db/<name>.txt + a redir.json entry) and replacing it if it does.
     */
    static async setCreate(name: string, value: string): Promise<void> {
        checkName(name);
        if (READ_ONLY.has(name)) throw new Error(`${name} is managed by kiwi and cannot be set`);
        // Never write secrets into the system image.
        const mounted = readFileSync("/proc/self/mountinfo", "utf8").split("\n").some((l) => l.split(" ")[4] === STORAGE);
        if (!mounted) throw new Error(`user storage is not mounted at ${STORAGE}`);

        const sealed = await sealSecret(value);
        const rel = readRedir()[name] ?? `db/${name}.txt`;
        const file = join(STORAGE, rel);
        ensureDbDir();
        writeFileSync(`${file}.tmp`, sealed + "\n", { mode: 0o600 });
        chownSync(`${file}.tmp`, 0, 0);
        renameSync(`${file}.tmp`, file);
        registerSecret(name, rel);
        chmodSync(REDIR, 0o600);
    }
}
