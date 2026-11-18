import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KiwinConfig } from "./config";
import { readRootfsFile } from "./sandbox";

// Secrets the isolation stores on user.img (e.g. /www/password.txt) are sealed
// with a key that only exists on the host, so a copied user.img or backup does
// not leak them. Moving user.img to another server needs this key too
// (`kiwin secret-key export|import`).

const PREFIX = "kiwin-sealed:v1:";
const AAD = Buffer.from("kiwin-secret");

export const keyPath = (cfg: KiwinConfig) => join(cfg.stateDir, "secrets", "storage.key");

function loadKey(cfg: KiwinConfig): Buffer {
  const file = keyPath(cfg);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, randomBytes(32).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  }
  const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error(`${file} is not a valid 256-bit key`);
  return key;
}

export function seal(cfg: KiwinConfig, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKey(cfg), iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

export function unseal(cfg: KiwinConfig, sealed: string): string {
  if (!sealed.startsWith(PREFIX)) throw new Error("not a kiwin sealed secret");
  const raw = Buffer.from(sealed.slice(PREFIX.length).trim(), "base64");
  const decipher = createDecipheriv("aes-256-gcm", loadKey(cfg), raw.subarray(0, 12));
  decipher.setAAD(AAD);
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

/**
 * `kiwin get <name>`: /www/redir.json on user.img maps names to sealed files
 * relative to /www, e.g. { "mysql_password": "password.txt" }. The isolation
 * controls those files, so paths are confined to /www and read without
 * following symlinks out of the rootfs.
 */
export function getSecret(cfg: KiwinConfig, name: string): string {
  const redirRaw = readRootfsFile(cfg, "/www/redir.json");
  if (redirRaw === null) throw new Error("/www/redir.json not found (is user storage set up?)");
  let redir: Record<string, unknown>;
  try {
    redir = JSON.parse(redirRaw);
  } catch {
    throw new Error("/www/redir.json is not valid JSON");
  }
  const file = redir[name];
  if (typeof file !== "string") throw new Error(`"${name}" is not in /www/redir.json (available: ${Object.keys(redir).join(", ") || "none"})`);
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(file) || file.split("/").includes("..")) throw new Error(`invalid path for "${name}": ${file}`);
  const sealed = readRootfsFile(cfg, `/www/${file}`);
  if (sealed === null) throw new Error(`/www/${file} not found`);
  return unseal(cfg, sealed.trim());
}

export function exportKey(cfg: KiwinConfig): string {
  return loadKey(cfg).toString("base64");
}

export function importKey(cfg: KiwinConfig, b64: string) {
  const key = Buffer.from(b64.trim(), "base64");
  if (key.length !== 32) throw new Error("key must be 32 bytes, base64 encoded");
  const file = keyPath(cfg);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, key.toString("base64") + "\n", { mode: 0o600 });
}
