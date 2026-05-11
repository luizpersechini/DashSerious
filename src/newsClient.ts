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

// RSS feeds — no API key required, fetched on every refresh cycle
const RSS_FEEDS: Array<{ url: string; sourceId: string }> = [
  { url: "https://www.kitco.com/rss/kitconews.rss",               sourceId: "kitco" },
  { url: "https://www.mining.com/feed/",                          sourceId: "mining.com" },
  { url: "https://www.cnbc.com/id/19836768/device/rss/rss.html",  sourceId: "cnbc" },
];

// ── RSS helpers ────────────────────────────────────────────────────────────────

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? stripCdata(m[1] ?? "").trim() : "";
}

function extractLink(block: string): string {
  // Atom: <link href="..."/>
  const atom = block.match(/<link[^>]+href=["']([^"']+)["']/i);
  if (atom) return atom[1] ?? "";
  // RSS 2.0: <link>url</link>
  const rss = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  if (rss) return stripCdata(rss[1] ?? "").trim();
  // <guid> as fallback
  const guid = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
  if (guid) return stripCdata(guid[1] ?? "").trim();
  return "";
}

function parseRssItems(xml: string, sourceId: string): NewsDataResult[] {
  const items: NewsDataResult[] = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1] ?? "";
    const title = extractTag(block, "title");
    const link  = extractLink(block);
    if (!title || !link) continue;
    const desc    = extractTag(block, "description");
    const pubDate = extractTag(block, "pubDate") || extractTag(block, "dc:date");
    items.push({
      title,
      description: desc ? stripHtml(desc) : null,
      link,
      source_id: sourceId,
      pubDate,
      keywords: null,
    });
  }
  return items;
}

async function fetchRssFeed(url: string, sourceId: string): Promise<NewsDataResult[]> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DashBot/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRssItems(xml, sourceId);
  } catch {
    return []; // soft-fail — bad URL or network error never breaks the feed
  }
}

// ── pubDate parsing ────────────────────────────────────────────────────────────

// NewsData.io: "YYYY-MM-DD HH:MM:SS" (no timezone → must force UTC)
// RSS feeds:   RFC 2822 "Mon, 11 May 2026 14:30:00 +0000" (Date.parse handles correctly)
function parsePubDate(pubDate: string): number {
  if (!pubDate) return 0;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(pubDate)) {
    return Date.parse(pubDate.replace(" ", "T") + "Z") || 0;
  }
  return Date.parse(pubDate) || 0;
}

// ── Core helpers ───────────────────────────────────────────────────────────────

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
  // NewsData.io queries only run when a key is provided
  const apiSources = apiKey
    ? QUERIES.map(q => fetchQuery(q, apiKey))
    : [];

  const rssSources = RSS_FEEDS.map(f => fetchRssFeed(f.url, f.sourceId));

  const results = await Promise.all([...apiSources, ...rssSources]);
  const all = results.flat();

  const items: NewsItem[] = all.map(r => ({
    id:          Buffer.from(r.link).toString("base64").slice(0, 16),
    title:       r.title,
    description: (r.description ?? "").slice(0, 200),
    link:        r.link,
    source:      r.source_id,
    pubDate:     r.pubDate,
    pubMs:       parsePubDate(r.pubDate),
    tags:        tagArticle(r.title, r.description ?? ""),
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

  return unique.sort((a, b) => b.pubMs - a.pubMs).slice(0, 30);
}
