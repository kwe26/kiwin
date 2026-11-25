import { chmodSync, copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statfsSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { agent } from "./host";
import { KiwiFirewall } from "./firewall";
import { missingLibraries, packageCandidates, type MissingLibrary } from "./elf";
import { DEB_CACHE, SOURCES, prune, cachedIndex, loadIndex, recordPackages, resolve as resolveDebs, rootPackages, systemPackages, unpack as unpackDebs } from "./debs";
import { KiwiPhp } from "./php";
import { KiwiDesktop } from "./desktop";
import { KiwiMail } from "./mail";

// Software installer for kiwi. Everything lives on user.img, never in the
// system image:
//
//   /www/repo.json                    catalogue (seeded with Node.js, Bun and Gitea)
//   /www/softwares/<id>/<version>/    unpacked release
//   /www/softwares/<id>/current       -> <version>, the default version
//   /www/softwares/bin/<cmd>          -> ../<id>/current/<bin>/<cmd>
//   /www/apps/<id>/                   data of an app run as a service
//   /www/services/<id>.json           its isol unit (user units, see src/agent)
//
// /www/softwares/bin is on PATH for shells, SSH and services (kiwin puts it
// there; see SANDBOX_PATH in src/sandbox.ts), so nothing under /etc changes.

export const SOFTWARE_DIR = "/www/softwares";
export const SOFTWARE_BIN = join(SOFTWARE_DIR, "bin");
/**
 * PATH for finding and running installed software. kiwin also puts
 * SOFTWARE_BIN on the isolation's PATH, but only from the daemon start after
 * it was added, so never rely on the inherited one alone.
 */
export const SOFTWARE_PATH = `${SOFTWARE_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
/** True if `command` is on PATH, including software installed from the Software page. */
export const hasCommand = (command: string) => !!Bun.which(command, { PATH: SOFTWARE_PATH });
export const REPO_FILE = "/www/repo.json";
const DOWNLOADS = join(SOFTWARE_DIR, ".downloads");

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+~_-]{0,63}$/;
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,63}$/;
const TAR = /\.(tar\.xz|tar\.gz|tgz|tar\.bz2|tar\.zst)$/;
/** Bumped when DEFAULT_REPO gains software, so existing repo.json files pick it up once. */
const REPO_VERSION = 11;
/** Fields of a default entry that a repo.json upgrade refreshes (the name, icon and homepage stay as edited). */
const MANAGED_KEYS = [
    "summary", "description", "developer", "format", "bin", "binary", "links", "strip", "releases", "service", "deb",
    "needs", "section", "debs", "launchers", "desktop",
] as const;
export const APPS_DIR = "/www/apps";
export const SERVICES_DIR = "/www/services";
const RELEASES_TTL_MS = 60 * 60 * 1000;

export interface SoftwareVersion {
    version: string;
    /**
     * A tarball (.tar.xz / .tar.gz / .tgz / .tar.bz2) or .zip, unpacked with its
     * single top directory stripped, or (format "binary") one executable.
     */
    url: string;
    /** Optional hex SHA-256 of the archive, checked before unpacking. */
    sha256?: string;
    /** Download size in bytes, for display. */
    size?: number;
    /** Release label, e.g. "LTS" or "Latest". */
    channel?: string;
}

/** Versions read from GitHub releases, merged in front of the static `versions`. */
export interface SoftwareReleases {
    /**
     * "github" (default): GitHub releases. "vscode": Microsoft's VS Code update
     * service. "firefox": Mozilla's current release and ESR. The last two need no other fields.
     */
    provider?: "github" | "vscode" | "firefox";
    /** "owner/repo" */
    github: string;
    /** Tag name for a version, e.g. "bun-v{version}" or "v{version}". */
    tag: string;
    /**
     * Release asset to download, e.g. "bun-linux-x64.zip" or "gitea-{version}-linux-amd64".
     * {compact} is the version without dots ("26.05" -> "2605").
     */
    asset: string;
    /** Download from here instead of GitHub (its checksum still comes from the GitHub asset). */
    url?: string;
    prerelease?: boolean;
    /** How many releases to list (default 15). */
    limit?: number;
}

export interface Software {
    id: string;
    name: string;
    summary: string;
    /** Paragraphs separated by blank lines. */
    description: string;
    icon: string;
    developer?: string;
    homepage?: string;
    license?: string;
    category?: string;
    /** Directory inside a release whose executables are linked into /www/softwares/bin. */
    bin: string;
    /** "tar" / "zip" / "binary" (guessed from the URL when missing), or "deb": Ubuntu packages, see `deb`. */
    format?: "tar" | "zip" | "binary" | "deb";
    deb?: SoftwareDeb;
    /** For format "binary": the command name the file is saved as (default: the id). */
    binary?: string;
    /** Extra commands created inside `bin`, e.g. { "bunx": "bun" }. */
    links?: Record<string, string>;
    /** Leading path components to drop when unpacking a tarball (default 1). */
    strip?: number;
    releases?: SoftwareReleases;
    /** Offer to run it as a service after installing. */
    service?: SoftwareService;
    /** Other software that must be installed first; the entry is hidden from the catalogue until it is. */
    needs?: string[];
    /** Catalogue section; "desktop" lists it under Desktop apps (with needs: ["xorg"]). */
    section?: "desktop";
    /**
     * Ubuntu packages unpacked into <version>/root next to a downloaded release,
     * for libraries it expects from the system (e.g. Electron's). Packages that
     * the software in `have` already bundles count as present.
     */
    debs?: { packages: string[]; exclude?: string[]; have?: string[] };
    /**
     * Wrapper commands written into `bin`, putting <version>/root's libraries
     * first. In exec/args/env, {dir} is the version directory.
     */
    launchers?: Record<string, { exec: string; args?: string[]; env?: Record<string, string> }>;
    /** An entry for the X.org desktop's menu. */
    desktop?: { name: string; command: string };
    /** Newest first. */
    versions: SoftwareVersion[];
}

/**
 * Software made of Ubuntu packages from the archive, unpacked into
 * /www/softwares/<id>/<version>/root (see lib/debs.ts) with wrapper commands
 * in <version>/bin that point the binaries at their bundled libraries.
 */
export interface SoftwareDeb {
    /** Extra package sources besides Ubuntu's archive (names from SOURCES in lib/debs.ts). */
    sources?: string[];
    /**
     * Versions that install side by side (e.g. PHP "8.4", "8.3"), each in its
     * own <variant>/ directory. "{v}" in every other field becomes the variant.
     * Without variants there is one version: whatever the archive has now.
     */
    variants?: string[];
    /** A file (relative to a version directory) that exists when variant {v} is installed. */
    probe?: string;
    packages: string[];
    /** Installed when the archive has them (e.g. php8.4-opcache; PHP 8.5 has opcache built in). */
    optional?: string[];
    /** Package whose version is the software's version. */
    versionOf: string;
    /** Commands to create: path inside the root, fixed leading args, env ({root} = the root). */
    commands: Record<string, { exec: string; args?: string[]; env?: Record<string, string> }>;
    /** Packages matching this (regex) are carried over from the current version on upgrade, e.g. installed extensions. */
    carry?: string;
    /** Dependencies to leave out (treated as present), e.g. GL drivers a VNC server never loads. */
    exclude?: string[];
    /** Packages bundled by this other software count as present (desktop apps reuse X.org Interface's GTK). */
    have?: string[];
    /**
     * Rewrite a NUL-terminated path compiled into a binary, for programs that
     * look for a helper at a fixed system path. `to` must not be longer than `from`.
     */
    patches?: { file: string; from: string; to: string }[];
}

/**
 * How to run an app as an isol service. In `exec`, `env` and `cwd`:
 * {bin} = /www/softwares/<id>/current/<bin>, {data} = /www/apps/<id>, {port}.
 */
export interface SoftwareService {
    description: string;
    defaultPort: number;
    exec: string[];
    env?: Record<string, string>;
    /** Numeric uid/gid to run as (no /etc/passwd entry needed); {data} is chowned to it. Default: root. */
    uid?: number;
    /** Commands it needs at runtime, with a hint when missing. */
    requires?: { command: string; hint: string }[];
    /** Shown after the service is created, e.g. "Open http://host:{port} to finish the setup". */
    note?: string;
    /**
     * Random values generated once per service, usable as {secret:<name>} (e.g.
     * a login password). Kept in the root-only unit file; shown with the master password.
     */
    secrets?: string[];
}

export interface ServiceStatus {
    port: number;
    state: string;
    enabled: boolean;
    pid: number | null;
    error: string | null;
}

export interface InstallJob {
    id: string;
    version: string;
    /** "installed": files are in place, "service": setting up the service, then "done". */
    phase: "resolving" | "downloading" | "verifying" | "unpacking" | "installed" | "service" | "done" | "error";
    received: number;
    total: number | null;
    error: string | null;
    startedAt: number;
}

/**
 * Packages the X.org desktop and its apps leave out: GL drivers (Xvnc renders
 * in software), Ghostscript, Python, D-Bus and other services nothing here uses.
 */
const DESKTOP_EXCLUDE = [
    "libgl1-mesa-dri", "mesa-libgallium", "libllvm20", "libgbm1", "libvulkan1", "libglx-mesa0",
    "libgs10", "libgs10-common", "libgs-common", "poppler-data", "fonts-urw-base35", "libspectre1",
    "python3", "python3-minimal", "python3.12", "python3.12-minimal", "libpython3-stdlib", "libpython3.12-stdlib", "libpython3.12-minimal",
    "dbus", "dbus-daemon", "dbus-bin", "dbus-user-session", "dbus-system-bus-common", "dbus-session-bus-common", "libpam-systemd",
    "dconf-service", "dconf-gsettings-backend", "libheif-plugin-aomdec", "libaom3", "libcups2t64",
    "libavahi-client3", "libavahi-common3", "libavahi-common-data", "libsensors5", "libsensors-config",
    "humanity-icon-theme", "ubuntu-mono",
    // Only TigerVNC's vncserver helper script uses Perl; kiwi starts Xvnc itself.
    "perl", "perl-base", "perl-modules-5.38", "libperl5.38t64", "libfile-readbackwards-perl",
];

/** A GTK app from Ubuntu's packages for the X.org desktop, reusing X.org Interface's libraries. */
function desktopApp(a: {
    id: string; name: string; menu: string; summary: string; description: string; icon: string;
    developer: string; homepage: string; license: string; packages: string[]; command: string; version: string;
}): Software {
    return {
        id: a.id,
        name: a.name,
        summary: a.summary,
        description: a.description + "\n\nInstalled from Ubuntu's packages, reusing the X.org Interface's libraries. Open it from the desktop's right-click menu.",
        icon: a.icon,
        developer: a.developer,
        homepage: a.homepage,
        license: a.license,
        category: "Desktop Apps",
        section: "desktop",
        needs: ["xorg"],
        format: "deb",
        bin: "bin",
        deb: {
            packages: [...a.packages, "libglib2.0-bin"],
            versionOf: a.packages[0],
            commands: { [a.command]: { exec: `usr/bin/${a.command}` } },
            exclude: DESKTOP_EXCLUDE,
            have: ["xorg"],
        },
        desktop: { name: a.menu, command: a.command },
        versions: [{ version: a.version, url: `deb:${a.packages[0]}`, channel: "Ubuntu" }],
    };
}

const DEFAULT_REPO: { version: number; software: Software[] } = {
    version: REPO_VERSION,
    software: [
        {
            id: "nodejs",
            name: "Node.js",
            summary: "JavaScript runtime built on Chrome's V8 engine",
            description:
                "Node.js is a free, open-source, cross-platform JavaScript runtime environment that lets developers create servers, web apps, command line tools and scripts.\n\n" +
                "Installs node, npm, npx and corepack. Run apps from your storage with Services, or behind a Proxy website.",
            icon: "https://nodejs.org/static/images/favicons/favicon.png",
            developer: "OpenJS Foundation",
            homepage: "https://nodejs.org",
            license: "MIT",
            category: "Developer Tools",
            bin: "bin",
            versions: [
                {
                    version: "24.22.1", channel: "LTS",
                    url: "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz",
                    sha256: "6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6", size: 32026916,
                },
                {
                    version: "22.23.4", channel: "LTS",
                    url: "https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.xz",
                    sha256: "1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce",
                },
                {
                    version: "20.20.2", channel: "LTS",
                    url: "https://nodejs.org/dist/v20.20.2/node-v20.20.2-linux-x64.tar.xz",
                    sha256: "df770b2a6f130ed8627c9782c988fda9669fa23898329a61a871e32f965e007d",
                },
            ],
        },
        {
            id: "bun",
            name: "Bun",
            summary: "Fast all-in-one JavaScript runtime, bundler, test runner and package manager",
            description:
                "Bun is a JavaScript and TypeScript runtime designed as a drop-in replacement for Node.js, with a built-in bundler, test runner and npm-compatible package manager.\n\n" +
                "Installs bun and bunx. Versions are read from Bun's GitHub releases.",
            icon: "https://avatars.githubusercontent.com/u/108928776?s=200&v=4",
            developer: "Oven",
            homepage: "https://bun.sh",
            license: "MIT",
            category: "Developer Tools",
            format: "zip",
            bin: ".",
            links: { bunx: "bun" },
            releases: { github: "oven-sh/bun", tag: "bun-v{version}", asset: "bun-linux-x64.zip" },
            versions: [
                {
                    version: "1.4.4",
                    url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip",
                    sha256: "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c", size: 51794595,
                },
            ],
        },
        {
            id: "gitea",
            name: "Gitea",
            summary: "Painless self-hosted Git service",
            description:
                "Gitea is a lightweight, self-hosted Git forge with code review, issues, CI (Actions), package registries and a web UI, shipped as a single binary.\n\n" +
                "Installs the gitea command and can run it as a service on a port you choose, as its own user (uid 2001) with its data in /www/apps/gitea. Publish it with a Proxy website.",
            icon: "https://raw.githubusercontent.com/go-gitea/gitea/main/public/assets/img/logo.svg",
            developer: "The Gitea Authors",
            homepage: "https://about.gitea.com",
            license: "MIT",
            category: "Developer Tools",
            format: "binary",
            binary: "gitea",
            bin: "bin",
            releases: {
                github: "go-gitea/gitea", tag: "v{version}", asset: "gitea-{version}-linux-amd64",
                url: "https://dl.gitea.com/gitea/{version}/gitea-{version}-linux-amd64",
            },
            service: {
                description: "Gitea (installed from Software)",
                defaultPort: 3000,
                exec: ["{bin}/gitea", "web", "--port", "{port}", "--work-path", "{data}", "--custom-path", "{data}/custom", "--config", "{data}/custom/conf/app.ini"],
                env: { HOME: "{data}", USER: "gitea", GITEA_WORK_DIR: "{data}" },
                uid: 2001,
                requires: [{ command: "git", hint: "Gitea needs Git: install Git from Software first (or in the system image from the host)." }],
                note: "Open port {port} in your browser to finish Gitea's setup (SQLite needs no extra database). Data lives in {data}.",
            },
            versions: [
                {
                    version: "1.27.3",
                    url: "https://dl.gitea.com/gitea/1.27.3/gitea-1.27.3-linux-amd64",
                    sha256: "4da93c2c10b6980c359bcb86d5573ebfd7770e2e151756534edee24c8c12d971", size: 126007248,
                },
            ],
        },
        {
            id: "7zip",
            name: "7-Zip",
            summary: "File archiver with a high compression ratio",
            description:
                "7-Zip packs and unpacks 7z, ZIP, TAR, GZIP, XZ, BZIP2 and ZSTD, and unpacks many more formats including RAR, ISO and CAB.\n\n" +
                "Installs 7zz (and 7z). Once installed, the Files page gets Extract and Compress actions.",
            icon: "https://www.7-zip.org/7ziplogo.png",
            developer: "Igor Pavlov",
            homepage: "https://www.7-zip.org",
            license: "LGPL-2.1 (with unRAR restriction)",
            category: "Utilities",
            bin: ".",
            strip: 0,
            links: { "7z": "7zz" },
            releases: { github: "ip7z/7zip", tag: "{version}", asset: "7z{compact}-linux-x64.tar.xz" },
            versions: [
                {
                    version: "26.05",
                    url: "https://github.com/ip7z/7zip/releases/download/26.05/7z2605-linux-x64.tar.xz",
                    sha256: "22cf82fcc6eb7474f1d5bb4f02c0f8ebd573a718089d6833dc30f8350a3b232e", size: 1579976,
                },
            ],
        },
        {
            id: "git",
            name: "Git",
            summary: "Distributed version control system",
            description:
                "Git tracks changes in source code and lets you clone, pull and push repositories, including over HTTPS and SSH.\n\n" +
                "Installed from Ubuntu's own packages, unpacked onto your storage with the libraries your system image lacks; nothing is added to the system image.",
            icon: "https://git-scm.com/images/logos/downloads/Git-Icon-1788C.png",
            developer: "The Git Project",
            homepage: "https://git-scm.com",
            license: "GPL-2.0",
            category: "Developer Tools",
            format: "deb",
            bin: "bin",
            deb: {
                packages: ["git"],
                versionOf: "git",
                commands: {
                    git: {
                        exec: "usr/bin/git",
                        env: {
                            GIT_EXEC_PATH: "{root}/usr/lib/git-core",
                            GIT_TEMPLATE_DIR: "{root}/usr/share/git-core/templates",
                            PERL5LIB: "{root}/usr/share/perl5",
                        },
                    },
                },
            },
            versions: [{ version: "2.43.0-1ubuntu7.4", url: "deb:git", channel: "Ubuntu" }],
        },
        {
            id: "php",
            name: "PHP",
            summary: "PHP-FPM and the PHP command line, any version from 7.4 to 8.5, side by side",
            description:
                "PHP-FPM for PHP websites and the php command. Install several versions side by side: each runs its own PHP-FPM, keeps its configuration in /www/php/<version> and can be picked per website.\n\n" +
                "Builds come from Ondřej Surý's PHP repository (the one most Ubuntu servers use for multiple PHP versions), unpacked onto your storage with the libraries they need. " +
                "After installing, the PHP section in the sidebar manages php.ini settings and extensions (MySQL, cURL, GD, mbstring, intl, Redis and more).\n\n" +
                "Every PHP website runs in its own pool as its own user: it can't run shell commands or reach other sites unless you allow it on the website's page. " +
                "PHP 7.4 and 8.0 no longer get fixes from the PHP project (these builds carry backported security patches): use them only for sites that can't run on a newer version.",
            icon: "https://www.php.net/images/logos/new-php-logo.svg",
            developer: "The PHP Group; packages by Ondřej Surý",
            homepage: "https://www.php.net",
            license: "PHP-3.01",
            category: "Developer Tools",
            format: "deb",
            bin: "bin",
            deb: {
                sources: ["ondrej-php"],
                variants: ["8.5", "8.4", "8.3", "8.2", "8.1", "8.0", "7.4"],
                probe: "root/usr/sbin/php-fpm{v}",
                packages: ["php{v}-fpm", "php{v}-cli"],
                optional: ["php{v}-opcache", "php{v}-mysql", "php{v}-mbstring", "php{v}-xml", "php{v}-curl", "php{v}-zip"],
                versionOf: "php{v}-fpm",
                carry: "^php{v}-",
                commands: {
                    php: { exec: "usr/bin/php{v}", args: ["-c", "/www/php/{v}/cli/php.ini"], env: { PHP_INI_SCAN_DIR: "/www/php/{v}/cli/conf.d" } },
                    "php{v}": { exec: "usr/bin/php{v}", args: ["-c", "/www/php/{v}/cli/php.ini"], env: { PHP_INI_SCAN_DIR: "/www/php/{v}/cli/conf.d" } },
                    "php-fpm{v}": {
                        exec: "usr/sbin/php-fpm{v}",
                        args: ["-c", "/www/php/{v}/fpm/php.ini", "--fpm-config", "/www/php/{v}/fpm/php-fpm.conf"],
                        env: { PHP_INI_SCAN_DIR: "/www/php/{v}/fpm/conf.d" },
                    },
                },
            },
            versions: [],
        },
        {
            id: "xorg",
            name: "X.org Interface",
            summary: "A lightweight graphical desktop you use from the panel",
            description:
                "An X.org desktop (TigerVNC's X server, the Openbox window manager, the tint2 panel and xterm) that runs inside the system and is shown in the panel's Desktop page, full screen if you like.\n\n" +
                "Nothing is exposed to the network: the panel talks to the desktop over a private socket, behind your login. Installed from Ubuntu's packages onto your storage (about 25 MB).",
            icon: "https://www.x.org/wiki/logo.png",
            developer: "X.Org Foundation, TigerVNC, Openbox",
            homepage: "https://www.x.org",
            license: "MIT, GPL-2.0",
            category: "Desktop",
            format: "deb",
            bin: "bin",
            deb: {
                packages: ["tigervnc-standalone-server", "openbox", "tint2", "xterm", "x11-xkb-utils", "x11-xserver-utils", "xkb-data", "fonts-dejavu-core", "libglib2.0-bin"],
                versionOf: "tigervnc-standalone-server",
                commands: {},
                exclude: DESKTOP_EXCLUDE,
                // Xvnc runs the keymap compiler from /usr/bin/xkbcomp; /run/kx/xkbcomp is linked by the session.
                patches: [{ file: "usr/bin/Xtigervnc", from: "/usr/bin", to: "/run/kx" }],
            },
            versions: [{ version: "1.13.1+dfsg-2build2", url: "deb:tigervnc-standalone-server", channel: "Ubuntu" }],
        },
        {
            id: "qemu",
            name: "QEMU",
            summary: "Run virtual machines, with KVM acceleration and a console in the panel",
            description:
                "QEMU runs full virtual machines on this server: their own kernel, their own disks, their own network. Installing it adds a Virtual Machines page to the panel, where you create machines, manage their disk images and snapshots, and use their screen right here in the browser.\n\n" +
                "Machines are hardware-accelerated with KVM when this server offers it (a bare-metal server, or a VPS with nested virtualization), and fall back to full emulation when it doesn't \u2014 correct either way, but much slower. Includes qemu-img for disk images and OVMF for UEFI guests.\n\n" +
                "A machine's screen never goes on the network: the panel talks to it over a private socket behind your login. Its network is user-mode (no host privileges), so the guest reaches out freely and only the ports you forward reach in.",
            icon: "https://www.qemu.org/assets/images/qemu_head_200x.png",
            developer: "The QEMU Project",
            homepage: "https://www.qemu.org",
            license: "GPL-2.0",
            category: "Virtualization",
            format: "deb",
            bin: "bin",
            deb: {
                // qemu-system-data and seabios (the firmware blobs) come in as dependencies.
                packages: ["qemu-system-x86", "qemu-utils", "ovmf"],
                versionOf: "qemu-system-x86",
                commands: {
                    // QEMU looks for firmware in a compiled-in /usr/share/qemu; point it at the packages'.
                    "qemu-system-x86_64": { exec: "usr/bin/qemu-system-x86_64", args: ["-L", "{root}/usr/share/qemu"] },
                    "qemu-img": { exec: "usr/bin/qemu-img" },
                    "qemu-io": { exec: "usr/bin/qemu-io" },
                },
                // Ubuntu ships SPICE, OpenGL and audio backends as separate modules
                // (Recommends, so not installed): nothing here loads them.
                exclude: ["libgl1-mesa-dri", "mesa-libgallium", "libllvm20", "libgbm1", "libvulkan1", "libglx-mesa0"],
            },
            versions: [{ version: "1:8.2.2+ds-0ubuntu1", url: "deb:qemu-system-x86", channel: "Ubuntu" }],
        },
        {
            id: "code-server",
            name: "VSCode (Code-Server)",
            summary: "VS Code in your browser, served from this server",
            description:
                "code-server runs Visual Studio Code on the server and shows it in any browser: the editor, extensions, the integrated terminal and Git, working on your files in /www.\n\n" +
                "Runs as a service on a port you choose and asks for a generated password (shown on this page with your master password). " +
                "It runs as root inside the system, so its terminal is a root shell: keep the port behind the firewall or a Proxy website with HTTPS.",
            icon: "https://raw.githubusercontent.com/coder/code-server/main/src/browser/media/pwa-icon-192.png",
            developer: "Coder",
            homepage: "https://coder.com/docs/code-server",
            license: "MIT",
            category: "Developer Tools",
            bin: "bin",
            releases: { github: "coder/code-server", tag: "v{version}", asset: "code-server-{version}-linux-amd64.tar.gz", limit: 8 },
            service: {
                description: "VSCode (Code-Server), installed from Software",
                defaultPort: 8080,
                exec: [
                    "{bin}/code-server", "--bind-addr", "0.0.0.0:{port}", "--auth", "password",
                    "--config", "{data}/config.yaml",
                    "--user-data-dir", "{data}/user-data", "--extensions-dir", "{data}/extensions",
                    "--disable-telemetry", "--disable-update-check", "/www",
                ],
                // Pin every per-user directory to {data}: as root it would otherwise fall back to /root (the system image).
                env: {
                    PASSWORD: "{secret:password}", HOME: "{data}",
                    XDG_CONFIG_HOME: "{data}/.config", XDG_DATA_HOME: "{data}/.local/share",
                    XDG_CACHE_HOME: "{data}/.cache", XDG_STATE_HOME: "{data}/.local/state",
                },
                secrets: ["password"],
                note: "Open port {port} of this server in your browser and sign in with the password below. Settings and extensions live in {data}.",
            },
            versions: [
                {
                    version: "4.143.1",
                    url: "https://github.com/coder/code-server/releases/download/v4.143.1/code-server-4.143.1-linux-amd64.tar.gz",
                    sha256: "614877cf71005f14ea252bd2d9b1c12237cf7d73681ef150f0dff7f13849fdb5", size: 229583113,
                },
            ],
        },
        {
            id: "vscode",
            name: "VSCode (X)",
            summary: "The Visual Studio Code desktop app, in the X.org desktop",
            description:
                "Microsoft's Visual Studio Code, running in the panel's Desktop (X.org Interface). Open it from the desktop's right-click menu or the panel.\n\n" +
                "The libraries Electron needs that the system lacks (NSS, ALSA, GBM, libsecret…) are unpacked next to it from Ubuntu's packages. " +
                "It runs as root without Chromium's sandbox and without GPU acceleration; settings and extensions live in /www/.desktop/.vscode.",
            icon: "https://raw.githubusercontent.com/microsoft/vscode/main/resources/linux/code.png",
            developer: "Microsoft",
            homepage: "https://code.visualstudio.com",
            license: "Microsoft Software License",
            category: "Desktop Apps",
            section: "desktop",
            needs: ["xorg"],
            bin: "launch",
            releases: { provider: "vscode", github: "", tag: "", asset: "", limit: 6 },
            debs: {
                packages: [
                    "libnss3", "libnspr4", "libasound2t64", "libgbm1", "libsecret-1-0", "libxkbfile1", "libgtk-3-0t64",
                    "libxss1", "libxshmfence1", "libdrm2", "libatk-bridge2.0-0t64", "libatspi2.0-0t64", "libxcomposite1",
                    "libxdamage1", "libxrandr2", "libxkbcommon0", "libdbus-1-3", "libcups2t64",
                ],
                // libgbm only loads Mesa's drivers when asked to; Electron runs with --disable-gpu.
                // libcups (linked by Electron) needs Avahi's client libraries, so those stay in.
                exclude: ["mesa-libgallium", "libllvm20", "libgl1-mesa-dri", "libvulkan1"],
                have: ["xorg"],
            },
            launchers: {
                code: {
                    exec: "bin/code",
                    args: ["--no-sandbox", "--disable-gpu", "--user-data-dir", "/www/.desktop/.vscode/data", "--extensions-dir", "/www/.desktop/.vscode/extensions"],
                },
            },
            desktop: { name: "Visual Studio Code", command: "code" },
            versions: [
                {
                    version: "1.143.1",
                    url: "https://vscode.download.prss.microsoft.com/dbazure/download/stable/e646868227c3e3a9e3f24277c8c7220be42c0be7/code-stable-x64-1792691793.tar.gz",
                    sha256: "48f658052e54e020a1c1be7b37ac0f9ae39f07e8ccda805c63f053cfda72b2be",
                },
            ],
        },
        {
            id: "mail",
            name: "Mail Server",
            summary: "Your own email: SMTP, IMAP, DKIM, SPF and DMARC in one service",
            description:
                "Maddy, a complete mail server in one program: receives mail for your domains (SMTP), lets mail apps send (submission, ports 465 and 587) and read it (IMAP, ports 993 and 143), signs outgoing mail with DKIM and checks incoming SPF, DKIM and DMARC.\n\n" +
                "Everything lives on your storage in /www/apps/mail: settings, accounts, mailboxes and DKIM keys. After installing, the Mail section in the sidebar adds domains (with the DNS records to set and a live check), accounts, webmail and the TLS certificate, and opens the mail ports.",
            icon: "https://raw.githubusercontent.com/PapirusDevelopmentTeam/papirus-icon-theme/master/Papirus/64x64/apps/internet-mail.svg",
            developer: "Max Mazurov (foxcpp) and contributors",
            homepage: "https://maddy.email",
            license: "GPL-3.0",
            category: "Servers",
            bin: ".",
            strip: 2,
            releases: { github: "foxcpp/maddy", tag: "v{version}", asset: "maddy-{version}-x86_64-linux-musl.tar.zst", limit: 6 },
            versions: [
                {
                    version: "0.9.6",
                    url: "https://github.com/foxcpp/maddy/releases/download/v0.9.6/maddy-0.9.6-x86_64-linux-musl.tar.zst",
                    sha256: "96eb6945c3b08b09602c5965abeafa7143430afd826892d4446c5a9c3f880cdd", size: 23782034,
                },
            ],
        },
        {
            id: "snappymail",
            name: "SnappyMail",
            summary: "Webmail for your Mail Server",
            description:
                "SnappyMail is a fast, modern webmail: read and write mail in the browser, with folders, search, contacts and PGP.\n\n" +
                "Mail > Webmail publishes it on your mail host name (e.g. https://mail.example.com) and connects it to the Mail Server. Its data lives in /www/apps/snappymail, outside the web root. Needs PHP.",
            icon: "https://raw.githubusercontent.com/the-djmaze/snappymail/master/snappymail/v/0.0.0/static/apple-touch-icon.png",
            developer: "SnappyMail (the-djmaze)",
            homepage: "https://snappymail.eu",
            license: "AGPL-3.0",
            category: "Servers",
            needs: ["mail", "php"],
            bin: ".",
            strip: 0,
            releases: { github: "the-djmaze/snappymail", tag: "v{version}", asset: "snappymail-{version}.tar.gz", limit: 6 },
            versions: [
                {
                    version: "2.38.2",
                    url: "https://github.com/the-djmaze/snappymail/releases/download/v2.38.2/snappymail-2.38.2.tar.gz",
                    sha256: "71f1d8a9065cc9cf7ddd064f5c47cc7b255cb70e6a56713647fc73d4b79e33ec", size: 6816164,
                },
            ],
        },
        {
            id: "firefox",
            name: "Firefox",
            summary: "Mozilla's web browser, in the X.org desktop",
            description:
                "Firefox from Mozilla (the current release or ESR), running in the panel's Desktop. Handy for opening web apps and admin pages that only listen on this server.\n\n" +
                "Runs as root without its process sandbox and without GPU acceleration; its profile lives in /www/.desktop/.mozilla.",
            icon: "https://raw.githubusercontent.com/PapirusDevelopmentTeam/papirus-icon-theme/master/Papirus/64x64/apps/firefox.svg",
            developer: "Mozilla",
            homepage: "https://www.mozilla.org/firefox/",
            license: "MPL-2.0",
            category: "Desktop Apps",
            section: "desktop",
            needs: ["xorg"],
            bin: "launch",
            releases: { provider: "firefox", github: "", tag: "", asset: "" },
            debs: { packages: ["libasound2t64", "libdbus-glib-1-2", "libpci3"], exclude: DESKTOP_EXCLUDE, have: ["xorg"] },
            launchers: {
                firefox: {
                    exec: "firefox",
                    // Its sandboxes need namespaces and seccomp setups root inside the isolation can't make.
                    env: { MOZ_DISABLE_CONTENT_SANDBOX: "1", MOZ_DISABLE_GMP_SANDBOX: "1", MOZ_DISABLE_RDD_SANDBOX: "1", MOZ_DISABLE_SOCKET_PROCESS_SANDBOX: "1", MOZ_DISABLE_UTILITY_SANDBOX: "1" },
                },
            },
            desktop: { name: "Firefox", command: "firefox" },
            versions: [
                {
                    version: "158.0.1", channel: "Latest",
                    url: "https://download-installer.cdn.mozilla.net/pub/firefox/releases/158.0.1/linux-x86_64/en-US/firefox-158.0.1.tar.xz",
                    sha256: "dce45470139242cf294eb6ada3d192a9bb334696842b02b71ade448a139eb41a",
                },
            ],
        },
        desktopApp({
            id: "mousepad", name: "Mousepad", menu: "Text Editor", command: "mousepad", version: "0.6.1-1build2",
            summary: "A simple, fast text editor",
            description: "Mousepad, Xfce's text editor: tabs, syntax highlighting, search and replace.",
            icon: "https://raw.githubusercontent.com/PapirusDevelopmentTeam/papirus-icon-theme/master/Papirus/64x64/apps/org.xfce.mousepad.svg",
            developer: "Xfce", homepage: "https://docs.xfce.org/apps/mousepad/start", license: "GPL-2.0",
            packages: ["mousepad"],
        }),
        desktopApp({
            id: "pcmanfm", name: "PCManFM", menu: "File Manager", command: "pcmanfm", version: "1.3.2-4build2",
            summary: "A light file manager with tabs",
            description: "PCManFM, LXDE's file manager: tabs, side pane, drag and drop, and opening files with the desktop's apps.",
            icon: "https://raw.githubusercontent.com/PapirusDevelopmentTeam/papirus-icon-theme/master/Papirus/64x64/apps/system-file-manager.svg",
            developer: "LXDE", homepage: "https://github.com/lxde/pcmanfm", license: "GPL-2.0",
            packages: ["pcmanfm"],
        }),
        desktopApp({
            id: "mtpaint", name: "mtPaint", menu: "Paint (mtPaint)", command: "mtpaint", version: "3.50-0.1build3",
            summary: "A small painting and image editing program",
            description: "mtPaint: paint, crop, resize and convert images, with layers and many file formats.",
            icon: "https://raw.githubusercontent.com/PapirusDevelopmentTeam/papirus-icon-theme/master/Papirus/64x64/apps/mtpaint.svg",
            developer: "Mark Tyler, Dmitry Groshev", homepage: "https://mtpaint.sourceforge.net", license: "GPL-3.0",
            packages: ["mtpaint"],
        }),
    ],
};

// One job per software at a time; survives Next.js loading this module twice.
const jobs = ((globalThis as any).__kiwiSoftwareJobs ??= new Map<string, InstallJob>()) as Map<string, InstallJob>;
const releaseCache = ((globalThis as any).__kiwiReleaseCache ??= new Map<string, { at: number; versions: SoftwareVersion[] }>()) as
    Map<string, { at: number; versions: SoftwareVersion[] }>;

const formatOf = (s: Software, url: string): "tar" | "zip" | "binary" | "deb" =>
    s.format ?? (TAR.test(url) ? "tar" : /\.zip$/.test(url) ? "zip" : "binary");

/** Directory-safe form of a Debian version: no epoch. */
const debVersion = (v: string) => v.replace(/^\d+:/, "");

/** Replace every NUL-delimited occurrence of `from` in a binary with `to`, NUL-padded. */
function patchPath(file: string, from: string, to: string) {
    const buf = readFileSync(file);
    const a = Buffer.from(from + "\0");
    const b = Buffer.alloc(a.length); // zero-filled: the shorter path stays NUL-terminated
    b.write(to);
    let n = 0;
    for (let i = buf.indexOf(a); i >= 0; i = buf.indexOf(a, i + a.length)) {
        if (i > 0 && buf[i - 1] !== 0) continue; // only whole strings, not suffixes of longer ones
        b.copy(buf, i);
        n++;
    }
    if (n === 0) throw new Error(`patch: "${from}" not found in ${file}`);
    writeFileSync(file, buf);
}

/**
 * Compile a root's GSettings schemas (a maintainer script's job; GTK apps abort
 * without them), together with those of the software it runs on (GTK's file
 * chooser lives in X.org Interface's root).
 */
function compileSchemas(root: string, have: string[] = []) {
    const schemas = join(root, "usr/share/glib-2.0/schemas");
    const roots = [root, ...have.map((h) => join(SOFTWARE_DIR, h, "current/root"))];
    const compiler = roots.map((r) => join(r, "usr/bin/glib-compile-schemas")).find(existsSync);
    if (!existsSync(schemas) || !compiler) return;
    for (const other of roots.slice(1).map((r) => join(r, "usr/share/glib-2.0/schemas"))) {
        for (const f of existsSync(other) ? readdirSync(other) : []) {
            if (/\.(gschema\.xml|gschema\.override|enums\.xml)$/.test(f) && !existsSync(join(schemas, f))) copyFileSync(join(other, f), join(schemas, f));
        }
    }
    const c = Bun.spawnSync([compiler, schemas], {
        env: { ...process.env, LD_LIBRARY_PATH: roots.map((r) => `${r}/usr/lib/x86_64-linux-gnu`).join(":") },
        stderr: "pipe",
    });
    if (c.exitCode !== 0) throw new Error(`glib-compile-schemas: ${c.stderr.toString().trim()}`);
}

/**
 * Packages a repair never adds: GPU drivers, WebKit, Ghostscript. What needs
 * them here are optional plugins (GPU backends, a Microsoft sign-in broker,
 * a PostScript image loader) and each would add 30-150 MB.
 */
const REPAIR_SKIP = /^(mesa-libgallium|libgl1-mesa-dri|libllvm\d+|libvulkan1|libwebkit2gtk-.*|libjavascriptcoregtk-.*|libgs\d+|libgs-common|libgs\d+-common|poppler-data)$/;
/** Never let a repair add more than this. */
const REPAIR_MAX_BYTES = 80 * 1024 * 1024;

export interface RepairResult {
    added: string[];
    addedBytes: number;
    /** Still unresolved after the repair: libraries only optional parts need, or skipped on purpose. */
    optional: MissingLibrary[];
}

/** Runs before a version's directory is deleted. */
const PRE_REMOVE: Record<string, (version: string) => Promise<void>> = {
    php: (dir) => KiwiPhp.removeDir(dir),
};

/** Runs after files are in place and linked (first install, or a new default version). */
const POST_INSTALL: Record<string, (version: string) => Promise<void>> = {
    php: (dir) => KiwiPhp.provisionDir(dir),
    xorg: () => KiwiDesktop.provision(KiwiSoftware.desktopApps()),
    mail: () => KiwiMail.provision(),
    // Publishing needs a mail host name and PHP; if it can't happen yet, Mail > Webmail does it later.
    snappymail: () => KiwiMail.deployWebmail().then(() => {}, (e) => console.error(`[snappymail] not published yet: ${(e as Error).message}`)),
};

/**
 * Versions from GitHub releases (cached for an hour; the unauthenticated API
 * allows 60 requests an hour). On failure the last good list, or none.
 */
/** Versions from Microsoft's VS Code update service, with download URL and SHA-256 (cached like GitHub's). */
async function vscodeVersions(r: SoftwareReleases): Promise<SoftwareVersion[]> {
    const key = "vscode";
    const hit = releaseCache.get(key);
    if (hit && Date.now() - hit.at < RELEASES_TTL_MS) return hit.versions;
    try {
        const api = "https://update.code.visualstudio.com/api";
        const list = (await (await fetch(`${api}/releases/stable`, { signal: AbortSignal.timeout(8000) })).json()) as string[];
        const versions = (await Promise.all(list.slice(0, Math.min(r.limit ?? 6, 20)).map(async (v, i) => {
            if (!VERSION.test(v)) return null;
            const res = await fetch(`${api}/versions/${v}/linux-x64/stable`, { signal: AbortSignal.timeout(8000) });
            if (!res.ok) return null;
            const d = (await res.json()) as { url?: string; sha256hash?: string };
            if (!d.url?.startsWith("https://") || !/^[0-9a-f]{64}$/.test(d.sha256hash ?? "")) return null;
            return { version: v, url: d.url, sha256: d.sha256hash, channel: i === 0 ? "Latest" : undefined } as SoftwareVersion;
        }))).filter((v): v is SoftwareVersion => v !== null);
        releaseCache.set(key, { at: Date.now(), versions });
        return versions;
    } catch {
        return hit?.versions ?? [];
    }
}

/** Firefox's current release and ESR from Mozilla, with SHA-256 from each release's SHA256SUMS. */
async function firefoxVersions(): Promise<SoftwareVersion[]> {
    const hit = releaseCache.get("firefox");
    if (hit && Date.now() - hit.at < RELEASES_TTL_MS) return hit.versions;
    try {
        const v = (await (await fetch("https://product-details.mozilla.org/1.0/firefox_versions.json", { signal: AbortSignal.timeout(8000) })).json()) as Record<string, string>;
        const base = "https://download-installer.cdn.mozilla.net/pub/firefox/releases";
        const versions = (await Promise.all([[v.LATEST_FIREFOX_VERSION, "Latest"], [v.FIREFOX_ESR, "ESR"]].map(async ([version, channel]) => {
            if (!version || !VERSION.test(version)) return null;
            const sums = await (await fetch(`${base}/${version}/SHA256SUMS`, { signal: AbortSignal.timeout(15000) })).text();
            const m = new RegExp(`^([0-9a-f]{64})\\s+linux-x86_64/en-US/(firefox-${version.replace(/\./g, "\\.")}\\.tar\\.(xz|bz2))$`, "m").exec(sums);
            if (!m) return null;
            return { version, url: `${base}/${version}/linux-x86_64/en-US/${m[2]}`, sha256: m[1], channel } as SoftwareVersion;
        }))).filter((x): x is SoftwareVersion => x !== null);
        releaseCache.set("firefox", { at: Date.now(), versions });
        return versions;
    } catch {
        return hit?.versions ?? [];
    }
}

async function githubVersions(r: SoftwareReleases): Promise<SoftwareVersion[]> {
    const key = JSON.stringify(r);
    const hit = releaseCache.get(key);
    if (hit && Date.now() - hit.at < RELEASES_TTL_MS) return hit.versions;
    try {
        const res = await fetch(`https://api.github.com/repos/${r.github}/releases?per_page=${Math.min(r.limit ?? 15, 50)}`, {
            headers: { accept: "application/vnd.github+json", "user-agent": "kiwi-panel" },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const releases = (await res.json()) as {
            tag_name: string; draft: boolean; prerelease: boolean;
            assets: { name: string; size: number; digest?: string | null; browser_download_url: string }[];
        }[];
        const [before, after] = r.tag.split("{version}");
        const versions: SoftwareVersion[] = [];
        for (const rel of releases) {
            if (rel.draft || (rel.prerelease && !r.prerelease)) continue;
            if (!rel.tag_name.startsWith(before) || !rel.tag_name.endsWith(after ?? "")) continue;
            const version = rel.tag_name.slice(before.length, rel.tag_name.length - (after ?? "").length);
            if (!VERSION.test(version)) continue;
            const fill = (t: string) => t.replaceAll("{version}", version).replaceAll("{compact}", version.replaceAll(".", ""));
            const asset = rel.assets.find((a) => a.name === fill(r.asset));
            if (!asset) continue;
            versions.push({
                version,
                url: r.url ? fill(r.url) : asset.browser_download_url,
                sha256: asset.digest?.startsWith("sha256:") ? asset.digest.slice(7) : undefined,
                size: asset.size,
                channel: versions.length === 0 ? "Latest" : undefined,
            });
        }
        releaseCache.set(key, { at: Date.now(), versions });
        return versions;
    } catch {
        return hit?.versions ?? [];
    }
}

