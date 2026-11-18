import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { KiwiConfig } from "./config";

// Master account + sessions for the kiwi admin panel.
//
// The master account lives in KiwiConfig ("master_account", sealed with the
// host key on user.img) as { username, hash } where hash is argon2id.
// Sessions are random tokens kept in memory (a kiwi restart signs everyone
// out); the browser keeps its token in the httpOnly "kiwi_session" cookie.

export const SESSION_COOKIE = "kiwi_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60 * 1000;
/** Every further wrong guess doubles the wait, up to this. */
const MAX_LOCKOUT_MS = 30 * 60 * 1000;
/** Guesses at made-up usernames must not grow the table without bound. */
const MAX_TRACKED = 5000;

function recordFailure(key: string) {
    const count = (store.failures.get(key)?.count ?? 0) + 1;
    const over = count - MAX_FAILURES;
    const until = over >= 0 ? Date.now() + Math.min(MAX_LOCKOUT_MS, LOCKOUT_MS * 2 ** Math.min(over, 10)) : 0;
    if (!store.failures.has(key) && store.failures.size >= MAX_TRACKED) {
        const now = Date.now();
        for (const [k, v] of store.failures) if (v.until < now) store.failures.delete(k);
        if (store.failures.size >= MAX_TRACKED) store.failures.clear();
    }
    store.failures.set(key, { count, until });
}
const USERNAME = /^[a-z][a-z0-9_.-]{2,31}$/;
const MIN_PASSWORD = 8;

interface MasterAccount {
    username: string;
    hash: string;
    createdAt: string;
}

interface Session {
    username: string;
    expires: number;
}

// Next.js may load this module more than once (pages, actions); keep one store.
// Sessions are keyed by sha256(token) so a memory dump does not hand out usable tokens.
const store = ((globalThis as any).__kiwiAuth ??= {
    sessions: new Map<string, Session>(),
    failures: new Map<string, { count: number; until: number }>(),
    dummyHash: null as Promise<string> | null,
}) as {
    sessions: Map<string, Session>;
    failures: Map<string, { count: number; until: number }>;
    dummyHash: Promise<string> | null;
};

// Verified against when the username is wrong, so timing does not reveal it.
const dummyHash = () => (store.dummyHash ??= Bun.password.hash(randomBytes(16).toString("hex")));
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export class KiwiAuth {
    static hasMaster(): boolean {
        return KiwiConfig.has("master_account");
    }

    static async master(): Promise<MasterAccount | null> {
        const raw = await KiwiConfig.get("master_account");
        return raw ? (JSON.parse(raw) as MasterAccount) : null;
    }

    /** First-run only: refuses when a master account already exists. */
    static async createMaster(username: string, password: string, confirm: string): Promise<string | null> {
        if (this.hasMaster()) return "A master account already exists";
        const problem = this.checkCredentials(username, password, confirm);
        if (problem) return problem;
        const account: MasterAccount = {
            username: username.toLowerCase(),
            hash: await Bun.password.hash(password, { algorithm: "argon2id" }),
            createdAt: new Date().toISOString(),
        };
        await KiwiConfig.setCreate("master_account", JSON.stringify(account));
        return null;
    }

    /** Returns a new session token, or an error message. */
    static async login(username: string, password: string): Promise<{ token: string } | { error: string }> {
        const key = username.trim().toLowerCase().slice(0, 64);
        const lock = store.failures.get(key);
        if (lock && lock.until > Date.now()) {
            return { error: `Too many attempts, try again in ${Math.ceil((lock.until - Date.now()) / 1000)}s` };
        }
        const account = await this.master();
        const userOk = !!account && account.username.length === key.length &&
            timingSafeEqual(Buffer.from(account.username), Buffer.from(key));
        const passOk = await Bun.password.verify(password, userOk ? account!.hash : await dummyHash());
        if (!userOk || !passOk) {
            recordFailure(key);
            return { error: "Wrong username or password" };
        }
        store.failures.delete(key);
        const token = randomBytes(32).toString("base64url");
        store.sessions.set(digest(token), { username: account!.username, expires: Date.now() + SESSION_TTL_MS });
        return { token };
    }

    /**
     * Re-check the master password of a signed-in user before showing a secret.
     * Shares the login lockout, so it cannot be used to guess the password.
     */
    static async verifyPassword(username: string, password: string): Promise<string | null> {
        const key = username.trim().toLowerCase();
        const lock = store.failures.get(key);
        if (lock && lock.until > Date.now()) return `Too many attempts, try again in ${Math.ceil((lock.until - Date.now()) / 1000)}s`;
        const account = await this.master();
        if (!account || account.username !== key || !(await Bun.password.verify(password, account.hash))) {
            recordFailure(key);
            return "Wrong master password";
        }
        store.failures.delete(key);
        return null;
    }

    /** Username for a session token, or null. Sliding expiry. */
    static user(token: string | undefined): string | null {
        if (!token) return null;
        const session = store.sessions.get(digest(token));
        if (!session) return null;
        if (session.expires < Date.now()) {
            store.sessions.delete(digest(token));
            return null;
        }
        session.expires = Date.now() + SESSION_TTL_MS;
        return session.username;
    }

    static logout(token: string | undefined): void {
        if (token) store.sessions.delete(digest(token));
    }

    /** Changes the password and signs out every session except `keepToken`. */
    static async changePassword(keepToken: string | undefined, current: string, next: string, confirm: string): Promise<string | null> {
        const account = await this.master();
        if (!account) return "No master account";
        // Same lockout as signing in: a stolen session must not get unlimited guesses.
        const error = await this.verifyPassword(account.username, current);
        if (error) return error === "Wrong master password" ? "Current password is wrong" : error;
        const problem = this.checkCredentials(account.username, next, confirm);
        if (problem) return problem;
        account.hash = await Bun.password.hash(next, { algorithm: "argon2id" });
        await KiwiConfig.setCreate("master_account", JSON.stringify(account));
        const keep = digest(keepToken ?? "");
        for (const k of store.sessions.keys()) if (k !== keep) store.sessions.delete(k);
        return null;
    }

    private static checkCredentials(username: string, password: string, confirm: string): string | null {
        if (!USERNAME.test(username.toLowerCase())) return "Username: 3-32 characters, starting with a letter (a-z, 0-9, _ . -)";
        if (password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
        if (password !== confirm) return "Passwords do not match";
        return null;
    }
}
