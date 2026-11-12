# ip-search-mcp Performance Standards

> A repeat question answers in seconds; a first question is bounded by provider rate limits, never by this server's own work.

Most time in this server is spent waiting on public APIs with published rate limits. The standards below keep local work negligible next to that, keep repeat calls on the cache, and make sure no slow or failing source can stall a tool call.

## Performance tiers

| Tier | Target | Use case | Examples |
|------|--------|----------|----------|
| **P0 - Interactive** | < 200 ms | Local work in a tool call | claim parsing, BM25 ranking of a pool, boolean matching, date arithmetic |
| **P1 - Responsive** | < 2 s cached, < 10 s cold | One provider round trip | `patents_search`, `patent_get`, `patent_read`, `trademark_get` |
| **P2 - Background** | < 10 s cached, about 2 min cold | Many paced provider calls | `prior_art_search`, `prior_art_report`, `concept_assessment` |
| **P3 - Batch** | minutes | Offline | `index_build` over bulk XML |

Cold P2 time is set by the provider rate limits in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), not by this server's own work. A default prior-art search makes about 75 to 120 ODP requests (21 title queries of one to three pages, up to 3 class queries, at most `hydrate` full texts across all waves, up to 5 citation lookups), which is why a cold run takes about two minutes; see [docs/TOOLS.md](docs/TOOLS.md). Lower it by caching and by reading fewer documents (`hydrate`), not by raising a limit.

## Complexity budget

### Algorithmic

| Pattern | Complexity | Rule |
|---------|------------|------|
| Ranking a candidate pool | O(docs x tokens) | Pool is bounded (tens to a few hundred documents); never rank a whole corpus in memory |
| Parsing one full-text document | O(length) | Single pass with regular expressions or the XML parser; no repeated re-parsing |
| Provider fan-out | O(queries) requests | Bounded concurrency (`mapLimit`, 3 to 6 in flight) and a shared rate-limit bucket per provider |
| Index search | O(k) | FTS5 query; k = result size |

Forbidden: unbounded provider loops (every expansion step has a fixed cap), an N+1 fetch without a cap, and anything that scales with the size of a provider's corpus.

### Change risk (CRAP)

CRAP(m) = comp(m)^2 x (1 - cov(m))^3 + comp(m)

| Tier | CRAP ceiling | Cyclomatic complexity | Branch coverage |
|------|--------------|-----------------------|-----------------|
| P0 | <= 10 | <= 8 | >= 90% |
| P1 | <= 15 | <= 12 | >= 80% |
| P2 | <= 25 | <= 15 | >= 70% |
| Any | <= 30 | refactor above 30 | - |

Network orchestration (P2) is covered through its pure parts: query generation, ranking, parsing, and term estimation are tested directly with fixtures; the orchestration is tested for its no-key and failure paths.

## Caching and rate limits

Cache TTLs, the cache key, and the per-provider rate-limit buckets are defined once, in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Keys are read once per process (environment, then the Windows user environment) and kept in memory only.

## Checklists

Before writing a provider call:
- Which rate-limit bucket does it use, and is its limit the documented one?
- Is the response cacheable, and for how long?
- What happens when it fails or times out? It must become a note or an error result, never a hang.

Before merging:
- New and changed functions carry a `Perf:` line (tier, Big-O, CRAP target).
- Every fan-out has a cap and bounded concurrency.
- A test covers the pure logic and the failure path.

## Red flags in review

- `await` inside a loop over provider calls without `mapLimit` or a cap.
- A new provider call without a `rateLimit` bucket or a `cache` TTL.
- `Promise.all` over provider calls where one rejection discards the others' results.
- Ranking or matching that tokenizes the same text more than once per call.
- Reading a key per call instead of once per process.

## Annotation format

```ts
/**
 * What the function does.
 * Perf: P1 · O(n log n) · CRAP <= 15 (CC 5, branch coverage >= 80%).
 */
```
