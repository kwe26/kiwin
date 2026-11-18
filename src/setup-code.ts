import { randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KiwinConfig } from "./config";

// The first visitor to the panel creates the storage and the master account.
// On a public address that could be anyone, so first-run setup asks for a code
// only root on the host can read: `kiwin setup-code` (Setup.sh prints it).

/** No look-alikes (0/O, 1/I/L). */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_FAILURES = 5;
const LOCK_MS = 60_000;
const MAX_LOCK_MS = 30 * 60_000;

export class SetupCode {
  private failures = 0;
  private rounds = 0;
  private lockedUntil = 0;

  constructor(private cfg: KiwinConfig) {}

  private get file() {
    return join(this.cfg.stateDir, "setup-code");
  }

  /** The code, made on first use. Stays the same: setup happens once. */
  get(): string {
    if (existsSync(this.file)) {
      const code = readFileSync(this.file, "utf8").trim();
      if (code) return code;
    }
    const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    const code = `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, code + "\n", { mode: 0o600 });
    return code;
  }

  /** Called on behalf of the panel. Wrong guesses lock it for a growing time. */
  verify(given: unknown): { ok: boolean; error?: string } {
    const now = Date.now();
    if (now < this.lockedUntil) return { ok: false, error: `Too many wrong codes. Try again in ${Math.ceil((this.lockedUntil - now) / 1000)} seconds.` };
    const norm = (s: string) => Buffer.from(s.toUpperCase().replace(/[^A-Z0-9]/g, ""));
    const a = norm(typeof given === "string" ? given.slice(0, 64) : "");
    const b = norm(this.get());
    if (a.length === b.length && timingSafeEqual(a, b)) {
      this.failures = 0;
      this.rounds = 0;
      return { ok: true };
    }
    if (++this.failures >= MAX_FAILURES) {
      this.failures = 0;
      this.lockedUntil = now + Math.min(MAX_LOCK_MS, LOCK_MS * 2 ** Math.min(this.rounds++, 10));
    }
    return { ok: false, error: "That is not the setup code. On the server, run: sudo kiwin setup-code" };
  }
}
