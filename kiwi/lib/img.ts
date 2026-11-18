import { existsSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { host } from "./host";
import { KiwiMysql } from "./mysql";

// kiwi runs inside the kiwin isolation: the host's /www/kiwin/images is visible
// (read-only) at /mount/www/kiwin/images, and privileged work such as creating
// and mounting user.img is done by the host daemon behind KIWIN_HOST_SOCKET.
const IMAGES_DIR = process.env.KIWI_IMAGES_DIR ?? "/mount/www/kiwin/images";

const SIZES = ["25GB", "35GB", "60GB", "120GB"];
const GB = 1024 ** 3;

export interface UserImgInfo {
    exists: boolean;
    mounted: boolean;
    sizeBytes: number | null;
    freeBytes: number;
}

export class KiwiImg {
    static readonly path = join(IMAGES_DIR, "user.img");

    /** Last error from create(), for showing in the UI. */
    static lastError: string | null = null;

    /** Whether user.img exists (packed user.img.zst counts: kiwin unpacks it on start). */
    static exists(): boolean {
        return existsSync(this.path) || existsSync(this.path + ".zst");
    }

    /**
     * Preset sizes for user.img. The image is sparse, so it only uses the space
     * its data needs, but sizes larger than the free disk space are left out so
     * the disk isn't overcommitted by accident; a custom size or Force does that.
     */
    static availableSizes(): string[] {
        const free = this.freeBytes();
        return SIZES.filter((size) => parseInt(size) * GB <= free);
    }

    /** Whole GB of free disk space. */
    static freeGB(): number {
        return Math.floor(this.freeBytes() / GB);
    }

    /** A custom size that leaves the disk some room (about 90% of what is free). */
    static suggestedGB(): number {
        return Math.max(1, Math.floor(this.freeGB() * 0.9));
    }

    /**
     * Ask the kiwin daemon to create a sparse user.img of `size` ("20GB") and
     * mount it; it shows up at /www right away. `force` allows more than the
     * free disk space. Then MySQL is set up on it (new data dir + root
     * password): its outcome is in KiwiMysql.lastError, since the image itself
     * exists either way.
     */
    static async create(size: string, force = false): Promise<boolean> {
        this.lastError = null;
        if (this.exists()) {
            this.lastError = "user.img already exists";
            return false;
        }
        if (!/^[1-9]\d{0,4}GB$/.test(size)) {
            this.lastError = "Enter a size in whole GB";
            return false;
        }
        if (!force && parseInt(size) * GB > this.freeBytes()) {
            this.lastError = `${size} is more than the ${this.freeGB()} GB free; choose less, or use Force setup`;
            return false;
        }
        try {
            await host("/images/user", { size, force });
        } catch (e) {
            this.lastError = (e as Error).message;
            return false;
        }
        if (KiwiMysql.isInstalled() && !(await KiwiMysql.ensure())) {
            console.error(`[KiwiImg] user.img created, but MySQL setup failed: ${KiwiMysql.lastError}`);
        }
        return true;
    }

    /** Live state from the daemon (exists, mounted, size, free space). */
    static async info(): Promise<UserImgInfo | null> {
        try {
            return await host<UserImgInfo>("/images/user");
        } catch {
            return null;
        }
    }

    private static freeBytes(): number {
        const dir = existsSync(IMAGES_DIR) ? IMAGES_DIR : dirname(IMAGES_DIR);
        const s = statfsSync(dir);
        return s.bavail * s.bsize;
    }
}
