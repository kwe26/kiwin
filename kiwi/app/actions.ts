"use server";

import { randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/forms";
import { KiwiAuth } from "@/lib/auth";
import { KiwiImg } from "@/lib/img";
import { KiwiMysql } from "@/lib/mysql";
import { KiwiNginx, type SiteType } from "@/lib/nginx";
import { KiwiAcme } from "@/lib/acme";
import { posix } from "node:path";
import { KiwiFiles, clean } from "@/lib/files";
import { KiwiArchive } from "@/lib/archive";
import { KiwiServices, type UnitOp } from "@/lib/services";
import { KiwiSoftware } from "@/lib/software";
import { KiwiPm2 } from "@/lib/pm2";
import { KiwiDesktop } from "@/lib/desktop";
import { KiwiMail } from "@/lib/mail";
import { KiwiPhp, SETTINGS as PHP_SETTINGS, type Sapi } from "@/lib/php";
import { KiwiFirewall, type FirewallRule, type Proto } from "@/lib/firewall";
import { KiwiUpdates } from "@/lib/updates";
import { checkSetupCode } from "@/lib/host";
import { KiwiJobs } from "@/lib/jobs";
import { KiwiBackups, PART_IDS, type Part } from "@/lib/backups";
import { rememberSetupCode, setupCodeGiven, clearSession, requireUser, sessionToken, setSession } from "@/lib/session";

const text = (fd: FormData, name: string) => String(fd.get(name) ?? "").trim();
const raw = (fd: FormData, name: string) => String(fd.get(name) ?? "");
const fail = (message: string): ActionState => ({ ok: false, message });
const done = (message: string, secret?: string): ActionState => ({ ok: true, message, secret });

// ---- Backups ----------------------------------------------------------------

const chosenParts = (fd: FormData) => fd.getAll("part").map(String).filter((p): p is Part => (PART_IDS as string[]).includes(p));

/** One backup or restore at a time: they share the "backup" job key. */
export async function createBackup(_: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    const parts = chosenParts(fd);
    if (parts.length === 0) return fail("Choose what to back up");
    const job = KiwiJobs.start("backup", "Creating a backup", async (out) => {
        await KiwiBackups.create(parts, out);
    });
    redirect(`/settings/backups?job=${job.id}`);
}

export async function restoreBackup(name: string, _: ActionState, fd: FormData): Promise<ActionState> {
    const error = await checkMaster(fd);
    if (error) return fail(error);
    const parts = chosenParts(fd);
    if (parts.length === 0) return fail("Choose what to restore");
    const job = KiwiJobs.start("backup", `Restoring ${name}`, (out) => KiwiBackups.restore(name, parts, out));
    redirect(`/settings/backups?job=${job.id}`);
}

export async function deleteBackup(name: string, _: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    try {
        KiwiBackups.remove(name);
    } catch (e) {
        return fail((e as Error).message);
    }
    revalidatePath("/settings/backups");
    return done(`${name} deleted`);
}

// ---- Updates --------------------------------------------------------------

export async function checkUpdates(): Promise<void> {
    await requireUser();
    await KiwiUpdates.check();
    revalidatePath("/settings/updates");
}

/** Stops only the panel; recovery takes its port. */
export async function openRecovery(): Promise<{ ok: true } | { error: string }> {
    await requireUser();
    return KiwiUpdates.openRecovery().then(() => ({ ok: true as const }), (e) => ({ error: (e as Error).message }));
}

/** Shuts the system down: the token is for the upgrade page on /recovery. */
export async function enterUpgrade(): Promise<{ token: string } | { error: string }> {
    await requireUser();
    return KiwiUpdates.enter().then((token) => ({ token }), (e) => ({ error: (e as Error).message }));
}

// ---- First run ------------------------------------------------------------

export async function createStorage(_: ActionState, fd: FormData): Promise<ActionState> {
    // Before user.img exists there is no master account (it is stored on
    // user.img); the daemon refuses to create a second image.
    if (KiwiImg.exists()) redirect("/");
    const denied = await checkSetupCode(text(fd, "setupCode"));
    if (denied) return fail(denied);
    const choice = text(fd, "size");
    const size = choice === "custom" ? `${text(fd, "customGB")}GB` : choice;
    if (!choice) return fail("Choose a storage size");
    if (!(await KiwiImg.create(size, fd.get("force") === "on"))) return fail(`Could not create the user image: ${KiwiImg.lastError}`);
    await rememberSetupCode();
    redirect("/setup/account");
}

export async function createMaster(_: ActionState, fd: FormData): Promise<ActionState> {
    const username = text(fd, "username").toLowerCase();
    const password = raw(fd, "password");
    // Until an account exists, whoever gets here first would own the server.
    if (!KiwiAuth.hasMaster() && !(await setupCodeGiven())) {
        const denied = await checkSetupCode(text(fd, "setupCode"));
        if (denied) return fail(denied);
    }
    const error = await KiwiAuth.createMaster(username, password, raw(fd, "confirm")).catch((e) => (e as Error).message);
    if (error) return fail(error);
    const login = await KiwiAuth.login(username, password);
    if ("error" in login) return fail(login.error);
    await setSession(login.token);
    redirect("/dashboard");
}

// ---- Session --------------------------------------------------------------

export async function login(_: ActionState, fd: FormData): Promise<ActionState> {
    const result = await KiwiAuth.login(text(fd, "username"), raw(fd, "password"));
    if ("error" in result) return fail(result.error);
    await setSession(result.token);
    redirect("/dashboard");
}

export async function logout() {
    KiwiAuth.logout(await sessionToken());
    await clearSession();
    redirect("/login");
}

export async function changePassword(_: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    const error = await KiwiAuth.changePassword(await sessionToken(), raw(fd, "current"), raw(fd, "password"), raw(fd, "confirm"));
    return error ? fail(error) : done("Password changed. Other sessions were signed out.");
}

// ---- Websites (nginx) -----------------------------------------------------

export async function createSite(_: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    const domain = text(fd, "domain").toLowerCase();
    const aliases = text(fd, "aliases").split(/[\s,]+/).filter(Boolean);
    const type = text(fd, "type") as SiteType;
    if (!["static", "proxy", "php"].includes(type)) return fail("Choose a site type");
    const target = type === "proxy" ? text(fd, "proxy") : type === "php" ? text(fd, "php") : "";
    if (!(await KiwiNginx.create(domain, aliases, type, target))) return fail(KiwiNginx.lastError ?? "Could not create the site");
    revalidatePath("/websites");
    // The certificate is requested in the background: its page follows the live log.
    if (fd.get("ssl") === "on") redirect(`/websites/${domain}?created=1&job=${startCertificate(domain, text(fd, "email") || undefined).id}`);
    redirect(`/websites/${domain}?created=1`);
}

export async function setSiteEnabled(domain: string, enabled: boolean, _: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    if (!(await KiwiNginx.setEnabled(domain, enabled))) return fail(KiwiNginx.lastError ?? "Failed");
    revalidatePath("/websites");
    return done(`${domain} ${enabled ? "enabled" : "disabled"}`);
}

export async function removeSite(domain: string, _: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    if (!(await KiwiNginx.remove(domain))) return fail(KiwiNginx.lastError ?? "Failed");
    revalidatePath("/websites");
    redirect("/websites");
}

export async function setSitePhpSecurity(domain: string, _: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    // The boxes are the protections; unticking one is what needs recording.
    const access = { shell: fd.get("blockShell") !== "on", files: fd.get("jail") !== "on" };
    if (!(await KiwiNginx.setPhpAccess(domain, access))) return fail(KiwiNginx.lastError ?? "Failed");
    revalidatePath("/websites");
    return done(access.shell || access.files ? "Saved. This site's PHP is less protected now." : "Saved. This site's PHP is locked down.");
}

export async function sitePhpWriteAccess(domain: string, _: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    try {
        const n = KiwiNginx.giveToPhp(domain);
        return done(`PHP can now write to all ${n} files and folders of ${domain}.`);
    } catch (e) {
        return fail((e as Error).message);
    }
}

function startCertificate(domain: string, email?: string) {
    return KiwiJobs.start(`ssl:${domain}`, `Certificate for ${domain}`, (out) => KiwiAcme.request(domain, email, out));
}

export async function issueCertificate(domain: string, _: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    if (!KiwiNginx.get(domain)) return fail(`No site ${domain}`);
    redirect(`/websites/${encodeURIComponent(domain)}?job=${startCertificate(domain, text(fd, "email") || undefined).id}`);
}

export async function setForceHttps(domain: string, on: boolean, _: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    if (!(await KiwiNginx.setForceHttps(domain, on))) return fail(KiwiNginx.lastError ?? "Failed");
    revalidatePath("/websites");
    return done(on ? "HTTP now redirects to HTTPS" : "HTTP is served directly again");
}

export async function testNginx(_: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    const t = KiwiNginx.test();
    return t.ok ? done("Configuration is valid", t.output || undefined) : { ok: false, message: "Configuration has errors", secret: t.output };
}

export async function reloadNginx(_: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    if (!(await KiwiNginx.reload())) return fail(KiwiNginx.lastError ?? "Reload failed");
    revalidatePath("/websites");
    return done("nginx reloaded");
}

// ---- Files ----------------------------------------------------------------

/** Run a file operation; returns an error message or null. Called directly from client components. */
async function fileOp(op: () => unknown | Promise<unknown>): Promise<string | null> {
    await requireUser();
    try {
        await op();
        revalidatePath("/files");
        return null;
    } catch (e) {
        return (e as Error).message;
    }
}

export async function fileMkdir(dir: string, name: string) { return fileOp(() => KiwiFiles.mkdir(dir, name)); }
export async function fileTouch(dir: string, name: string) { return fileOp(() => KiwiFiles.touch(dir, name)); }
export async function fileRename(path: string, name: string) { return fileOp(() => KiwiFiles.rename(path, name)); }
export async function fileRemove(path: string) { return fileOp(() => KiwiFiles.remove(path)); }
export async function fileSave(path: string, content: string) { return fileOp(() => KiwiFiles.writeText(path, content)); }

export async function fileUpload(dir: string, fd: FormData): Promise<string | null> {
    return fileOp(async () => {
        for (const f of fd.getAll("files")) if (f instanceof File && f.name) await KiwiFiles.upload(dir, f);
    });
}

// ---- Databases ------------------------------------------------------------

const DB_NAME = /^[A-Za-z0-9_]{1,32}$/;

export async function setupMysql(_: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    if (!(await KiwiMysql.ensure())) return fail(`MySQL setup failed: ${KiwiMysql.lastError}`);
    revalidatePath("/databases");
    return done("MySQL is ready");
}

export async function createDatabase(_: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    if (!KiwiMysql.isSetup()) return fail("MySQL is not set up yet");
    const name = text(fd, "name");
    if (!DB_NAME.test(name)) return fail("Name: 1-32 letters, digits or _");
    const custom = fd.get("custom") === "on";
    const user = custom ? text(fd, "user") || name : name;
    if (!DB_NAME.test(user) || user === "root" || user.startsWith("mysql")) return fail("User: 1-32 letters, digits or _ (not root or mysql*)");
    const chosen = custom ? raw(fd, "password") : "";
    if (chosen && chosen.length < 8) return fail("Password must be at least 8 characters (or leave it empty to generate one)");
    const password = chosen || randomBytes(18).toString("base64url");
    try {
        await KiwiMysql.createDatabase(name);
        let userCreated = false;
        try {
            await KiwiMysql.createUser(user, password, name);
            userCreated = true;
            await KiwiMysql.saveCredential(name, user, password);
        } catch (e) {
            if (userCreated) await KiwiMysql.dropUser(user).catch(() => {});
            await KiwiMysql.dropDatabase(name).catch(() => {});
            throw e;
        }
    } catch (e) {
        return fail((e as Error).message);
    }
    revalidatePath("/databases");
    return done(
        `Database ${name} created. You can show this password again from the database list.`,
        `host=127.0.0.1\nport=3306\ndatabase=${name}\nuser=${user}\npassword=${password}`,
    );
}

export async function dropDatabase(name: string, _: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    if (!DB_NAME.test(name)) return fail("Invalid database name");
    try {
        const user = KiwiMysql.managedUser(name);
        await KiwiMysql.dropDatabase(name);
        await KiwiMysql.dropUser(user).catch(() => {}); // it may have been created without its user
        KiwiMysql.forgetCredential(name);
    } catch (e) {
        return fail((e as Error).message);
    }
    revalidatePath("/databases");
    return done(`Database ${name} deleted`);
}

/** Master password check shared by the actions that reveal or change secrets. */
async function checkMaster(fd: FormData): Promise<string | null> {
    const user = await requireUser();
    const password = raw(fd, "password");
    if (!password) return "Enter your master password";
    return KiwiAuth.verifyPassword(user, password);
}

export async function revealDatabasePassword(name: string, _: ActionState, fd: FormData): Promise<ActionState> {
    const error = await checkMaster(fd);
    if (error) return fail(error);
    if (!DB_NAME.test(name)) return fail("Invalid database name");
    try {
        const c = await KiwiMysql.credential(name);
        if (!c) return fail(`No password is stored for ${name} (created outside kiwi or before passwords were kept). Use Change password to set one.`);
        return done("Anyone with this password has full access to this database.", `host=127.0.0.1\nport=3306\ndatabase=${name}\nuser=${c.user}\npassword=${c.password}`);
    } catch (e) {
        return fail((e as Error).message);
    }
}

export async function changeDatabasePassword(name: string, _: ActionState, fd: FormData): Promise<ActionState> {
    const error = await checkMaster(fd);
    if (error) return fail(error);
    if (!DB_NAME.test(name)) return fail("Invalid database name");
    const chosen = raw(fd, "new_password");
    if (chosen && chosen.length < 8) return fail("New password must be at least 8 characters (or leave it empty to generate one)");
    const password = chosen || randomBytes(18).toString("base64url");
    const user = KiwiMysql.managedUser(name);
    try {
        await KiwiMysql.setDatabasePassword(name, user, password);
    } catch (e) {
        return fail((e as Error).message);
    }
    revalidatePath("/databases");
    return done(`Password of ${user} changed. Update the apps that use it.`, `host=127.0.0.1\nport=3306\ndatabase=${name}\nuser=${user}\npassword=${password}`);
}

export async function revealRootPassword(_: ActionState, fd: FormData): Promise<ActionState> {
    const error = await checkMaster(fd);
    if (error) return fail(error);
    try {
        return done("Anyone with this password has full access to every database.", `user=root\npassword=${await KiwiMysql.rootPassword()}`);
    } catch (e) {
        return fail((e as Error).message);
    }
}

// ---- Services -------------------------------------------------------------

export async function serviceAction(unit: string, op: UnitOp, _: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    try {
        // A service installed from Software: make sure it can reach its data (repairs older installs).
        if ((op === "start" || op === "restart") && KiwiSoftware.get(unit)?.service) await KiwiSoftware.refreshService(unit);
        const info = await KiwiServices.run(unit, op);
        revalidatePath("/services");
        return done(`${unit}: ${info.state}`);
    } catch (e) {
        return fail((e as Error).message);
    }
}

// ---- Software -------------------------------------------------------------

export async function installSoftware(id: string, _: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    const service = fd.get("service") === "on" ? { port: Number(text(fd, "port")), firewall: fd.get("firewall") === "on" } : undefined;
    try {
        await KiwiSoftware.install(id, text(fd, "version"), service);
        return done("Installing…");
    } catch (e) {
        return fail((e as Error).message);
    }
}

export async function createSoftwareService(id: string, _: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    const port = Number(text(fd, "port"));
    try {
        await KiwiSoftware.createService(id, port, { start: fd.get("start") !== "off", firewall: fd.get("firewall") === "on" });
    } catch (e) {
        return fail((e as Error).message);
    }
    revalidatePath(`/software/${id}`);
    revalidatePath("/services");
    return done(`Service created on port ${port}`);
}

export async function removeSoftwareService(id: string, _: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    try {
        await KiwiSoftware.removeService(id);
    } catch (e) {
        return fail((e as Error).message);
    }
    revalidatePath(`/software/${id}`);
    revalidatePath("/services");
    return done("Service removed; its data was kept");
}

export async function setDefaultSoftware(id: string, _: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    const version = text(fd, "version");
    try {
        await KiwiSoftware.setDefault(id, version);
    } catch (e) {
        return fail((e as Error).message);
    }
    revalidatePath(`/software/${id}`);
    return done(`${version} is now the default`);
}

export async function removeSoftware(id: string, _: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    const version = text(fd, "version");
    try {
        await KiwiSoftware.remove(id, version);
    } catch (e) {
        return fail((e as Error).message);
    }
    revalidatePath("/software");
    revalidatePath(`/software/${id}`);
    return done(`${version} removed`);
}

// ---- Firewall -------------------------------------------------------------

/** Port the browser reached the panel on, so a change can't lock the admin out. */
async function panelPort(): Promise<number | null> {
    const h = await headers();
    const hostHeader = h.get("x-forwarded-host") ?? h.get("host") ?? "";
    const explicit = h.get("x-forwarded-port") ?? /:(\d+)$/.exec(hostHeader)?.[1];
    if (explicit) return Number(explicit);
    return (h.get("x-forwarded-proto") ?? "http").startsWith("https") ? 443 : 80;
}

async function applyFirewall(enabled: boolean, rules: FirewallRule[]): Promise<ActionState> {
    const port = await panelPort();
    const info = await KiwiFirewall.info();
    if (port && KiwiFirewall.allows(info, "tcp", port) && !KiwiFirewall.allows({ enabled, rules, protectedPorts: info.protectedPorts }, "tcp", port)) {
        return fail(`This would block port ${port}, which you are using to reach the panel. Allow it first.`);
    }
    try {
        const r = await KiwiFirewall.update(enabled, rules);
        revalidatePath("/firewall");
        if (!r.ok) return fail(r.error ?? "Could not apply the firewall rules");
        return done(r.needsConfirm ? "Applied. Keep the change within 60 seconds or it is undone." : "Applied");
    } catch (e) {
        return fail((e as Error).message);
    }
}

export async function setFirewallEnabled(enabled: boolean, _: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    const info = await KiwiFirewall.info().catch(() => null);
    if (!info) return fail("The kiwin daemon is unreachable");
    return applyFirewall(enabled, info.rules);
}

export async function addFirewallRule(_: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    const m = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/.exec(text(fd, "port"));
    if (!m) return fail("Port: a number like 8080 or a range like 8000-8100");
    const port = Number(m[1]);
    const to = m[2] ? Number(m[2]) : undefined;
    if (port < 1 || port > 65535 || (to !== undefined && (to <= port || to > 65535))) return fail("Ports must be 1-65535, ranges low-high");
    const protos: Proto[] = text(fd, "proto") === "udp" ? ["udp"] : text(fd, "proto") === "both" ? ["tcp", "udp"] : ["tcp"];
    const comment = text(fd, "comment").slice(0, 80) || undefined;
    const info = await KiwiFirewall.info().catch(() => null);
    if (!info) return fail("The kiwin daemon is unreachable");
    const added = protos.filter((proto) => !info.rules.some((r) => r.proto === proto && r.port === port && r.to === to));
    if (added.length === 0) return fail("That port is already allowed");
    return applyFirewall(info.enabled, [...info.rules, ...added.map((proto) => ({ port, ...(to ? { to } : {}), proto, ...(comment ? { comment } : {}) }))]);
}

export async function allowPort(proto: Proto, port: number, _: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    const info = await KiwiFirewall.info().catch(() => null);
    if (!info) return fail("The kiwin daemon is unreachable");
    if (KiwiFirewall.allows(info, proto, port)) return done("Already allowed");
    return applyFirewall(info.enabled, [...info.rules, { port, proto }]);
}

export async function removeFirewallRule(proto: Proto, port: number, to: number | null, _: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    const info = await KiwiFirewall.info().catch(() => null);
    if (!info) return fail("The kiwin daemon is unreachable");
    return applyFirewall(info.enabled, info.rules.filter((r) => !(r.proto === proto && r.port === port && (r.to ?? null) === to)));
}

export async function confirmFirewall(): Promise<void> {
    await requireUser();
    await KiwiFirewall.confirm().catch(() => {});
    revalidatePath("/firewall");
}

export async function revertFirewall(): Promise<void> {
    await requireUser();
    await KiwiFirewall.revert().catch(() => {});
    revalidatePath("/firewall");
}

// ---- Archives (7-Zip applet in Files) -------------------------------------

export async function fileExtract(path: string, folder: string): Promise<string | null> {
    return fileOp(() => KiwiArchive.extract(path, folder));
}

export async function fileCompress(paths: string[], archive: string): Promise<string | null> {
    return fileOp(() => KiwiArchive.compress(paths, archive));
}

// ---- PM2 --------------------------------------------------------------------

export async function installPm2(_: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    try {
        await KiwiPm2.install();
    } catch (e) {
        return fail(`PM2 install failed: ${(e as Error).message}`);
    }
    revalidatePath("/", "layout");
    return done(`PM2 ${KiwiPm2.version() ?? ""} installed`);
}

export async function uninstallPm2(_: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    try {
        await KiwiPm2.uninstall();
    } catch (e) {
        return fail((e as Error).message);
    }
    revalidatePath("/", "layout");
    return done("PM2 removed");
}

/** KEY=VALUE per line; blank lines and # comments are skipped. */
function parseEnv(textValue: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of textValue.split(/\r?\n/)) {
        const l = line.trim();
        if (!l || l.startsWith("#")) continue;
        const i = l.indexOf("=");
        if (i <= 0) throw new Error(`Environment: "${l}" is not KEY=VALUE`);
        env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    }
    return env;
}

