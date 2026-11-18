// Runs once when the kiwi server starts (not during `next build`).
export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
    const { KiwiMysql } = await import("./lib/mysql");
    const { KiwiNginx } = await import("./lib/nginx");
    if (!KiwiMysql.isStorageMounted()) return;

    // Existing storage (created earlier, or unpacked from user.img.zst) gets
    // MySQL set up / started and its redir.json entry added.
    if (KiwiMysql.isInstalled()) {
        KiwiMysql.ensure().then((ok) => console.log(ok ? "MySQL ready" : `MySQL: ${KiwiMysql.lastError}`));
    }
    // Sites managed from the panel live on user storage; nginx includes them.
    if (KiwiNginx.isInstalled()) {
        try {
            KiwiNginx.ensure();
            KiwiNginx.migrateWebRoots()
                .then(() => KiwiNginx.migratePhpPools())
                .catch((e) => console.error(`nginx: ${(e as Error).message}`));
        } catch (e) {
            console.error(`nginx: ${(e as Error).message}`);
        }
        // Let's Encrypt renewals: shortly after start, then twice a day.
        const { KiwiAcme } = await import("./lib/acme");
        const renew = () => KiwiAcme.renewDue()
            .then((done) => done.length && console.log(`[acme] renewed: ${done.join(", ")}`))
            .catch((e) => console.error(`[acme] ${(e as Error).message}`));
        setTimeout(renew, 60_000).unref?.();
        setInterval(renew, 12 * 60 * 60 * 1000).unref?.();
    }
}
