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
  rates?: Record<
    string,
    {
      start_rate: number;
      end_rate: number;
      change: number;
      change_pct: number;
    }
  >;
  error?: { code: number; info: string };
};

// Promise.race manual-timer backstop. AbortSignal.timeout in undici (Node fetch)
// occasionally misses the response stream phase, so a hung fetch never aborts
// and the caller hangs forever. This wrapper guarantees an eventual rejection
// regardless of fetch-layer behavior. Observed in production 2026-05-26 on
// both fetchLatest (wedged coalesceRefresh) and fetchTimeframe (wedged seed).
function withHardTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} hard timeout (${ms}ms)`)),
      ms,
    );
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class MetalpriceClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor() {
    assertConfig();
    this.baseUrl = config.metalpriceApiBase.replace(/\/$/, "");
    this.apiKey = config.metalpriceApiKey;
  }

  async fetchLatest(
    params: {
      base?: string;
      currencies?: string[];
      math?: string;
    } = {},
  ): Promise<LatestRatesResponse> {
    return withHardTimeout(this._fetchLatest(params), 25000, "fetchLatest");
  }

  private async _fetchLatest(params: {
    base?: string;
    currencies?: string[];
    math?: string;
  }): Promise<LatestRatesResponse> {
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
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      throw new Error(`metalprice latest failed: ${res.status}`);
    }
    return (await res.json()) as LatestRatesResponse;
  }

  async fetchTimeframe(params: {
    start_date: string;
    end_date: string;
    base?: string;
    currencies?: string[];
  }): Promise<TimeframeResponse> {
    return withHardTimeout(
      this._fetchTimeframe(params),
      70000,
      "fetchTimeframe",
    );
  }

  private async _fetchTimeframe(params: {
    start_date: string;
    end_date: string;
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
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      throw new Error(`metalprice timeframe failed: ${res.status}`);
    }
    return (await res.json()) as TimeframeResponse;
  }
}

export function fetchChange(params: {
  start_date?: string;
  end_date?: string;
  date_type?: "recent" | "yesterday" | "week" | "month" | "year";
  base?: string;
  currencies?: string[];
}): Promise<ChangeResponse> {
  return withHardTimeout(_fetchChange(params), 25000, "fetchChange");
}

async function _fetchChange(params: {
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
  if (params.currencies && params.currencies.length)
    url.searchParams.set("currencies", params.currencies.join(","));
  const res = await fetch(url.toString(), {
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": metalpriceApiKey,
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    throw new Error(`metalprice change failed: ${res.status}`);
  }
  return res.json() as Promise<ChangeResponse>;
}
