import { config, assertConfig } from "./config.js";

export type LatestRatesResponse = {
	success: boolean;
	base?: string;
	timestamp?: number;
	rates?: Record<string, number>;
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
}


