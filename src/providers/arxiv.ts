import { requestText } from "../http.js";
import type { Provenance } from "../http.js";
import type { ArtHit } from "../types.js";

function decode(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

/** Parse an arXiv Atom feed into hits. Perf: P1 · O(feed length) · CRAP <= 10 (CC 2). */
export function parseArxivFeed(xml: string, provenance: Provenance): ArtHit[] {
  const hits: ArtHit[] = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const body = match[1] ?? "";
    const pick = (tag: string): string | undefined => {
      const found = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(body);
      return found?.[1] !== undefined ? decode(found[1]) : undefined;
    };
    const id = pick("id") ?? "";
    hits.push({
      kind: "preprint",
      id: id.replace(/^https?:\/\/arxiv\.org\/abs\//, "arXiv:"),
      title: pick("title") ?? "(untitled)",
      summary: pick("summary"),
      date: pick("published")?.slice(0, 10),
      authors: [...body.matchAll(/<name>([^<]+)<\/name>/g)].map((author) => decode(author[1] ?? "")).slice(0, 6),
      venue: "arXiv",
      url: id,
      provenance,
    });
  }
  return hits;
}

/** Turn `"exact phrase" word` into arXiv's field syntax: all:"exact phrase" AND all:word. Perf: P0 · O(n) · CRAP <= 10 (CC 2). */
export function arxivQuery(query: string): string {
  const parts = (query.match(/"[^"]+"|\S+/g) ?? []).filter((part) => !/^(AND|OR|NOT)$/.test(part));
  return parts.map((part) => `all:${part.startsWith('"') ? part : part.replace(/[^\w-]/g, "")}`).join(" AND ");
}

/**
 * arXiv API search. No key. The arXiv API terms ask for no more than one
 * request every three seconds, enforced here with a 20-per-minute bucket.
 * Perf: P1 · one request, cached 24 h · CRAP <= 10 (CC 1).
 */
export async function searchArxiv(query: string, limit = 10): Promise<ArtHit[]> {
  const result = await requestText({
    provider: "arxiv",
    route: "/api/query",
    query: { search_query: arxivQuery(query), start: 0, max_results: Math.min(limit, 50) },
    rateLimit: { name: "arxiv:default", perMinute: 20 },
    cache: { ttlMs: 24 * 60 * 60_000 },
  });
  return parseArxivFeed(result.text, result.provenance);
}
