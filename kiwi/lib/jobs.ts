import { randomBytes } from "node:crypto";

// Long tasks (certificates, backups, restores) run in the background of the
// panel's server process, so a request never waits on them. Pages poll
// /api/jobs/<id> for the live log.

export interface Job {
    id: string;
    /** One running job per key, e.g. "ssl:example.com". */
    key: string;
    title: string;
    lines: string[];
    done: boolean;
    ok: boolean;
    startedAt: number;
    finishedAt: number | null;
}

const KEEP_MS = 60 * 60_000;
const MAX_LINES = 2000;

// On globalThis: route handlers and server actions can get separate module instances.
const g = globalThis as unknown as { __kiwiJobs?: Map<string, Job> };
const jobs = (g.__kiwiJobs ??= new Map());

export class KiwiJobs {
    /** Start `run` in the background, or return the job already running under `key`. */
    static start(key: string, title: string, run: (out: (line: string) => void) => Promise<void>): Job {
        const running = this.running(key);
        if (running) return running;
        this.prune();
        const job: Job = { id: randomBytes(8).toString("hex"), key, title, lines: [], done: false, ok: false, startedAt: Date.now(), finishedAt: null };
        jobs.set(job.id, job);
        const out = (line: string) => {
            job.lines.push(line);
            if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
        };
        run(out).then(
            () => (job.ok = true),
            (e) => out(`Error: ${(e as Error).message}`),
        ).finally(() => {
            job.done = true;
            job.finishedAt = Date.now();
        });
        return job;
    }

    static get(id: string): Job | null {
        return jobs.get(id) ?? null;
    }

    static running(key: string): Job | null {
        for (const j of jobs.values()) if (j.key === key && !j.done) return j;
        return null;
    }

    /** Running jobs whose key starts with `prefix`, newest first. */
    static list(prefix: string): Job[] {
        return [...jobs.values()].filter((j) => j.key.startsWith(prefix)).sort((a, b) => b.startedAt - a.startedAt);
    }

    private static prune() {
        for (const [id, j] of jobs) if (j.done && Date.now() - (j.finishedAt ?? 0) > KEEP_MS) jobs.delete(id);
    }
}
