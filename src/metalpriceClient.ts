import { config, assertConfig } from "./config.js";

export type LatestRatesResponse = {
	success: boolean;
	base?: string;
	timestamp?: number;
	rates?: Record<string, number>;
	error?: { code: number; info: string };
};

export type TimeframeResponse = {
	success: boolean;
	base?: string;
	start_date?: string;
	end_date?: string;
	rates?: Record<string, Record<string, number>>; // date -> { SYMBOL: rate }
	error?: { code: number; info: string };
};

export type ChangeResponse = {
	success: boolean;
	base?: string;
	start_date?: string;
	end_date?: string;
	rates?: Record<string, {
		start_rate: number;
		end_rate: number;
		change: number;
		change_pct: number;
	}>;
	error?: { code: number; info: string };
};

export class MetalpriceClient {
	private readonly baseUrl: string;
	private readonly apiKey: string;

	constructor() {
		assertConfig();
		this.baseUrl = config.metalpriceApiBase.replace(/\/$/, "");
		this.apiKey = config.metalpriceApiKey;
	}

	async fetchLatest(params: {
		base?: string;
		currencies?: string[];
		math?: string;
	} = {}): Promise<LatestRatesResponse> {
		const url = new URL(`${this.baseUrl}/latest`);
		url.searchParams.set("api_key", this.apiKey);
		if (params.base) url.searchParams.set("base", params.base);
		if (params.currencies && params.currencies.length > 0) {
			url.searchParams.set("currencies", params.currencies.join(","));
		}
		if (params.math) url.searchParams.set("math", params.math);

		const res = await fetch(url.toString(), {
			headers: {
				"Content-Type": "application/json",
				"X-API-KEY": this.apiKey,
			},
		});
		const data = (await res.json()) as LatestRatesResponse;
		return data;
	}

	async fetchTimeframe(params: {
		start_date: string; // YYYY-MM-DD
		end_date: string; // YYYY-MM-DD
		base?: string;
		currencies?: string[];
	}): Promise<TimeframeResponse> {
		const url = new URL(`${this.baseUrl}/timeframe`);
		url.searchParams.set("api_key", this.apiKey);
		url.searchParams.set("start_date", params.start_date);
		url.searchParams.set("end_date", params.end_date);
		if (params.base) url.searchParams.set("base", params.base);
		if (params.currencies && params.currencies.length > 0) {
			url.searchParams.set("currencies", params.currencies.join(","));
		}
		const res = await fetch(url.toString(), {
			headers: {
				"Content-Type": "application/json",
				"X-API-KEY": this.apiKey,
			},
		});
		const data = (await res.json()) as TimeframeResponse;
		return data;
	}
}

export async function fetchChange(params: {
	start_date?: string;
	end_date?: string;
	date_type?: "recent" | "yesterday" | "week" | "month" | "year";
	base?: string;
	currencies?: string[];
}): Promise<ChangeResponse> {
	const { metalpriceApiBase, metalpriceApiKey } = config;
	const url = new URL(`${metalpriceApiBase.replace(/\/$/, "")}/change`);
	url.searchParams.set("api_key", metalpriceApiKey);
	if (params.start_date) url.searchParams.set("start_date", params.start_date);
	if (params.end_date) url.searchParams.set("end_date", params.end_date);
	if (params.date_type) url.searchParams.set("date_type", params.date_type);
	if (params.base) url.searchParams.set("base", params.base);
	if (params.currencies && params.currencies.length) url.searchParams.set("currencies", params.currencies.join(","));
	const res = await fetch(url.toString(), { headers: { "Content-Type": "application/json", "X-API-KEY": metalpriceApiKey } });
	return res.json() as Promise<ChangeResponse>;
}