/** Subfolders of a directory, for folder pickers. */
export async function listFolders(path: string): Promise<{ path: string; parent: string | null; dirs: string[] } | { error: string }> {
    await requireUser();
    const dir = clean(path);
    try {
        const dirs = KiwiFiles.list(dir).filter((e) => e.type === "dir").map((e) => e.name);
        return { path: dir, parent: dir === "/" ? null : posix.dirname(dir), dirs };
    } catch (e) {
        return { error: (e as NodeJS.ErrnoException).code === "ENOENT" ? `${dir} does not exist` : (e as Error).message };
    }
}

export async function savePm2App(replacing: string | null, _: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    try {
        const input = { name: text(fd, "name"), command: text(fd, "command"), cwd: text(fd, "cwd"), env: parseEnv(raw(fd, "env")) };
        await KiwiPm2.save(input, replacing ?? undefined);
        revalidatePath("/pm2");
        return done(replacing ? `${input.name} updated and restarted` : `${input.name} started`);
    } catch (e) {
        return fail((e as Error).message);
    }
}

export async function pm2Op(name: string, op: "start" | "stop" | "restart" | "delete", _: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    try {
        await KiwiPm2.op(name, op);
    } catch (e) {
        return fail((e as Error).message);
    }
    revalidatePath("/pm2");
    return done(`${name}: ${op === "delete" ? "deleted" : `${op}${op === "stop" ? "ped" : "ed"}`}`);
}

