import { config } from "../config.js";
import { requestJson } from "../http.js";
import type { ArtHit } from "../types.js";

interface OpenAlexWork {
  id?: string;
  doi?: string;
  title?: string;
  display_name?: string;
  publication_date?: string;
  abstract_inverted_index?: Record<string, number[]>;
  authorships?: Array<{ author?: { display_name?: string } }>;
  primary_location?: { source?: { display_name?: string }; landing_page_url?: string };
}

/** OpenAlex ships abstracts as an inverted index; rebuild the text. Perf: P1 · O(words) · CRAP <= 10 (CC 2). */
export function abstractFromIndex(index: Record<string, number[]> | undefined): string | undefined {
  if (!index) return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const position of positions) words[position] = word;
  return words.filter(Boolean).join(" ") || undefined;
}

/**
 * OpenAlex works search. `search` accepts AND, OR, NOT and quoted phrases.
 * A key is optional; without one, requests share a small daily budget.
 * Perf: P1 · one request, cached 24 h · CRAP <= 10 (CC 2).
 */
export async function searchWorks(query: string, limit = 15): Promise<ArtHit[]> {
  const result = await requestJson<{ results?: OpenAlexWork[] }>({
    provider: "openalex",
    route: "/works",
    query: {
      search: query,
      "per-page": Math.min(limit, 50),
      select: "id,doi,title,display_name,publication_date,abstract_inverted_index,authorships,primary_location",
      api_key: config.providers.openalex.key,
    },
    rateLimit: { name: "openalex:default", perMinute: 60 },
    cache: { ttlMs: 24 * 60 * 60_000 },
  });
  // The key travels as a query parameter; keep it out of provenance.
  const provenance = { ...result.provenance, route: result.provenance.route.replace(/([?&])api_key=[^&]*&?/, "$1").replace(/[?&]$/, "") };
  return (result.data.results ?? []).map((work) => ({
    kind: "paper" as const,
    id: work.doi ?? work.id ?? "",
    title: work.title ?? work.display_name ?? "(untitled)",
    summary: abstractFromIndex(work.abstract_inverted_index),
    date: work.publication_date,
    authors: (work.authorships ?? []).map((entry) => entry.author?.display_name).filter((name): name is string => Boolean(name)).slice(0, 6),
    venue: work.primary_location?.source?.display_name,
    url: work.doi ?? work.primary_location?.landing_page_url ?? work.id,
    provenance,
  }));
}
