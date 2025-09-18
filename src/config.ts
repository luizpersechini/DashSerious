import fs from "node:fs";
import path from "node:path";

// Lightweight .env loader to avoid extra deps
function loadEnv() {
	const envPath = path.resolve(process.cwd(), ".env");
	if (!fs.existsSync(envPath)) return;
	const content = fs.readFileSync(envPath, "utf8");
	for (const line of content.split(/\r?\n/)) {
		if (!line || line.trim().startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		const value = line.slice(eq + 1).trim();
		if (!(key in process.env)) process.env[key] = value;
	}
}

loadEnv();

export const config = {
	metalpriceApiKey: process.env.METALPRICE_API_KEY || "",
	metalpriceApiBase: process.env.METALPRICE_API_BASE || "https://api.metalpriceapi.com/v1",
};

export function assertConfig() {
	if (!config.metalpriceApiKey) {
		throw new Error(
			"Missing METALPRICE_API_KEY in .env. Add it to .env (never commit secrets)."
		);
	}
}


