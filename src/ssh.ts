import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { timingSafeEqual, generateKeyPairSync } from "node:crypto";
import { dirname } from "node:path";
import ssh2 from "ssh2";
import type { Subprocess } from "bun";
import { paths, type KiwinConfig } from "./config";
import { enterCommand, lookupAccount, readRootfsFile, type Account, type Sandbox } from "./sandbox";

const { Server, utils } = ssh2;

function ensureHostKey(cfg: KiwinConfig): Buffer {
  const file = paths(cfg).hostKey;
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const gen = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "kiwin", "-f", file]);
    if (gen.exitCode !== 0) {
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 3072,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      writeFileSync(file, privateKey, { mode: 0o600 });
    }
  }
  return readFileSync(file);
}

function authorizedKeys(cfg: KiwinConfig, account: Account) {
  const sources = [readRootfsFile(cfg, `${account.home}/.ssh/authorized_keys`)];
  const extra = cfg.ssh.authorizedKeys[account.name];
  if (extra && existsSync(extra)) sources.push(readFileSync(extra, "utf8"));
  const keys = [];
  for (const line of sources.join("\n").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    // Skip any authorized_keys options prefix (we do not honour them).
    const m = t.match(/((?:ssh-|ecdsa-|sk-)\S+\s+\S+.*)$/);
    const parsed = m && utils.parseKey(m[1]);
    if (parsed && !(parsed instanceof Error)) keys.push(Array.isArray(parsed) ? parsed[0] : parsed);
  }
  return keys;
}

const ENV_ALLOW = /^(LANG|LC_[A-Z_]+|COLORTERM|TZ)$/;

export function startSsh(cfg: KiwinConfig, sandbox: Sandbox, log: (l: string) => void) {
  const server = new Server(
    { hostKeys: [ensureHostKey(cfg)], ident: "kiwin", banner: cfg.ssh.banner },
    (client: any, info: any) => {
      const peer = `${info.ip}:${info.port}`;
      let account: Account | null = null;

      client.on("authentication", (ctx: any) => {
        const acct = lookupAccount(cfg, ctx.username);
        const allowed = acct && (cfg.ssh.allowUsers.length === 0 || cfg.ssh.allowUsers.includes(acct.name));
        if (!allowed || ctx.method !== "publickey") return ctx.reject(["publickey"]);
        const key = authorizedKeys(cfg, acct).find((k: any) => {
          const pub = k.getPublicSSH();
          return k.type === ctx.key.algo && pub.length === ctx.key.data.length && timingSafeEqual(pub, ctx.key.data);
        });
        if (!key) return ctx.reject(["publickey"]);
        if (!ctx.signature) return ctx.accept(); // key probe
        if (key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(["publickey"]);
        account = acct;
        log(`ssh: ${acct.name} authenticated from ${peer}`);
        ctx.accept();
      });

      client.on("ready", () => {
        client.on("session", (acceptSession: any) => {
          const session = acceptSession();
          let pty: { cols: number; rows: number; term: string } | null = null;
          const env: Record<string, string> = {};
          let proc: Subprocess | null = null;

          session.on("pty", (accept: any, _reject: any, i: any) => {
            pty = { cols: i.cols || 80, rows: i.rows || 24, term: i.term || "xterm-256color" };
            accept?.();
          });
          session.on("window-change", (accept: any, _reject: any, i: any) => {
            if (pty) pty = { ...pty, cols: i.cols, rows: i.rows };
            (proc as any)?.terminal?.resize(i.cols, i.rows);
            accept?.();
          });
          session.on("env", (accept: any, reject: any, i: any) => {
            if (ENV_ALLOW.test(i.key)) {
              env[i.key] = i.val;
              accept?.();
            } else reject?.();
          });

          const run = (accept: any, reject: any, command?: string) => {
            if (!sandbox.initPid || !account) {
              reject?.();
              return;
            }
            const stream = accept();
            const argv = enterCommand(cfg, sandbox.initPid, account, { command, term: pty?.term, env });
            const finish = (code: number | null) => {
              try {
                stream.exit(code ?? 1);
              } catch {}
              stream.end();
            };

            if (pty) {
              const p = Bun.spawn(argv, {
                terminal: { cols: pty.cols, rows: pty.rows, data: (_t: unknown, d: Uint8Array) => stream.write(Buffer.from(d)) },
              } as any);
              proc = p;
              stream.on("data", (d: Buffer) => (p as any).terminal.write(d));
              p.exited.then(async (code) => {
                await Bun.sleep(30); // let the last pty output drain
                (p as any).terminal?.close?.();
                finish(code);
              });
            } else {
              const p = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
              proc = p;
              stream.on("data", (d: Buffer) => {
                p.stdin.write(d);
                p.stdin.flush();
              });
              stream.on("end", () => p.stdin.end());
              const pump = async (s: ReadableStream<Uint8Array>, out: any) => {
                for await (const c of s) out.write(Buffer.from(c));
              };
              Promise.all([pump(p.stdout, stream), pump(p.stderr, stream.stderr), p.exited]).then(([, , code]) =>
                finish(code),
              );
            }
            stream.on("close", () => proc?.kill("SIGHUP"));
          };

          session.on("shell", (accept: any, reject: any) => run(accept, reject));
          session.on("exec", (accept: any, reject: any, i: any) => run(accept, reject, i.command));
          session.on("subsystem", (accept: any, reject: any, i: any) => {
            const sftp = ["/usr/lib/openssh/sftp-server", "/usr/lib/sftp-server"].find((p) =>
              readRootfsFile(cfg, p) !== null,
            );
            if (i.name !== "sftp" || !sftp) return reject?.();
            const saved = pty;
            pty = null;
            run(accept, reject, sftp);
            pty = saved;
          });
        });
      });

      client.on("error", (e: Error) => log(`ssh: ${peer} error: ${e.message}`));
      client.on("close", () => account && log(`ssh: ${account.name} from ${peer} disconnected`));
    },
  );

  server.listen(cfg.ssh.port, cfg.ssh.host, () => log(`ssh: listening on ${cfg.ssh.host}:${cfg.ssh.port}`));
  return server;
}