// ---- PHP ------------------------------------------------------------------

export async function phpSaveSettings(version: string, _: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    const values = Object.fromEntries(PHP_SETTINGS.map((s) => [s.key, text(fd, s.key)]));
    try {
        await KiwiPhp.saveSettings(version, values);
    } catch (e) {
        return fail((e as Error).message);
    }
    revalidatePath("/php");
    return done("Saved and PHP-FPM reloaded");
}

export async function phpReload(version: string, _: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    try {
        await KiwiPhp.reload(version);
    } catch (e) {
        return fail((e as Error).message);
    }
    revalidatePath("/php");
    return done("Config OK, PHP-FPM reloaded");
}

export async function phpSetModule(version: string, mod: string, sapi: Sapi, on: boolean, _: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    try {
        await KiwiPhp.setModule(version, mod, sapi, on);
    } catch (e) {
        return fail((e as Error).message);
    }
    revalidatePath("/php/extensions");
    return done(`${mod} ${on ? "enabled" : "disabled"} for ${sapi.toUpperCase()}`);
}

export async function phpInstallExtension(version: string, pkg: string, _: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    try {
        const added = await KiwiPhp.installExtension(version, pkg);
        revalidatePath("/php/extensions");
        return done(added.length ? `Installed ${added.join(", ")}` : "Already installed");
    } catch (e) {
        return fail((e as Error).message);
    }
}

