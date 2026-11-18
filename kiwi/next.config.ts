import type { NextConfig } from "next";

const config: NextConfig = {
    poweredByHeader: false,
    reactStrictMode: true,
    // kiwi has its own lockfile inside the kiwin repo; don't guess the workspace root.
    turbopack: { root: process.cwd() },
    outputFileTracingRoot: process.cwd(),
    // The panel is never meant to be framed by, or to leak addresses to, other sites.
    async headers() {
        return [{
            source: "/:path*",
            headers: [
                { key: "X-Frame-Options", value: "SAMEORIGIN" },
                { key: "Content-Security-Policy", value: "frame-ancestors 'self'; base-uri 'self'; form-action 'self'" },
                { key: "X-Content-Type-Options", value: "nosniff" },
                { key: "Referrer-Policy", value: "same-origin" },
                { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
            ],
        }];
    },
    experimental: {
        serverActions: {
            // File manager uploads go through a Server Action.
            bodySizeLimit: "200mb",
            // Behind a reverse proxy on another host name, list it here, e.g. KIWI_ALLOWED_ORIGINS=panel.example.com
            allowedOrigins: process.env.KIWI_ALLOWED_ORIGINS?.split(",").filter(Boolean),
        },
    },
};

export default config;
