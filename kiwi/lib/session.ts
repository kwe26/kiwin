import { randomBytes, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { KiwiAuth, SESSION_COOKIE } from "./auth";

export async function sessionToken(): Promise<string | undefined> {
    return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function currentUser(): Promise<string | null> {
    return KiwiAuth.user(await sessionToken());
}

/** For pages and actions behind the login: the signed-in master, or a redirect to /login. */
export async function requireUser(): Promise<string> {
    const user = await currentUser();
    if (!user) redirect("/login");
    return user;
}

export async function setSession(token: string) {
    // Secure only when served over HTTPS (directly or via a proxy), or the browser would drop it.
    const h = await headers();
    const https = h.get("x-forwarded-proto") === "https";
    (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "strict", secure: https, path: "/" });
}

// The setup code, once given for the storage step, covers the account step in the same browser.
const SETUP_COOKIE = "kiwi_setup";
const setup = ((globalThis as any).__kiwiSetup ??= { token: null, expires: 0 }) as { token: string | null; expires: number };

export async function rememberSetupCode() {
    setup.token = randomBytes(24).toString("base64url");
    setup.expires = Date.now() + 30 * 60_000;
    (await cookies()).set(SETUP_COOKIE, setup.token, { httpOnly: true, sameSite: "strict", path: "/", maxAge: 30 * 60 });
}

export async function setupCodeGiven(): Promise<boolean> {
    const given = (await cookies()).get(SETUP_COOKIE)?.value;
    if (!given || !setup.token || setup.expires < Date.now() || given.length !== setup.token.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(setup.token));
}

export async function clearSession() {
    (await cookies()).delete(SESSION_COOKIE);
}