// ---- Desktop (X.org Interface) ----------------------------------------------

export async function stopDesktop(_: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    try {
        await KiwiDesktop.stop();
    } catch (e) {
        return fail((e as Error).message);
    }
    revalidatePath("/desktop");
    return done("Desktop stopped");
}

export async function revealServiceSecret(id: string, _: ActionState, fd: FormData): Promise<ActionState> {
    const error = await checkMaster(fd);
    if (error) return fail(error);
    const secrets = KiwiSoftware.serviceSecrets(id);
    if (!Object.keys(secrets).length) return fail("This service has no stored password");
    return done("Anyone with this can sign in to the service.", Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join("\n"));
}

export async function repairSoftware(id: string, _: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    try {
        const r = await KiwiSoftware.repair(id);
        revalidatePath(`/software/${id}`);
        const added = r.added.length ? `Added ${r.added.length} package${r.added.length === 1 ? "" : "s"} (${(r.addedBytes / 1024 / 1024).toFixed(1)} MB): ${r.added.join(", ")}.` : "Nothing was missing.";
        const optional = r.optional.length
            ? ` Still not found (only optional parts use them, or they were left out on purpose to keep the size down): ${r.optional.map((m) => `${m.soname} (for ${m.neededBy[0]})`).join("; ")}.`
            : " All libraries resolve.";
        return done(added + optional);
    } catch (e) {
        return fail(`Repair failed: ${(e as Error).message}`);
    }
}