function run(cmd: string[]) {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

/** Relative path that stays inside its base directory. */
const safeRel = (p: string) => p !== "" && !p.startsWith("/") && !p.split("/").includes("..");

function validate(raw: unknown): Software | null {
    const s = raw as Partial<Software>;
    if (!s || typeof s !== "object" || typeof s.id !== "string" || !ID.test(s.id)) return null;
    if (typeof s.name !== "string" || !Array.isArray(s.versions)) return null;
    const versions = (s.versions as unknown[]).filter((v): v is SoftwareVersion => validVersion(v));
    const bin = typeof s.bin === "string" && safeRel(s.bin) ? s.bin : "bin";
    const links = Object.fromEntries(Object.entries(s.links && typeof s.links === "object" ? s.links : {})
        .filter(([k, v]) => FILE_NAME.test(k) && typeof v === "string" && FILE_NAME.test(v)));
    const r = s.releases;
    const releases = r?.provider === "vscode" || r?.provider === "firefox"
        ? { provider: r.provider, github: "", tag: "", asset: "", limit: Number(r.limit) || undefined }
        : r && typeof r.github === "string" && /^[\w.-]+\/[\w.-]+$/.test(r.github) &&
        typeof r.tag === "string" && r.tag.includes("{version}") && typeof r.asset === "string" &&
        (r.url === undefined || (typeof r.url === "string" && r.url.startsWith("https://")))
        ? { github: r.github, tag: r.tag, asset: r.asset, url: r.url, prerelease: !!r.prerelease, limit: Number(r.limit) || undefined }
        : undefined;
    return {
        id: s.id,
        name: s.name,
        summary: String(s.summary ?? ""),
        description: String(s.description ?? ""),
        icon: typeof s.icon === "string" && /^(https:\/\/|data:image\/)/.test(s.icon) ? s.icon : "",
        developer: s.developer, homepage: s.homepage, license: s.license, category: s.category,
        bin,
        format: s.format === "tar" || s.format === "zip" || s.format === "binary" || s.format === "deb" ? s.format : undefined,
        deb: validDeb(s.deb),
        binary: typeof s.binary === "string" && FILE_NAME.test(s.binary) ? s.binary : undefined,
        links,
        strip: Number.isInteger(s.strip) && s.strip! >= 0 && s.strip! <= 3 ? s.strip : undefined,
        needs: Array.isArray(s.needs) ? s.needs.filter((n) => typeof n === "string" && ID.test(n)) : undefined,
        section: s.section === "desktop" ? "desktop" : undefined,
        debs: s.debs && Array.isArray(s.debs.packages) && s.debs.packages.every((p) => typeof p === "string" && /^[a-z0-9][a-z0-9+.-]+$/.test(p))
            ? {
                packages: s.debs.packages,
                exclude: Array.isArray(s.debs.exclude) ? s.debs.exclude.filter((p) => typeof p === "string") : undefined,
                have: Array.isArray(s.debs.have) ? s.debs.have.filter((h) => typeof h === "string" && ID.test(h)) : undefined,
            }
            : undefined,
        launchers: validCommands(s.launchers),
        desktop: s.desktop && typeof s.desktop.name === "string" && typeof s.desktop.command === "string" && FILE_NAME.test(s.desktop.command)
            ? { name: s.desktop.name.slice(0, 60), command: s.desktop.command }
            : undefined,
        releases,
        service: validService(s.service),
        versions,
    };
}

function validService(raw: unknown): SoftwareService | undefined {
    const v = raw as Partial<SoftwareService> | undefined;
    if (!v || typeof v !== "object" || !Array.isArray(v.exec) || !v.exec.every((a) => typeof a === "string") || v.exec.length === 0) return undefined;
    const port = Number(v.defaultPort);
    return {
        description: String(v.description ?? ""),
        defaultPort: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 8080,
        exec: v.exec,
        env: v.env && typeof v.env === "object" ? Object.fromEntries(Object.entries(v.env).filter(([k, x]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof x === "string")) : undefined,
        uid: Number.isInteger(v.uid) && v.uid! >= 1000 && v.uid! < 65534 ? v.uid : undefined,
        requires: Array.isArray(v.requires) ? v.requires.filter((r) => r && typeof r.command === "string" && /^[\w.+-]+$/.test(r.command)).map((r) => ({ command: r.command, hint: String(r.hint ?? "") })) : undefined,
        note: typeof v.note === "string" ? v.note : undefined,
        secrets: Array.isArray(v.secrets) ? v.secrets.filter((x) => typeof x === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(x)) : undefined,
    };
}

function validCommands(raw: unknown): Software["launchers"] {
    if (!raw || typeof raw !== "object") return undefined;
    const out: NonNullable<Software["launchers"]> = {};
    for (const [name, c] of Object.entries(raw as Record<string, any>)) {
        if (!FILE_NAME.test(name) || !c || typeof c.exec !== "string" || !safeRel(c.exec)) continue;
        out[name] = {
            exec: c.exec,
            args: Array.isArray(c.args) ? c.args.filter((a: unknown) => typeof a === "string") : undefined,
            env: c.env && typeof c.env === "object" ? Object.fromEntries(Object.entries(c.env).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string")) as Record<string, string> : undefined,
        };
    }
    return Object.keys(out).length ? out : undefined;
}

/** Ports something is listening on (the isolation shares the host's network). */
/** TCP ports with a listening socket right now (/proc/net/tcp state 0A). */
export function portsInUse(): Set<number> {
    const used = new Set<number>();
    for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
        try {
            for (const line of readFileSync(f, "utf8").split("\n").slice(1)) {
                const c = line.trim().split(/\s+/);
                if (c[3] === "0A") used.add(parseInt(c[1].split(":")[1], 16));
            }
        } catch {}
    }
    return used;
}

function validDeb(raw: unknown): SoftwareDeb | undefined {
    const d = raw as Partial<SoftwareDeb> | undefined;
    const pkg = /^[a-z0-9][a-z0-9+.{}-]+$/;
    if (!d || !Array.isArray(d.packages) || !d.packages.every((p) => typeof p === "string" && pkg.test(p))) return undefined;
    if (typeof d.versionOf !== "string" || !pkg.test(d.versionOf) || !d.commands || typeof d.commands !== "object") return undefined;
    const commands: SoftwareDeb["commands"] = {};
    for (const [name, c] of Object.entries(d.commands)) {
        if (!FILE_NAME.test(name.replaceAll("{v}", "0")) || !c || typeof c.exec !== "string" || !safeRel(c.exec)) continue;
        commands[name] = {
            exec: c.exec,
            args: Array.isArray(c.args) ? c.args.filter((a) => typeof a === "string") : undefined,
            env: c.env && typeof c.env === "object" ? Object.fromEntries(Object.entries(c.env).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string")) : undefined,
        };
    }
    let carry: string | undefined;
    try {
        if (typeof d.carry === "string") carry = new RegExp(d.carry).source;
    } catch {}
    const exclude = Array.isArray(d.exclude) ? d.exclude.filter((p) => typeof p === "string" && pkg.test(p)) : undefined;
    const patches = Array.isArray(d.patches)
        ? d.patches.filter((x) => x && typeof x.file === "string" && safeRel(x.file) && typeof x.from === "string" && typeof x.to === "string" &&
            x.to.length <= x.from.length && x.to.startsWith("/") && x.from.startsWith("/"))
        : undefined;
    const variants = Array.isArray(d.variants) ? d.variants.filter((v) => typeof v === "string" && /^\d+(\.\d+)*$/.test(v)) : undefined;
    const sources = Array.isArray(d.sources) ? d.sources.filter((x) => typeof x === "string" && x in SOURCES) : undefined;
    const optional = Array.isArray(d.optional) ? d.optional.filter((p) => typeof p === "string" && pkg.test(p)) : undefined;
    const probe = typeof d.probe === "string" && safeRel(d.probe) ? d.probe : undefined;
    const have = Array.isArray(d.have) ? d.have.filter((h) => typeof h === "string" && ID.test(h)) : undefined;
    return { sources, variants: variants?.length ? variants : undefined, probe, packages: d.packages, optional, versionOf: d.versionOf, commands, carry, exclude, have, patches };
}

/** A deb spec with "{v}" replaced by a variant (dots escaped in the carry regex). */
function forVariant(d: SoftwareDeb, v: string | null): SoftwareDeb {
    if (v === null) return d;
    const f = (x: string) => x.replaceAll("{v}", v);
    return {
        ...d,
        packages: d.packages.map(f),
        optional: d.optional?.map(f),
        versionOf: f(d.versionOf),
        probe: d.probe && f(d.probe),
        carry: d.carry?.replaceAll("{v}", v.replaceAll(".", "\\.")),
        commands: Object.fromEntries(Object.entries(d.commands).map(([name, c]) => [f(name), {
            exec: f(c.exec),
            args: c.args?.map(f),
            env: c.env && Object.fromEntries(Object.entries(c.env).map(([k, x]) => [k, f(x)])),
        }])),
    };
}

/** Single-quote for sh, except {root} which becomes "$R". */
const shWord = (s: string) => s.split("{root}").map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(`"$R"`);

function validVersion(raw: unknown): boolean {
    const v = raw as Partial<SoftwareVersion>;
    return !!v && typeof v.version === "string" && VERSION.test(v.version) &&
        typeof v.url === "string" && /^(https:\/\/[^\s]+|deb:[a-z0-9+.-]+)$/.test(v.url) &&
        (v.sha256 === undefined || /^[0-9a-f]{64}$/i.test(v.sha256));
}

export class KiwiSoftware {
    /** Catalogue from /www/repo.json (written with the defaults the first time). */
    static catalog(): Software[] {
        if (!existsSync(REPO_FILE)) {
            if (!existsSync("/www")) return [];
            writeFileSync(REPO_FILE, JSON.stringify(DEFAULT_REPO, null, 2) + "\n", { mode: 0o644 });
        }
        let data: { version?: number; software?: { id?: string }[] };
        try {
            data = JSON.parse(readFileSync(REPO_FILE, "utf8"));
        } catch {
            throw new Error(`${REPO_FILE} is not valid JSON; fix or remove it`);
        }
        if ((data.version ?? 1) < REPO_VERSION) {
            // Add software that is new in DEFAULT_REPO once (later removals by hand stick),
            // and fields new in a default entry (e.g. "service") without overwriting edits.
            const defaults = new Map(DEFAULT_REPO.software.map((d) => [d.id, d]));
            const existing = (data.software ?? []).map((e) => {
                const d = e?.id ? defaults.get(e.id) : undefined;
                if (!d) return e;
                const managed = Object.fromEntries(MANAGED_KEYS.filter((k) => k in d).map((k) => [k, d[k]]));
                return { ...d, ...e, ...managed };
            });
            const have = new Set(existing.map((e) => e?.id));
            data = { ...data, version: REPO_VERSION, software: [...existing, ...DEFAULT_REPO.software.filter((d) => !have.has(d.id))] };
            writeFileSync(`${REPO_FILE}.tmp`, JSON.stringify(data, null, 2) + "\n", { mode: 0o644 });
            renameSync(`${REPO_FILE}.tmp`, REPO_FILE);
        }
        return (data.software ?? []).map(validate).filter((s): s is Software => s !== null);
    }

    /** Installable versions: GitHub releases (when configured) first, then the static list. */
    static async versions(s: Software): Promise<SoftwareVersion[]> {
        if (s.format === "deb" && s.deb) {
            // The archive only serves its newest build. Never block a page on the
            // index download: use it when cached, else warm it in the background.
            const sources = s.deb.sources ?? [];
            const index = cachedIndex(sources);
            if (!index) loadIndex(DEB_CACHE, sources).catch(() => {});
            if (s.deb.variants) {
                return s.deb.variants.flatMap((v) => {
                    const name = forVariant(s.deb!, v).versionOf;
                    const p = index?.packages.get(name);
                    if (index && !p) return [];
                    return [{ version: v, url: `deb:${name}`, channel: p ? debVersion(p.version).split(/[-+]/)[0] : undefined }];
                });
            }
            const p = index?.packages.get(s.deb.versionOf);
            if (p) return [{ version: debVersion(p.version), url: `deb:${p.name}`, channel: "Ubuntu" }];
            return s.versions;
        }
        const live = !s.releases ? []
            : s.releases.provider === "vscode" ? await vscodeVersions(s.releases)
            : s.releases.provider === "firefox" ? await firefoxVersions()
            : await githubVersions(s.releases);
        const seen = new Set(live.map((v) => v.version));
        return [...live, ...s.versions.filter((v) => !seen.has(v.version))];
    }

    /** Packages already unpacked by these other software (their default versions). */
    private static bundled(ids: string[] = []): Set<string> {
        const have = new Set<string>();
        for (const other of ids) {
            const cur = this.current(other);
            if (cur) for (const p of Object.keys(rootPackages(join(SOFTWARE_DIR, other, cur, "root")))) have.add(p);
        }
        return have;
    }

    /** Whether "Check & repair" applies (software with a package root it can add libraries to). */
    static repairable(s: Software): boolean {
        return s.format === "deb" || !!s.debs;
    }

    /**
     * Check an installed version for missing libraries and add what's needed:
     *  1. packages its (possibly newer) definition asks for that aren't unpacked yet;
     *  2. for every library an ELF file needs that is found nowhere (system,
     *     this install, the software it builds on), the Ubuntu package that ships it.
     * Repeats until nothing more can be added; skips REPAIR_SKIP and stops at REPAIR_MAX_BYTES.
     */
    static async repair(id: string): Promise<RepairResult> {
        const s = this.get(id);
        const cur = this.current(id);
        if (!s || !cur) throw new Error(`${id} is not installed`);
        const dir = join(SOFTWARE_DIR, id, cur);
        const root = join(dir, "root");
        const haveIds = s.deb?.have ?? s.debs?.have ?? [];
        const haveRoots = haveIds.map((h) => join(SOFTWARE_DIR, h, "current/root")).filter(existsSync);
        if (!this.repairable(s)) return { added: [], addedBytes: 0, optional: missingLibraries(dir, haveRoots) };

        const spec = s.deb ? forVariant(s.deb, s.deb.variants?.includes(cur) ? cur : null) : null;
        const exclude = spec?.exclude ?? s.debs?.exclude ?? [];
        const index = await loadIndex(DEB_CACHE, spec?.sources ?? []);
        const system = systemPackages();
        const added: string[] = [];
        let addedBytes = 0;
        const unpackMore = async (wanted: string[]) => {
            const have = new Set([...this.bundled(haveIds), ...Object.keys(rootPackages(root))]);
            let pkgs;
            try {
                pkgs = resolveDebs(index, wanted, system, have, exclude).filter((p) => !REPAIR_SKIP.test(p.name));
            } catch {
                return false; // a dependency the archive doesn't have: leave it to the report
            }
            const size = pkgs.reduce((n, p) => n + p.size, 0);
            if (!pkgs.length || addedBytes + size > REPAIR_MAX_BYTES) return false;
            await unpackDebs(pkgs, root, join(dir, ".work"));
            rmSync(join(dir, ".work"), { recursive: true, force: true });
            recordPackages(root, pkgs);
            added.push(...pkgs.map((p) => p.name));
            addedBytes += size;
            return true;
        };

        // 1. What the current definition asks for (e.g. libraries a fixed catalogue entry no longer leaves out).
        const declared = spec
            ? [...spec.packages, ...(spec.optional ?? []).filter((n) => index.packages.has(n))]
            : s.debs!.packages;
        await unpackMore(declared.filter((n) => index.packages.has(n)));

        // 2. Whatever the files themselves still can't find.
        for (let round = 0; round < 4; round++) {
            const missing = missingLibraries(dir, haveRoots);
            const wanted = [...new Set(missing.map((m) => packageCandidates(m.soname).find((p) => index.packages.has(p))).filter((p): p is string => !!p))]
                .filter((p) => !REPAIR_SKIP.test(p) && !added.includes(p));
            if (!wanted.length || !(await unpackMore(wanted))) break;
        }
        if (added.length) compileSchemas(root, haveIds);
        prune(root);
        if (id === "xorg" || s.desktop) await POST_INSTALL[id]?.(cur);
        return { added, addedBytes, optional: missingLibraries(dir, haveRoots) };
    }

    /** Names of the software `s` needs that isn't installed yet. */
    static missingNeeds(s: Software): string[] {
        return (s.needs ?? []).filter((id) => !this.current(id)).map((id) => this.get(id)?.name ?? id);
    }

    /** Desktop menu entries of installed software. */
    static desktopApps(): { name: string; command: string }[] {
        return this.catalog().filter((s) => s.desktop && this.current(s.id)).map((s) => s.desktop!);
    }

    /** Refresh the X.org desktop's menu after something with a desktop entry changed. */
    private static async refreshDesktop(id: string) {
        if (id === "xorg" || !this.get(id)?.desktop || !this.current("xorg")) return;
        await KiwiDesktop.writeMenu(this.desktopApps()).catch(() => {});
    }

    static get(id: string): Software | null {
        return this.catalog().find((s) => s.id === id) ?? null;
    }

    /** Installed versions of a software, newest catalogue order first, then unknown ones. */
    static installed(id: string): string[] {
        if (!ID.test(id)) return [];
        const dir = join(SOFTWARE_DIR, id);
        if (!existsSync(dir)) return [];
        return readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && VERSION.test(e.name))
            .map((e) => e.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    }

    /** The default version (what /www/softwares/bin points to), or null. */
    static current(id: string): string | null {
        try {
            const target = readlinkSync(join(SOFTWARE_DIR, id, "current"));
            return VERSION.test(target) && existsSync(join(SOFTWARE_DIR, id, target)) ? target : null;
        } catch {
            return null;
        }
    }

    /** Commands a software puts on PATH (from its default version). */
    static commands(id: string): string[] {
        const s = this.get(id);
        const cur = this.current(id);
        if (!s || !cur) return [];
        const dir = join(SOFTWARE_DIR, id, cur, s.bin);
        try {
            return readdirSync(dir).filter((f) => {
                try {
                    const st = statSync(join(dir, f));
                    return st.isFile() && (st.mode & 0o111) !== 0;
                } catch {
                    return false;
                }
            }).sort();
        } catch {
            return [];
        }
    }

    static job(id: string): InstallJob | null {
        return jobs.get(id) ?? null;
    }

    /**
     * Start downloading and unpacking a version in the background; with
     * `service`, set it up as a service on that port once it is installed.
     */
    static async install(id: string, version: string, service?: { port: number; firewall: boolean }): Promise<void> {
        const s = this.get(id);
        if (!s) throw new Error(`unknown software ${id}`);
        if (s.deb?.variants && !s.deb.variants.includes(version)) throw new Error(`${s.name} ${version} is not offered`);
        if (s.deb?.variants && s.deb.probe && this.hasVariant(s, version)) throw new Error(`${s.name} ${version} is already installed`);
        const v = s.format === "deb"
            ? { version, url: `deb:${s.deb?.versionOf}` }
            : (await this.versions(s)).find((x) => x.version === version);
        if (!v) throw new Error(`${s.name} ${version} is not in the catalogue`);
        const running = jobs.get(id);
        if (running && running.phase !== "done" && running.phase !== "error" && running.phase !== "installed") throw new Error(`${s.name} ${running.version} is already being installed`);
        if (this.installed(id).includes(version) && s.format !== "deb") throw new Error(`${s.name} ${version} is already installed`);
        if (!this.storageMounted()) throw new Error("user storage is not mounted at /www");
        const missingNeeds = this.missingNeeds(s);
        if (missingNeeds.length) throw new Error(`Install ${missingNeeds.join(", ")} first`);
        if (service) this.checkService(s, service.port);

        const job: InstallJob = { id, version, phase: "downloading", received: 0, total: v.size ?? null, error: null, startedAt: Date.now() };
        jobs.set(id, job);
        this.runInstall(s, v, job)
            .then(async () => {
                if (!service) {
                    job.phase = "done";
                    return;
                }
                job.phase = "service";
                await this.createService(id, service.port, { start: true, firewall: service.firewall });
                job.phase = "done";
            })
            .catch((e) => {
                job.phase = "error";
                job.error = (e as Error).message;
            });
    }

    /** Whether any installed version directory has variant `v` (by the spec's probe file). */
    private static hasVariant(s: Software, v: string): boolean {
        const probe = forVariant(s.deb!, v).probe;
        return !!probe && this.installed(s.id).some((dir) => existsSync(join(SOFTWARE_DIR, s.id, dir, probe)));
    }

    private static async runInstall(s: Software, v: SoftwareVersion, job: InstallJob) {
        if (s.format === "deb") return this.runDebInstall(s, job, s.deb?.variants ? v.version : null);
        mkdirSync(DOWNLOADS, { recursive: true, mode: 0o755 });
        const format = formatOf(s, v.url);
        const ext = format === "tar" ? v.url.match(TAR)![1] : format === "zip" ? "zip" : "bin";
        const archive = join(DOWNLOADS, `${s.id}-${v.version}.${ext}`);
        const staging = join(SOFTWARE_DIR, s.id, `.installing-${v.version}`);
        const unpack = `${staging}.unpack`;
        const dest = join(SOFTWARE_DIR, s.id, v.version);
        try {
            // Download, hashing as we go.
            const res = await fetch(v.url, { redirect: "follow" });
            if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
            job.total = Number(res.headers.get("content-length")) || job.total;
            const free = (() => {
                const st = statfsSync("/www");
                return st.bavail * st.bsize;
            })();
            if (job.total && job.total * 4 > free) throw new Error("not enough free space on your storage");
            const hash = new Bun.CryptoHasher("sha256");
            const out = createWriteStream(archive, { mode: 0o600 });
            const reader = res.body.getReader();
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    hash.update(value);
                    job.received += value.length;
                    if (!out.write(value)) await new Promise((r) => out.once("drain", r));
                }
            } finally {
                await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
            }

            job.phase = "verifying";
            if (v.sha256 && hash.digest("hex") !== v.sha256.toLowerCase()) throw new Error("checksum mismatch: the download is corrupt or was tampered with");

            job.phase = "unpacking";
            rmSync(staging, { recursive: true, force: true });
            rmSync(unpack, { recursive: true, force: true });
            if (format === "tar") {
                mkdirSync(staging, { recursive: true, mode: 0o755 });
                // The system image has no zstd program for tar to call; Bun decompresses instead.
                let tarball = archive;
                if (archive.endsWith(".tar.zst")) {
                    tarball = archive.slice(0, -4);
                    writeFileSync(tarball, Bun.zstdDecompressSync(readFileSync(archive)), { mode: 0o600 });
                }
                const tar = run(["tar", "-xaf", tarball, "-C", staging, `--strip-components=${s.strip ?? 1}`, "--no-same-owner", "--no-same-permissions"]);
                if (tarball !== archive) rmSync(tarball, { force: true });
                if (tar.code !== 0) throw new Error(`unpacking failed: ${tar.err || `tar exited ${tar.code}`}`);
            } else if (format === "zip") {
                mkdirSync(unpack, { recursive: true, mode: 0o755 });
                const unzip = run(["unzip", "-q", "-o", archive, "-d", unpack]);
                if (unzip.code !== 0) throw new Error(`unpacking failed: ${unzip.err || `unzip exited ${unzip.code}`}`);
                // Strip a single top directory, like tar --strip-components=1.
                const top = readdirSync(unpack, { withFileTypes: true });
                if (top.length === 1 && top[0].isDirectory()) {
                    renameSync(join(unpack, top[0].name), staging);
                    rmSync(unpack, { recursive: true, force: true });
                } else renameSync(unpack, staging);
            } else {
                const binDir = join(staging, s.bin);
                mkdirSync(binDir, { recursive: true, mode: 0o755 });
                const file = join(binDir, s.binary ?? s.id);
                renameSync(archive, file);
                chmodSync(file, 0o755);
            }
            const binDir = join(staging, s.bin);
            if (s.launchers) mkdirSync(binDir, { recursive: true, mode: 0o755 }); // filled below
            if (!existsSync(binDir)) throw new Error(`the download has no ${s.bin}/ directory`);
            for (const [name, target] of Object.entries(s.links ?? {})) {
                if (!existsSync(join(binDir, name)) && existsSync(join(binDir, target))) symlinkSync(target, join(binDir, name));
            }
            if (s.debs) {
                job.phase = "resolving";
                const index = await loadIndex(DEB_CACHE);
                const pkgs = resolveDebs(index, s.debs.packages, systemPackages(), this.bundled(s.debs.have), s.debs.exclude);
                job.phase = "unpacking";
                await unpackDebs(pkgs, join(staging, "root"), join(staging, ".work"));
                rmSync(join(staging, ".work"), { recursive: true, force: true });
                recordPackages(join(staging, "root"), pkgs);
            }
            for (const [name, c] of Object.entries(s.launchers ?? {})) {
                if (!existsSync(join(staging, c.exec))) throw new Error(`${c.exec} is missing from the download`);
                const word = (x: string) => x.split("{dir}").map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(`"$V"`);
                writeFileSync(join(binDir, name), [
                    "#!/bin/sh",
                    `# Written by kiwi: ${s.name} ${v.version}.`,
                    `V=${word(dest)}`,
                    `export LD_LIBRARY_PATH="$V/root/usr/lib/x86_64-linux-gnu:$V/root/lib/x86_64-linux-gnu\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"`,
                    ...Object.entries(c.env ?? {}).map(([k, x]) => `export ${k}=${word(x)}`),
                    `exec "$V"/${word(c.exec)} ${(c.args ?? []).map(word).join(" ")} "$@"`,
                    "",
                ].join("\n"), { mode: 0o755 });
            }
            renameSync(staging, dest);
            if (!this.current(s.id)) await this.setDefault(s.id, v.version);
            else this.linkCommands(s.id);
            job.phase = "installed";
        } catch (e) {
            rmSync(staging, { recursive: true, force: true });
            rmSync(unpack, { recursive: true, force: true });
            throw e;
        } finally {
            rmSync(archive, { force: true });
        }
    }

    /**
     * Ubuntu packages: resolve against the system image, download, verify and
     * unpack into <version>/root, then write wrapper commands into <version>/bin.
     * The version is whatever the archive has now.
     */
    private static async runDebInstall(s: Software, job: InstallJob, variant: string | null) {
        const spec = forVariant(s.deb!, variant);
        job.phase = "resolving";
        const index = await loadIndex(DEB_CACHE, spec.sources ?? []);
        const main = index.packages.get(spec.versionOf);
        if (!main) throw new Error(`${spec.versionOf} is not in the package archive`);
        const version = variant ?? debVersion(main.version);
        job.version = version;
        if (this.installed(s.id).includes(version)) throw new Error(`${s.name} ${version} is already installed${variant ? "" : " (the newest the archive has)"}`);
        const cur = this.current(s.id);
        // Upgrading a single-version software keeps what was added to it (e.g. extensions).
        const carried = spec.carry && cur && !variant
            ? Object.keys(rootPackages(join(SOFTWARE_DIR, s.id, cur, "root"))).filter((n) => new RegExp(spec.carry!).test(n) && index.packages.has(n))
            : [];
        const optional = (spec.optional ?? []).filter((n) => index.packages.has(n));
        const pkgs = resolveDebs(index, [...new Set([...spec.packages, ...optional, ...carried])], systemPackages(), this.bundled(spec.have), spec.exclude);
        const staging = join(SOFTWARE_DIR, s.id, `.installing-${version}`);
        const dest = join(SOFTWARE_DIR, s.id, version);
        job.phase = "downloading";
        job.received = 0;
        job.total = pkgs.reduce((n, p) => n + p.size, 0);
        const st = statfsSync("/www");
        if (job.total * 6 > st.bavail * st.bsize) throw new Error("not enough free space on your storage");
        try {
            rmSync(staging, { recursive: true, force: true });
            const root = join(staging, "root");
            await unpackDebs(pkgs, root, join(staging, ".work"), (done) => {
                job.received = done;
            });
            rmSync(join(staging, ".work"), { recursive: true, force: true });
            recordPackages(root, pkgs);
            job.phase = "unpacking";
            for (const p of spec.patches ?? []) patchPath(join(root, p.file), p.from, p.to);
            compileSchemas(root, spec.have);
            const bin = join(staging, s.bin);
            mkdirSync(bin, { recursive: true, mode: 0o755 });
            for (const [name, c] of Object.entries(spec.commands)) {
                if (!existsSync(join(root, c.exec))) throw new Error(`${c.exec} is missing from the packages`);
                // Paths point at the final directory (staging is renamed below).
                const script = [
                    "#!/bin/sh",
                    `# Written by kiwi: ${s.name} ${version} from Ubuntu packages on user.img.`,
                    `R=${shWord(join(dest, "root"))}`,
                    `export LD_LIBRARY_PATH="$R/usr/lib/x86_64-linux-gnu:$R/lib/x86_64-linux-gnu:$R/usr/lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"`,
                    // Icons, .desktop files and GSettings schemas of the packages (harmless for command-line tools).
                    `export XDG_DATA_DIRS="$R/usr/share\${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"`,
                    ...(existsSync(join(root, "usr/share/glib-2.0/schemas/gschemas.compiled")) ? [`export GSETTINGS_SCHEMA_DIR="$R/usr/share/glib-2.0/schemas"`] : []),
                    ...Object.entries(c.env ?? {}).map(([k, v]) => `export ${k}=${shWord(v)}`),
                    `exec "$R"/${shWord(c.exec)} ${(c.args ?? []).map(shWord).join(" ")} "$@"`,
                    "",
                ].join("\n");
                writeFileSync(join(bin, name), script, { mode: 0o755 });
            }
            renameSync(staging, dest);
        } catch (e) {
            rmSync(staging, { recursive: true, force: true });
            throw e;
        }
        // A first install, or an upgrade, becomes the default; another variant is added next to it.
        if (variant && cur) {
            this.linkCommands(s.id);
            await POST_INSTALL[s.id]?.(version);
        } else await this.setDefault(s.id, version);
        job.phase = "installed";
    }

    /** Make `version` the one on PATH. */
    static async setDefault(id: string, version: string): Promise<void> {
        if (!this.installed(id).includes(version)) throw new Error(`${id} ${version} is not installed`);
        const link = join(SOFTWARE_DIR, id, "current");
        const tmp = `${link}.tmp`;
        rmSync(tmp, { force: true });
        symlinkSync(version, tmp);
        renameSync(tmp, link);
        this.linkCommands(id);
        await POST_INSTALL[id]?.(version);
        await this.refreshDesktop(id);
    }

    /** Remove one installed version; another installed version becomes the default. */
    static async remove(id: string, version: string): Promise<void> {
        if (!this.installed(id).includes(version)) throw new Error(`${id} ${version} is not installed`);
        if (this.installed(id).length === 1 && existsSync(this.serviceFile(id))) throw new Error("remove its service first");
        // Removing the last version of something other installed software needs.
        if (this.installed(id).length === 1) {
            const dependents = this.catalog().filter((o) => o.needs?.includes(id) && this.current(o.id)).map((o) => o.name);
            if (dependents.length) throw new Error(`remove ${dependents.join(", ")} first`);
        }
        const wasDefault = this.current(id) === version;
        await PRE_REMOVE[id]?.(version);
        rmSync(join(SOFTWARE_DIR, id, version), { recursive: true, force: true });
        if (!wasDefault) return;
        const next = this.installed(id)[0];
        if (next) await this.setDefault(id, next);
        else {
            rmSync(join(SOFTWARE_DIR, id, "current"), { force: true });
            this.linkCommands(id);
            rmSync(join(SOFTWARE_DIR, id), { recursive: true, force: true });
            await this.refreshDesktop(id);
        }
    }

    /**
     * Point /www/softwares/bin/<cmd> at the default version's commands. Links
     * go through `current`, so switching versions is one rename; this only
     * adds and drops names. Never replaces another software's command.
     */
    static linkCommands(id: string): void {
        mkdirSync(SOFTWARE_BIN, { recursive: true, mode: 0o755 });
        const s = this.get(id);
        for (const name of readdirSync(SOFTWARE_BIN)) {
            const p = join(SOFTWARE_BIN, name);
            try {
                if (lstatSync(p).isSymbolicLink() && readlinkSync(p).startsWith(`../${id}/`)) rmSync(p);
            } catch {}
        }
        const cur = this.current(id);
        if (!s || !cur) return;
        const sub = s.bin === "." ? "" : `${s.bin}/`;
        const taken = (p: string) => existsSync(p) || (() => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } })();
        // The default version's commands go through "current"; commands only
        // another installed version has (php8.2 next to a default 8.4) link to it.
        for (const cmd of this.commands(id)) {
            const p = join(SOFTWARE_BIN, cmd);
            if (!taken(p)) symlinkSync(`../${id}/current/${sub}${cmd}`, p);
        }
        for (const dir of this.installed(id).filter((d) => d !== cur)) {
            const binDir = join(SOFTWARE_DIR, id, dir, s.bin);
            for (const cmd of existsSync(binDir) ? readdirSync(binDir) : []) {
                const p = join(SOFTWARE_BIN, cmd);
                if (!taken(p) && FILE_NAME.test(cmd)) symlinkSync(`../${id}/${dir}/${sub}${cmd}`, p);
            }
        }
    }

    // ---- Running an app as a service ----

    private static serviceFile(id: string) {
        return join(SERVICES_DIR, `${id}.json`);
    }

    /** Problems that stop `s` from running as a service on `port` (throws the first). */
    static checkService(s: Software, port: number) {
        if (!s.service) throw new Error(`${s.name} can't run as a service`);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be between 1024 and 65535");
        if (portsInUse().has(port)) throw new Error(`Port ${port} is already in use`);
        for (const r of s.service.requires ?? []) {
            if (!hasCommand(r.command)) throw new Error(r.hint || `${r.command} is required`);
        }
        if (existsSync(this.serviceFile(s.id))) throw new Error(`${s.name} already has a service`);
    }

    /** Write /www/services/<id>.json, load it into the agent and (optionally) start it. */
    static async createService(id: string, port: number, opts: { start: boolean; firewall: boolean }): Promise<void> {
        const s = this.get(id);
        if (!s?.service) throw new Error(`${id} can't run as a service`);
        if (!this.current(id)) throw new Error(`${s.name} is not installed`);
        this.checkService(s, port);
        const svc = s.service;
        const secrets = Object.fromEntries((svc.secrets ?? []).map((n) => [n, randomBytes(18).toString("base64url")]));
        mkdirSync(join(APPS_DIR, id), { recursive: true, mode: 0o750 });
        this.fixAppDirs(id);
        mkdirSync(SERVICES_DIR, { recursive: true, mode: 0o755 });
        this.writeUnit(s, port, secrets, opts.start);
        await agent("/daemon-reload", {}); // starts it when enabled
        if (opts.firewall) {
            const fw = await KiwiFirewall.info().catch(() => null);
            if (fw?.enabled && !KiwiFirewall.allows(fw, "tcp", port)) {
                await KiwiFirewall.update(true, [...fw.rules, { port, proto: "tcp", comment: s.name }]);
            }
        }
    }

    /** The isol unit for an app service, from its catalogue entry. */
    private static writeUnit(s: Software, port: number, secrets: Record<string, string>, enabled: boolean): boolean {
        const svc = s.service!;
        const id = s.id;
        const data = join(APPS_DIR, id);
        const fill = (t: string) => t
            .replaceAll("{bin}", join(SOFTWARE_DIR, id, "current", s.bin))
            .replaceAll("{data}", data)
            .replaceAll("{port}", String(port))
            .replace(/\{secret:([a-z0-9_]+)\}/g, (_, n: string) => secrets[n] ?? "");
        const unit = {
            description: svc.description || s.name,
            exec: svc.exec.map(fill),
            cwd: data,
            env: { PATH: SOFTWARE_PATH, ...Object.fromEntries(Object.entries(svc.env ?? {}).map(([k, v]) => [k, fill(v)])) },
            ...(svc.uid ? { user: String(svc.uid), group: String(svc.uid) } : {}),
            enabled,
            restart: "on-failure",
            restartSec: 3,
            restartLimit: 5,
            stopSignal: "SIGTERM",
            stopTimeout: 20,
            // Not read by the agent: lets kiwi show the port (and secrets) and link it back.
            kiwi: { software: id, port, ...(svc.secrets?.length ? { secrets } : {}) },
        };
        const text = JSON.stringify(unit, null, 2) + "\n";
        const file = this.serviceFile(id);
        if (existsSync(file) && readFileSync(file, "utf8") === text) return false;
        // Root only when it holds a secret (other units stay readable, like /etc/isol).
        writeFileSync(file, text, { mode: svc.secrets?.length ? 0o600 : 0o644 });
        return true;
    }

    /**
     * Rewrite an existing service's unit from the current catalogue entry
     * (keeping its port, secrets and start-at-boot setting), so fixes to a
     * definition reach services created before them. Called before (re)starts.
     */
    static async refreshService(id: string): Promise<void> {
        const s = this.get(id);
        if (!s?.service || !existsSync(this.serviceFile(id))) return;
        let old: { enabled?: boolean; kiwi?: { port?: number; secrets?: Record<string, string> } };
        try {
            old = JSON.parse(readFileSync(this.serviceFile(id), "utf8"));
        } catch {
            return;
        }
        const port = Number(old.kiwi?.port);
        if (!port) return;
        this.fixAppDirs(id);
        if (this.writeUnit(s, port, old.kiwi?.secrets ?? {}, old.enabled !== false)) await agent("/daemon-reload", {});
    }

    /**
     * Permissions an app service needs to reach its data: /www/apps passable by
     * everyone (each app's own folder stays private to it), the app's folder
     * owned by its user. Older kiwi created /www/apps as root-only 0750, so a
     * service running as its own user (Gitea) got "permission denied".
     */
    static fixAppDirs(id: string) {
        const s = this.get(id);
        if (!existsSync(APPS_DIR)) return;
        chmodSync(APPS_DIR, 0o755);
        const data = join(APPS_DIR, id);
        const uid = s?.service?.uid;
        if (!uid || !existsSync(data)) return;
        const st = statSync(data);
        if (st.uid !== uid || (st.mode & 0o700) !== 0o700) {
            const chown = run(["chown", "-R", `${uid}:${uid}`, data]);
            if (chown.code !== 0) throw new Error(`chown ${data} failed: ${chown.err}`);
            chmodSync(data, 0o750);
        }
    }

    /** Port of the code-server service while it runs, for "Open in Code Server" buttons; null otherwise. */
    static async codeServerPort(): Promise<number | null> {
        if (!this.current("code-server")) return null;
        const st = await this.serviceStatus("code-server").catch(() => null);
        return st?.state === "running" && st.port ? st.port : null;
    }

    /** Secrets generated for a service (e.g. { password }). */
    static serviceSecrets(id: string): Record<string, string> {
        try {
            return JSON.parse(readFileSync(this.serviceFile(id), "utf8")).kiwi?.secrets ?? {};
        } catch {
            return {};
        }
    }

    static async serviceStatus(id: string): Promise<ServiceStatus | null> {
        let port = 0;
        try {
            port = Number(JSON.parse(readFileSync(this.serviceFile(id), "utf8")).kiwi?.port) || 0;
        } catch {
            return null;
        }
        const u = await agent<{ state: string; enabled: boolean; pid: number | null; error: string | null }>(`/units/${id}`).catch(() => null);
        return { port, state: u?.state ?? "unknown", enabled: u?.enabled ?? false, pid: u?.pid ?? null, error: u?.error ?? null };
    }

    /** Stop and delete the service; its data in /www/apps/<id> stays. */
    static async removeService(id: string): Promise<void> {
        if (!ID.test(id) || !existsSync(this.serviceFile(id))) throw new Error("no such service");
        await agent(`/units/${id}/stop`, {}).catch(() => {});
        rmSync(this.serviceFile(id));
        await agent("/daemon-reload", {});
    }

    private static storageMounted(): boolean {
        return readFileSync("/proc/self/mountinfo", "utf8").split("\n").some((line) => line.split(" ")[4] === "/www");
    }
}
