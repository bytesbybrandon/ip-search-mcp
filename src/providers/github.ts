import { config } from "../config.js";
import { requestJson } from "../http.js";
import { plainQuery } from "../domain/relevance.js";
import type { ArtHit } from "../types.js";

interface GithubRepo {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  created_at?: string;
  stargazers_count?: number;
  topics?: string[];
  owner?: { login?: string };
}

/**
 * GitHub repository search (documented REST search API), public repositories
 * only: private code is not prior art, and a token can see private repositories.
 * Space-separated words are ANDed; quoted phrases are supported. The token,
 * when present, only raises the rate limit and is sent only to api.github.com.
 * Perf: P1 · one request, cached 24 h · CRAP <= 10 (CC 2).
 */
export async function searchRepositories(query: string, limit = 10): Promise<ArtHit[]> {
  const token = config.providers.github.key;
  const words = plainQuery(query).replace(/\bAND\b/g, " ").replace(/\s+/g, " ").trim();
  const result = await requestJson<{ items?: GithubRepo[] }>({
    provider: "github",
    route: "/search/repositories",
    // GitHub ANDs bare words and accepts OR and NOT; it has no AND keyword or wildcards.
    query: { q: `${words} is:public`, per_page: Math.min(limit, 50) },
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    rateLimit: { name: "github:search", perMinute: token ? 30 : 10 },
    cache: { ttlMs: 24 * 60 * 60_000 },
  });
  return (result.data.items ?? []).map((repo) => ({
    kind: "code" as const,
    id: repo.full_name ?? "",
    title: repo.full_name ?? "",
    summary: [repo.description ?? "", (repo.topics ?? []).join(" ")].join(" ").trim() || undefined,
    date: repo.created_at?.slice(0, 10),
    authors: repo.owner?.login ? [repo.owner.login] : undefined,
    venue: "GitHub",
    url: repo.html_url,
    stars: repo.stargazers_count,
    provenance: result.provenance,
  }));
}