// ---- Mail ---------------------------------------------------------------------

async function mailOp(path: string, op: () => unknown | Promise<unknown>, message: string): Promise<ActionState> {
    await requireUser();
    try {
        await op();
    } catch (e) {
        return fail((e as Error).message);
    }
    revalidatePath(path);
    return done(message);
}

export async function mailRemoveDomain(domain: string, _: ActionState, __: FormData): Promise<ActionState> {
    return mailOp("/mail", () => KiwiMail.removeDomain(domain), `${domain} removed (its accounts and mail are kept)`);
}

export async function mailSetHostname(_: ActionState, fd: FormData): Promise<ActionState> {
    return mailOp("/mail/config", () => KiwiMail.setHostname(text(fd, "hostname")), "Host name saved; the Mail Server restarted");
}

export async function mailIssueCertificate(_: ActionState, fd: FormData): Promise<ActionState> {
    return mailOp("/mail/config", () => KiwiMail.issueCertificate(text(fd, "email") || undefined), "Certificate issued; TLS ports (465, 587, 993, 143) are on");
}

export async function mailOpenPorts(_: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    try {
        const added = await KiwiMail.openPorts();
        revalidatePath("/mail/config");
        return done(added.length ? `Allowed ${added.join(", ")} in the firewall` : "The firewall already lets the mail ports in (or is off)");
    } catch (e) {
        return fail((e as Error).message);
    }
}

