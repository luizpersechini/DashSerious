import fs from "node:fs/promises";
import path from "node:path";

export type SeriesPoint = { t: number; v: number };

// DATA_DIR is configurable so production can point it at a mounted GCS bucket
// (Cloud Run gcsfuse volume) for persistence across container restarts.
// Defaults to ./data for local dev. See .github/workflows/deploy-cloud-run.yml
// for the volume mount and the bucket-provisioning notes in qa/KNOWN-BUGS.md.
const DATA_DIR = path.resolve(process.cwd(), process.env.DATA_DIR || "data");
const TIMESERIES_PATH = path.join(DATA_DIR, "timeseries.json");

type PersistShape = {
  version: 1;
  savedAt: number;
  symbols: Record<string, SeriesPoint[]>;
};

/**
 * Write `contents` to `target` durably. On a local POSIX filesystem the
 * tmp+rename is atomic. gcsfuse implements rename as copy+delete (works but
 * not atomic) — and some gcsfuse configs reject cross-name renames entirely,
 * so on rename failure we fall back to a direct write. With a single writer
 * (min-instances 1) writing every ~5 min and reads only on boot, this is safe.
 */
async function atomicWrite(target: string, contents: string): Promise<void> {
  const tmp = target + ".tmp";
  await fs.writeFile(tmp, contents, "utf8");
  try {
    await fs.rename(tmp, target);
  } catch {
    await fs.writeFile(target, contents, "utf8");
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

export async function hydrateTimeseries(
  target: Map<string, SeriesPoint[]>,
): Promise<{ loaded: boolean; symbols: number }> {
  try {
    const raw = await fs.readFile(TIMESERIES_PATH, "utf8");
    const parsed = JSON.parse(raw) as PersistShape;
    if (parsed?.version !== 1 || !parsed.symbols)
      return { loaded: false, symbols: 0 };
    let count = 0;
    for (const [sym, pts] of Object.entries(parsed.symbols)) {
      if (Array.isArray(pts)) {
        target.set(sym, pts);
        count++;
      }
    }
    return { loaded: true, symbols: count };
  } catch (err: any) {
    if (err?.code === "ENOENT") return { loaded: false, symbols: 0 };
    console.warn("[storage] hydrate failed:", err?.message || err);
    return { loaded: false, symbols: 0 };
  }
}

export async function persistTimeseries(
  source: Map<string, SeriesPoint[]>,
): Promise<void> {
  const shape: PersistShape = {
    version: 1,
    savedAt: Date.now(),
    symbols: Object.fromEntries(source.entries()),
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await atomicWrite(TIMESERIES_PATH, JSON.stringify(shape));
}

/**
 * Generic JSON blob persistence in the same DATA_DIR. Used for calibration
 * samples and any other small state that should survive restarts. Returns
 * null on missing/corrupt file so callers degrade gracefully.
 */
export async function persistJson(name: string, data: unknown): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await atomicWrite(path.join(DATA_DIR, name), JSON.stringify(data));
}

export async function hydrateJson<T>(name: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, name), "utf8");
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    console.warn(`[storage] hydrateJson(${name}) failed:`, err?.message || err);
    return null;
  }
}

export function registerGracefulPersist(flush: () => Promise<void>) {
  let flushing = false;
  const handler = async (_signal: NodeJS.Signals) => {
    if (flushing) return;
    flushing = true;
    // Bound the flush so a slow GCS write can't exceed Cloud Run's ~10s
    // SIGTERM grace and get hard-killed mid-write (audit #8).
    const FLUSH_TIMEOUT_MS = 8000;
    try {
      await Promise.race([
        flush(),
        new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
      ]);
    } catch {
      /* best effort */
    }
    process.exit(0);
  };
  process.once("SIGTERM", handler);
  process.once("SIGINT", handler);
}
