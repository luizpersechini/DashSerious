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

const QUERY = "gold price OR silver price OR precious metals OR copper nickel cobalt";

function tagArticle(title: string, description: string): string[] {
  const text = (title + " " + description).toLowerCase();
  const tags: string[] = [];
  for (const { tag, terms } of METAL_KEYWORDS) {
    if (terms.some(t => text.includes(t))) tags.push(tag);
  }
  return tags;
}

export async function fetchNews(apiKey: string): Promise<NewsItem[]> {
  const url = new URL(BASE_URL);
  url.searchParams.set("q", QUERY);
  url.searchParams.set("language", "en");
  url.searchParams.set("apikey", apiKey);

  const res = await fetch(url.toString());
  const data = (await res.json()) as NewsDataResponse;

  if (data.status !== "success" || !data.results) {
    throw new Error(data.message ?? "NewsData.io error");
  }

  const items: NewsItem[] = data.results.map(r => ({
    id: Buffer.from(r.link).toString("base64").slice(0, 16),
    title: r.title,
    description: (r.description ?? "").slice(0, 200),
    link: r.link,
    source: r.source_id,
    pubDate: r.pubDate,
    pubMs: Date.parse(r.pubDate) || 0,
    tags: tagArticle(r.title, r.description ?? ""),
  }));

  // Deduplicate by title (same story from multiple syndicated sources)
  const seen = new Set<string>();
  const unique = items.filter(item => {
    const key = item.title.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.sort((a, b) => b.pubMs - a.pubMs);
}