export async function mailRestart(_: ActionState, __: FormData): Promise<ActionState> {
    return mailOp("/mail/config", () => KiwiMail.apply(true), "Mail Server restarted");
}

export async function mailCreateAccount(_: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    const email = text(fd, "email").toLowerCase();
    const password = raw(fd, "password") || randomBytes(15).toString("base64url");
    try {
        KiwiMail.createAccount(email, password);
    } catch (e) {
        return fail((e as Error).message);
    }
    revalidatePath("/mail/accounts");
    return done(`${email} created. Save the password now; it can be changed later but not shown again.`, `email=${email}\npassword=${password}`);
}

export async function mailSetPassword(email: string, _: ActionState, fd: FormData): Promise<ActionState> {
    const error = await checkMaster(fd);
    if (error) return fail(error);
    const password = raw(fd, "new_password") || randomBytes(15).toString("base64url");
    try {
        KiwiMail.setPassword(email, password);
    } catch (e) {
        return fail((e as Error).message);
    }
    return done(`Password of ${email} changed. Mail apps signed in with the old one must sign in again.`, `email=${email}\npassword=${password}`);
}

export async function mailDeleteAccount(email: string, _: ActionState, __: FormData): Promise<ActionState> {
    return mailOp("/mail/accounts", () => KiwiMail.deleteAccount(email), `${email} and its mail deleted`);
}

