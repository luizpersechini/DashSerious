import fs from "node:fs/promises";
import path from "node:path";

export type SeriesPoint = { t: number; v: number };

const DATA_DIR = path.resolve(process.cwd(), "data");
const TIMESERIES_PATH = path.join(DATA_DIR, "timeseries.json");

type PersistShape = {
	version: 1;
	savedAt: number;
	symbols: Record<string, SeriesPoint[]>;
};

export async function hydrateTimeseries(
	target: Map<string, SeriesPoint[]>
): Promise<{ loaded: boolean; symbols: number }> {
	try {
		const raw = await fs.readFile(TIMESERIES_PATH, "utf8");
		const parsed = JSON.parse(raw) as PersistShape;
		if (parsed?.version !== 1 || !parsed.symbols) return { loaded: false, symbols: 0 };
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
	source: Map<string, SeriesPoint[]>
): Promise<void> {
	const shape: PersistShape = {
		version: 1,
		savedAt: Date.now(),
		symbols: Object.fromEntries(source.entries()),
	};
	await fs.mkdir(DATA_DIR, { recursive: true });
	const tmp = TIMESERIES_PATH + ".tmp";
	await fs.writeFile(tmp, JSON.stringify(shape), "utf8");
	await fs.rename(tmp, TIMESERIES_PATH);
}

export function registerGracefulPersist(flush: () => Promise<void>) {
	let flushing = false;
	const handler = async (signal: NodeJS.Signals) => {
		if (flushing) return;
		flushing = true;
		try { await flush(); } catch {/* best effort */}
		process.exit(signal === "SIGTERM" ? 0 : 0);
	};
	process.once("SIGTERM", handler);
	process.once("SIGINT", handler);
}
