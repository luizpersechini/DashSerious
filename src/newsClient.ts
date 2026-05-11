export type NewsItem = {
  id: string;
  title: string;
  description: string;
  link: string;
  source: string;
  pubDate: string;
  pubMs: number;
  tags: string[];
};

type NewsDataResult = {
  title: string;
  description?: string | null;
  link: string;
  source_id: string;
  pubDate: string;
  keywords?: string[] | null;
};

type NewsDataResponse = {
  status: string;
  totalResults?: number;
  results?: NewsDataResult[];
  message?: string;
};

const BASE_URL = "https://newsdata.io/api/1/latest";

const METAL_KEYWORDS: Array<{ tag: string; terms: string[] }> = [
  { tag: "XPD", terms: ["palladium"] },
  { tag: "XPT", terms: ["platinum"] },
  { tag: "XAU", terms: ["gold", "xau"] },
  { tag: "XAG", terms: ["silver", "xag"] },
  { tag: "XCO", terms: ["cobalt"] },
  { tag: "XCU", terms: ["copper"] },
  { tag: "NI",  terms: ["nickel"] },
  { tag: "BRL", terms: ["brl", "real", "brazilian real"] },
];

// Two focused queries fetched in parallel (2 credits per 30-min cache cycle)
const QUERIES = [
  // Precious metals, BRL, macro/geopolitics angle
  "precious metals OR base metals OR Brazilian real OR commodities geopolitics",
  // Industrial metals focus
  "cobalt supply OR nickel market OR copper price OR palladium platinum",
];

function tagArticle(title: string, description: string): string[] {
  const text = (title + " " + description).toLowerCase();
  const tags: string[] = [];
  for (const { tag, terms } of METAL_KEYWORDS) {
    if (terms.some(t => text.includes(t))) tags.push(tag);
  }
  return tags;
}

async function fetchQuery(query: string, apiKey: string): Promise<NewsDataResult[]> {
  const url = new URL(BASE_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("language", "en");
  url.searchParams.set("apikey", apiKey);
  const res = await fetch(url.toString());
  const data = (await res.json()) as NewsDataResponse;
  if (data.status !== "success") return []; // soft-fail per query
  return data.results ?? [];
}

export async function fetchNews(apiKey: string): Promise<NewsItem[]> {
  const results = await Promise.all(QUERIES.map(q => fetchQuery(q, apiKey)));
  const all = results.flat();

  const items: NewsItem[] = all.map(r => ({
    id: Buffer.from(r.link).toString("base64").slice(0, 16),
    title: r.title,
    description: (r.description ?? "").slice(0, 200),
    link: r.link,
    source: r.source_id,
    pubDate: r.pubDate,
    // NewsData.io returns pubDate as "YYYY-MM-DD HH:MM:SS" without timezone.
    // Force UTC parse by replacing the space with 'T' and appending 'Z',
    // otherwise Date.parse treats it as local time (differs between prod UTC and dev UTC-3).
    pubMs: Date.parse((r.pubDate ?? "").replace(" ", "T") + "Z") || 0,
    tags: tagArticle(r.title, r.description ?? ""),
  }));

  const RELEVANCE_TERMS = [
    "gold","silver","platinum","palladium","nickel","copper","cobalt",
    "metal","mineral","mining","commodity","commodities",
    "brl","brazil","real exchange",
    "geopolit","sanction","tariff","trade war","supply chain",
    "market","price","invest","economy","inflation","fed ","interest rate",
    "iran","russia","china trade","opec",
  ];

  function isRelevant(item: NewsItem): boolean {
    if (item.tags.length > 0) return true;
    const text = (item.title + " " + item.description).toLowerCase();
    return RELEVANCE_TERMS.some(t => text.includes(t));
  }

  // Deduplicate by normalised title, then filter relevance
  const seen = new Set<string>();
  const unique = items.filter(item => {
    const key = item.title.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).filter(isRelevant);

  return unique.sort((a, b) => b.pubMs - a.pubMs).slice(0, 20);
}