export async function mailDeployWebmail(_: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    try {
        const url = await KiwiMail.deployWebmail();
        revalidatePath("/mail/webmail");
        return done(`Webmail is at ${url}`);
    } catch (e) {
        return fail((e as Error).message);
    }
}

export async function mailRevealWebmailAdmin(_: ActionState, fd: FormData): Promise<ActionState> {
    const error = await checkMaster(fd);
    if (error) return fail(error);
    const pw = KiwiMail.webmailAdminPassword();
    if (!pw) return fail("SnappyMail creates its admin password the first time its admin page is opened; open it once, then try again");
    return done("SnappyMail admin (user: admin). Change it in the admin panel.", `user=admin\npassword=${pw}`);
}

// ---- Website nginx config -------------------------------------------------------

/** Save a website's hand-edited nginx config; returns nginx's error, or null once reloaded. */
export async function saveSiteConfig(domain: string, content: string): Promise<string | null> {
    await requireUser();
    if (!(await KiwiNginx.saveConfig(domain, content))) return KiwiNginx.lastError ?? "nginx rejected the configuration";
    revalidatePath(`/websites/${domain}`);
    return null;
}

export async function resetSiteConfig(domain: string, _: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    if (!(await KiwiNginx.saveConfig(domain, null))) return fail(KiwiNginx.lastError ?? "Could not reset the configuration");
    revalidatePath(`/websites/${domain}`);
    return done("Back to the generated configuration; nginx reloaded");
}
