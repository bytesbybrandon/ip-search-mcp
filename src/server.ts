import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, credentialStates } from "./config.js";
import { toErrorPayload, IpError } from "./errors.js";
import { ASSESSMENT_DISCLAIMER, assessConcept } from "./domain/assessment.js";
import { claimStats, lintClaims } from "./domain/claims.js";
import { assessDisclosure } from "./domain/disclosure.js";
import { SHAPE_DOCS, renderSheet } from "./domain/drawings/render.js";
import { formatReport, validateDrawing } from "./domain/drawings/validate.js";
import { DRAWING_RULES, SHEET_PRESETS } from "./domain/drawings/rules.js";
import { buildAttorneyPacket, draftClaims, draftSpecification, DRAFT_BANNER } from "./domain/spec.js";
import { parsePatentNumber, patentQueryVariants } from "./numbers.js";
import * as indexProvider from "./providers/index.js";
import * as odp from "./providers/odp.js";
import * as ops from "./providers/ops.js";
import * as ppubs from "./providers/ppubs.js";
import * as tmsearch from "./providers/tmsearch.js";
import * as tsdr from "./providers/tsdr.js";
import { generateQueries } from "./domain/relevance.js";
import { mapLimit, priorArtSearch, readPatent } from "./research.js";
import type { PatentHit, TrademarkHit } from "./types.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(toErrorPayload(error), null, 2) }], isError: true };
}

async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    return fail(error);
  }
}

const shapeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rect"), x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(), hatch: z.boolean().optional(), strokeWidth: z.number().positive().optional(), rx: z.number().optional() }),
  z.object({ type: z.literal("circle"), cx: z.number(), cy: z.number(), r: z.number().positive(), hatch: z.boolean().optional(), strokeWidth: z.number().positive().optional() }),
  z.object({ type: z.literal("ellipse"), cx: z.number(), cy: z.number(), rx: z.number().positive(), ry: z.number().positive(), strokeWidth: z.number().positive().optional() }),
  z.object({ type: z.literal("line"), x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), dashed: z.boolean().optional(), strokeWidth: z.number().positive().optional() }),
  z.object({ type: z.literal("polyline"), points: z.array(z.tuple([z.number(), z.number()])).min(2), closed: z.boolean().optional(), strokeWidth: z.number().positive().optional() }),
  z.object({ type: z.literal("path"), d: z.string().min(1), strokeWidth: z.number().positive().optional() }),
  z.object({ type: z.literal("text"), x: z.number(), y: z.number(), text: z.string(), size: z.number().optional(), anchor: z.enum(["start", "middle", "end"]).optional() }),
  z.object({ type: z.literal("reference"), x: z.number(), y: z.number(), number: z.number().int().nonnegative(), leaderTo: z.tuple([z.number(), z.number()]).optional() }),
]);

const figureSchema = z.object({
  label: z.string().optional(),
  elements: z.array(shapeSchema),
});

const sheetSchema = z.object({
  preset: z.enum(["A4", "Letter"]).optional(),
  title: z.string().optional(),
  inventor: z.string().optional(),
  docket: z.string().optional(),
  sheetNumber: z.number().int().positive().optional(),
  totalSheets: z.number().int().positive().optional(),
  figures: z.array(figureSchema),
});

const provenanceSchema = z.object({
  provider: z.enum(["odp", "tsdr", "ops", "ppubs", "tmsearch", "index", "openalex", "arxiv", "github", "derived"]),
  route: z.string(),
  retrievedAt: z.string(),
  sourceId: z.string().optional(),
  undocumented: z.boolean().optional(),
  cached: z.boolean().optional(),
  note: z.string().optional(),
});

const patentHitSchema = z.object({
  kind: z.literal("patent"),
  number: z.string(),
  displayNumber: z.string(),
  patentKind: z.enum(["grant", "application", "publication", "pct"]),
  title: z.string().optional(),
  abstract: z.string().optional(),
  filingDate: z.string().optional(),
  effectiveFilingDate: z.string().optional(),
  grantDate: z.string().optional(),
  publicationDate: z.string().optional(),
  inventors: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
  cpc: z.array(z.string()).optional(),
  status: z.string().optional(),
  patentNumber: z.string().optional(),
  applicationNumber: z.string().optional(),
  url: z.string().optional(),
  provenance: provenanceSchema,
});

const trademarkHitSchema = z.object({
  kind: z.literal("trademark"),
  markText: z.string(),
  serialNumber: z.string().optional(),
  registrationNumber: z.string().optional(),
  owner: z.string().optional(),
  filingDate: z.string().optional(),
  registrationDate: z.string().optional(),
  internationalClasses: z.array(z.number()).optional(),
  goodsAndServices: z.string().optional(),
  status: z.string().optional(),
  statusDate: z.string().optional(),
  alive: z.boolean().optional(),
  markImageUrl: z.string().optional(),
  provenance: provenanceSchema,
});

async function autoPatentSearch(
  query: string,
  limit: number,
  requested: "auto" | "odp" | "ops" | "ppubs" | "index",
): Promise<{ hits: PatentHit[]; notes: string[]; providers: string[] }> {
  const notes: string[] = [];
  const providers: string[] = [];
  const order: Array<"odp" | "ops" | "ppubs" | "index"> = requested === "auto"
    ? ["odp", "ops", "index", ...(config.allowUnofficial ? (["ppubs"] as const) : [])]
    : [requested];

  for (const provider of order) {
    try {
      if (provider === "odp") {
        if (!config.providers.odp.key) {
          notes.push("odp skipped: USPTO_ODP_API_KEY not set");
          continue;
        }
        const result = await odp.searchApplications({ q: query, limit });
        providers.push("odp");
        return { hits: result.hits, notes, providers };
      }
      if (provider === "ops") {
        if (!config.providers.ops.key || !config.providers.ops.clientSecret) {
          notes.push("ops skipped: EPO_OPS_CLIENT_ID/EPO_OPS_CLIENT_SECRET not set");
          continue;
        }
        const result = await ops.search(query, { limit });
        providers.push("ops");
        return { hits: result.hits, notes, providers };
      }
      if (provider === "ppubs") {
        const result = await ppubs.search({ query, limit });
        providers.push("ppubs");
        return { hits: result.hits, notes: [...notes, ...result.warnings], providers };
      }
      if (provider === "index") {
        const status = indexProvider.indexStatus();
        if (!status.exists || status.patents === 0) {
          notes.push(`index skipped: ${indexProvider.EMPTY_INDEX_WARNING}`);
          continue;
        }
        const result = indexProvider.searchPatents(query, { limit });
        providers.push("index");
        return { hits: result.hits, notes, providers };
      }
    } catch (error) {
      notes.push(`${provider} failed: ${error instanceof IpError ? error.message : String(error)}`);
    }
  }
  return { hits: [], notes, providers };
}

/**
 * Patent hits for a concept screen: generated queries, light hydration, no
 * expansion, so the screen stays quick. Falls back to the provider chain when
 * ODP is not configured, or when every ODP run failed and nothing was found.
 * Perf: P2 · cold, 21 to 63 title pages and at most 10 full texts; seconds when cached · CRAP <= 15 (CC 5).
 */
async function conceptPatentSearch(concept: string): Promise<{ hits: PatentHit[]; notes: string[] }> {
  const fallback = async (notes: string[]): Promise<{ hits: PatentHit[]; notes: string[] }> => {
    const chain = await autoPatentSearch(generateQueries(concept).patentQueries[0] ?? concept.slice(0, 300), 10, "auto");
    return { hits: chain.hits, notes: [...notes, ...chain.notes] };
  };
  if (!config.providers.odp.key) return fallback([]);
  const result = await priorArtSearch({ description: concept, sources: ["patents"], limit: 10, hydrate: 10, expand: false });
  const failed = result.runs.filter((run) => run.error);
  const failures = failed.map((run) => `${run.source} "${run.query}" failed: ${run.error}`);
  if (result.results.length === 0 && failed.length > 0 && failed.length === result.runs.length) return fallback(failures);
  const hits: PatentHit[] = result.results.map((candidate) => ({
    kind: "patent",
    number: candidate.id,
    displayNumber: candidate.id,
    patentKind: candidate.id.startsWith("US-APP-") ? "application" : "grant",
    title: candidate.title,
    abstract: candidate.why,
    grantDate: candidate.date,
    assignees: candidate.owner ? [candidate.owner] : undefined,
    status: candidate.status,
    applicationNumber: candidate.applicationNumber,
    url: candidate.url,
    provenance: candidate.provenance,
  }));
  return { hits, notes: failures };
}

async function autoTrademarkSearch(
  params: tmsearch.TmSearchParams,
): Promise<{ hits: TrademarkHit[]; notes: string[]; providers: string[] }> {
  const notes: string[] = [];
  const providers: string[] = [];
  if (config.allowUnofficial) {
    try {
      const result = await tmsearch.search(params);
      providers.push("tmsearch");
      return { hits: result.hits, notes: result.warnings, providers };
    } catch (error) {
      notes.push(`tmsearch failed: ${error instanceof IpError ? error.message : String(error)}`);
    }
  } else {
    notes.push("tmsearch skipped: set IP_ALLOW_UNOFFICIAL=1 to enable trademark discovery");
  }

  if (params.query || params.markText) {
    const status = indexProvider.indexStatus();
    if (status.exists && status.trademarks > 0) {
      const result = indexProvider.searchTrademarks(params.query ?? params.markText ?? "", { limit: params.limit ?? 20 });
      providers.push("index");
      return {
        hits: result.hits,
        notes: ["searched the local bulk index; the Trademark Search backend is disabled", ...notes.filter((note) => !note.startsWith("tmsearch skipped"))],
        providers,
      };
    }
    notes.push(`index skipped: ${indexProvider.EMPTY_INDEX_WARNING}`);
  }
  return { hits: [], notes, providers };
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "ip-search-mcp", version: "0.1.0" },
    { instructions: "Search patents and trademarks, screen concepts, and draft review-only application artifacts. Nothing here files, signs, or submits anything." },
  );

  server.registerTool(
    "credential_status",
    {
      title: "Credential and provider status",
      description:
        "Report which IP data providers are configured, which are disabled, and exactly which environment variables each needs. Keys never cross hosts: the ODP key goes only to api.uspto.gov and the TSDR key only to tsdrapi.uspto.gov.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () =>
      guard(async () =>
        ok({
          allowUnofficial: config.allowUnofficial,
          providers: credentialStates(),
          localIndex: indexProvider.indexStatus(),
          notes: [
            "Undocumented surfaces (Patent Public Search, Trademark Search backend) are disabled unless IP_ALLOW_UNOFFICIAL=1.",
            "Nothing in this server files, signs, or submits an application.",
          ],
        }),
      ),
  );

  server.registerTool(
    "concept_assessment",
    {
      title: "Assess a concept for patentability and registrability signals",
      description:
        "Screen an idea or project before drafting. Runs the available patent and trademark searches, then reports 35 U.S.C. 101 subject-matter risks, CPC and Nice classification hypotheses, closest hits by term overlap, trademark distinctiveness band, and DuPont factors. This is a triage screen, not an opinion.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        concept: z.string().min(20).describe("Plain-language description of the idea or project"),
        productName: z.string().optional().describe("Proposed trademark or product name"),
        patentHits: z.array(patentHitSchema).optional().describe("Hits gathered elsewhere; merged with live results"),
        trademarkHits: z.array(trademarkHitSchema).optional(),
        searchLive: z.boolean().optional().describe("Run live searches (default true)"),
      },
    },
    async ({ concept, productName, patentHits = [], trademarkHits = [], searchLive = true }) =>
      guard(async () => {
        let patents: PatentHit[] = [...patentHits];
        let trademarks: TrademarkHit[] = [...trademarkHits];
        const notes: string[] = [];
        if (searchLive) {
          // Several generated title queries over the whole description, not the first 300 characters as one query.
          const patentResult = await conceptPatentSearch(concept);
          patents = [...patents, ...patentResult.hits];
          notes.push(...patentResult.notes);
          const markResult = await autoTrademarkSearch({
            markText: productName,
            query: productName ? undefined : concept.slice(0, 60),
            limit: 10,
          });
          trademarks = [...trademarks, ...markResult.hits];
          notes.push(...markResult.notes);
        }
        const assessment = assessConcept({ concept, productName, patentHits: patents, trademarkHits: trademarks });
        return ok({ ...assessment, disclaimer: ASSESSMENT_DISCLAIMER, searchNotes: [...new Set(notes)], draftBanner: DRAFT_BANNER });
      }),
  );

  server.registerTool(
    "patents_search",
    {
      title: "Search patents and published applications",
      description:
        "Search USPTO file-wrapper metadata (ODP), worldwide publications (EPO OPS), the local bulk index, or the undocumented Patent Public Search. Auto mode tries documented sources first. Date bounds (from/to) are only honored by EPO OPS and the local index; ODP date filtering is not verified and is rejected. Every hit carries provider, route, and retrieval time; undocumented sources are labeled.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        query: z.string().min(1),
        provider: z.enum(["auto", "odp", "ops", "ppubs", "index"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        from: z.string().optional().describe("ISO date lower bound"),
        to: z.string().optional().describe("ISO date upper bound"),
        sort: z.enum(["relevance", "date"]).optional(),
        filters: z.array(z.object({ name: z.string(), value: z.array(z.string()) })).optional(),
      },
    },
    async ({ query, provider = "auto", limit = 20, from, to, sort, filters }) =>
      guard(async () => {
        const notes: string[] = [];
        const hasDates = Boolean(from || to);

        if (hasDates) {
          const dateHint =
            "ODP date-range filtering is not verified. Use provider ops (CQL pd within) or provider index (filing_date), or drop from/to.";
          if (provider === "odp" || provider === "ppubs") {
            throw new IpError("INVALID_INPUT", `${provider} does not support verified date bounds`, {
              provider,
              hint: dateHint,
            });
          }
          if (provider === "ops") {
            const result = await ops.search(query, { limit, from, to });
            return ok({
              total: result.total ?? result.hits.length,
              hits: result.hits,
              providers: ["ops"],
              provenance: result.provenance,
              notes,
            });
          }
          if (provider === "index") {
            const status = indexProvider.indexStatus();
            if (!status.exists || status.patents === 0) {
              throw new IpError("INVALID_INPUT", "the local index has no patents", {
                hint: indexProvider.EMPTY_INDEX_WARNING,
              });
            }
            const result = indexProvider.searchPatents(query, { limit, from, to });
            return ok({ total: result.total, hits: result.hits, providers: ["index"], provenance: result.provenance, notes });
          }
          if (config.providers.ops.key && config.providers.ops.clientSecret) {
            const result = await ops.search(query, { limit, from, to });
            return ok({
              total: result.total ?? result.hits.length,
              hits: result.hits,
              providers: ["ops"],
              provenance: result.provenance,
              notes,
            });
          }
          const status = indexProvider.indexStatus();
          if (status.exists && status.patents > 0) {
            const result = indexProvider.searchPatents(query, { limit, from, to });
            return ok({
              total: result.total,
              hits: result.hits,
              providers: ["index"],
              provenance: result.provenance,
              notes: ["date bounds applied by the local index"],
            });
          }
          throw new IpError("INVALID_INPUT", "no date-capable provider is configured", {
            hint: "Configure EPO OPS credentials or build the local index. ODP date filtering is not verified.",
          });
        }

        const effectiveProvider = provider === "odp" ? "auto" : provider;
        if (provider === "odp" || provider === "auto") {
          if (provider === "odp" || config.providers.odp.key) {
            try {
              const result = await odp.searchApplications({
                q: query,
                limit,
                filters,
                sort: sort === "date" ? [{ field: "filingDate", order: "desc" }] : undefined,
              });
              notes.push("ODP sort and filter field names are not verified without the signed-in documentation.");
              return ok({
                total: result.count,
                hits: result.hits,
                facets: result.facets,
                provenance: result.provenance,
                notes,
              });
            } catch (error) {
              if (provider === "odp") throw error;
              notes.push(`odp: ${error instanceof IpError ? error.message : String(error)}`);
            }
          } else {
            notes.push("odp skipped: USPTO_ODP_API_KEY not set");
          }
        }
        const result = await autoPatentSearch(query, limit, effectiveProvider);
        return ok({ total: result.hits.length, hits: result.hits, providers: result.providers, notes: [...notes, ...result.notes] });
      }),
  );

  server.registerTool(
    "prior_art_search",
    {
      title: "Prior-art search across patents, papers, preprints, and code",
      description:
        "Give a plain-language description (or explicit boolean queries). Generates several queries, searches USPTO patents (titles, CPC classes, and citation links, then full text and claims), OpenAlex papers, arXiv preprints, and GitHub repositories, and returns one list ranked by relevance with why each hit overlaps. Queries support AND, OR, NOT, quoted phrases, and trailing * wildcards. A cold search can make up to about 120 USPTO requests (paced at 60 per minute, so roughly two minutes); repeat searches use the cache, and a lower hydrate makes a first run faster. A zero or low score is never evidence of novelty.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        description: z.string().min(20).optional().describe("Plain-language description of the invention or feature"),
        queries: z.array(z.string().min(2)).max(20).optional().describe("Explicit boolean queries; replaces generated queries"),
        sources: z.array(z.enum(["patents", "papers", "preprints", "code"])).optional().describe("Default: all four"),
        limit: z.number().int().min(1).max(200).optional().describe("Rows returned (default 25)"),
        hydrate: z.number().int().min(0).max(100).optional().describe("Most patent full texts read, across all waves; each read is one USPTO request (default 50)"),
        expand: z.boolean().optional().describe("Expand by CPC class and citations (default true)"),
      },
    },
    async ({ description, queries, sources, limit, hydrate, expand }) =>
      guard(async () => ok(await priorArtSearch({ description, queries, sources, limit, hydrate, expand }))),
  );

  server.registerTool(
    "patent_read",
    {
      title: "Read top patent hits: claims, status, term, owner, overlap",
      description:
        "For each US patent or application number: current owner, status, estimated expiry and maintenance-fee state, every independent claim in full, and, when a description is given, which of its key terms each independent claim shares and lacks. Term and in-force values are estimates for triage, not a legal status.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        numbers: z.array(z.string().min(5)).min(1).max(20).describe("US patent numbers (9765584) or application numbers (15/234,567)"),
        description: z.string().optional().describe("The feature to compare each independent claim against"),
      },
    },
    async ({ numbers, description }) =>
      guard(async () => {
        const readings = await mapLimit(numbers, 4, async (number) => {
          try {
            return { number, ok: true as const, reading: await readPatent(number, description) };
          } catch (error) {
            return { number, ok: false as const, error: toErrorPayload(error) };
          }
        });
        return ok({ readings, disclaimer: "Term, status, and overlap are triage aids for a practitioner, not legal conclusions." });
      }),
  );

  server.registerTool(
    "patent_get",
    {
      title: "Retrieve one patent or application",
      description:
        "Resolve an identifier to a record. Application numbers go to the ODP file wrapper; publication or grant numbers go to EPO OPS bibliographic data when OPS is configured. Ambiguous eight-digit values return both readings.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        number: z.string().min(3).describe("Grant, application, publication, or PCT number"),
        includeAbstract: z.boolean().optional(),
        includeContinuity: z.boolean().optional(),
      },
    },
    async ({ number, includeContinuity }) =>
      guard(async () => {
        const parsed = parsePatentNumber(number);
        const response: Record<string, unknown> = { parsed: { kind: parsed.kind, digits: parsed.digits, display: parsed.display, alternatives: parsed.alternatives } };
        const notes: string[] = [];
        if (parsed.kind === "application" || parsed.kind === "ambiguous") {
          if (!config.providers.odp.key) notes.push("ODP key missing; file-wrapper lookup unavailable");
          else {
            const application = parsed.kind === "application" ? parsed.digits : parsed.digits;
            try {
              const metadata = await odp.getMetadata(application);
              response.odp = { ...metadata.wrapper, provenance: metadata.provenance };
              if (includeContinuity) {
                const continuity = await odp.getContinuity(application);
                response.continuity = continuity.data;
              }
            } catch (error) {
              if (parsed.kind === "application") throw error;
              notes.push(`ODP: ${error instanceof IpError ? error.message : String(error)}`);
            }
          }
        }
        if (parsed.kind !== "application" || config.providers.ops.key) {
          if (!config.providers.ops.key || !config.providers.ops.clientSecret) {
            notes.push("EPO OPS credentials missing; bibliographic lookup unavailable");
          } else {
            const hits = await ops.bibliographic(parsed.digits);
            response.bibliographic = hits.hits;
          }
        }
        return ok({ ...response, variants: patentQueryVariants(number), notes });
      }),
  );

  server.registerTool(
    "patent_documents",
    {
      title: "List patent file-wrapper documents",
      description:
        "List prosecution documents for an application through the ODP file wrapper: office actions, responses, notices, and their download URLs. Requires an ODP key.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        application: z.string().min(3).describe("Application number, e.g. 15/234,567"),
        codeFilter: z.string().optional().describe("Only documents whose code contains this value, e.g. CTNF"),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ application, codeFilter, limit = 50 }) =>
      guard(async () => {
        const result = await odp.getDocuments(application);
        const documents = result.documents
          .filter((document) =>
            codeFilter ? String(document.documentCode ?? "").toUpperCase().includes(codeFilter.toUpperCase()) : true,
          )
          .slice(0, limit);
        return ok({ count: result.documents.length, returned: documents.length, documents, provenance: result.provenance });
      }),
  );

  server.registerTool(
    "patent_family",
    {
      title: "Patent family and worldwide members",
      description:
        "Return the patent family for a publication through EPO OPS, including members and their offices. Requires EPO OPS credentials.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: { number: z.string().min(3) },
    },
    async ({ number }) =>
      guard(async () => {
        const result = await ops.family(number);
        return ok({ family: result.data, provenance: result.provenance, imagesUrl: ops.imageUrl(number) });
      }),
  );

  server.registerTool(
    "trademarks_search",
    {
      title: "Search trademarks",
      description:
        "Find candidate marks. USPTO publishes no trademark search API, so results come from the undocumented Trademark Search backend (requires IP_ALLOW_UNOFFICIAL=1) or the local bulk index. Always hydrate a candidate with trademark_get before relying on its status.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        query: z.string().optional(),
        markText: z.string().optional(),
        ownerName: z.string().optional(),
        goodsServices: z.string().optional(),
        internationalClass: z.number().int().min(1).max(45).optional(),
        status: z.enum(["live", "dead"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (params) =>
      guard(async () => {
        const result = await autoTrademarkSearch({ ...params, limit: params.limit ?? 20 });
        return ok({
          hits: result.hits,
          providers: result.providers,
          searched: result.providers.length > 0,
          notes: [
            ...result.notes,
            "Candidates are not a clearance opinion. Screening for likelihood of confusion is a legal judgment under 15 U.S.C. 1052(d).",
          ],
        });
      }),
  );

  server.registerTool(
    "trademark_get",
    {
      title: "Trademark case status",
      description:
        "Authoritative TSDR status for a serial, registration, IR, or reference number: mark, owner, status, classes, goods and services, and mark image URL. Requires a TSDR key (separate from the ODP key).",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        identifier: z.string().min(3).describe("Serial (8 digits), registration number, IR1234567, or REF<reference>"),
      },
    },
    async ({ identifier }) =>
      guard(async () => {
        const status = await tsdr.caseStatus(identifier);
        return ok({
          ...status,
          hit: tsdr.toTrademarkHit(status),
          notes: ["TSDR is a lookup, not a search engine. It requires an identifier from a search or an external source."],
        });
      }),
  );

  server.registerTool(
    "trademark_documents",
    {
      title: "Trademark file-wrapper documents",
      description:
        "List TSDR documents for a case and return the official bundle PDF URL. Requires a TSDR key. PDF and ZIP downloads are limited to 4 per minute by USPTO.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: { identifier: z.string().min(3) },
    },
    async ({ identifier }) =>
      guard(async () => {
        const result = await tsdr.caseDocuments(identifier);
        return ok({
          documents: result.documents,
          bundlePdfUrl: result.bundlePdfUrl,
          provenance: result.provenance,
          notes: ["TSDR allows 4 PDF or ZIP requests per minute per key (12 off-peak)."],
        });
      }),
  );

  server.registerTool(
    "prior_art_report",
    {
      title: "Compose a prior-art search report",
      description:
        "Run one or more queries across available patent sources, deduplicate by number, and produce a Markdown report with provenance, a closest-references table, and the gaps that remain. Review-only output; no filing.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        title: z.string(),
        queries: z.array(z.string().min(2)).min(1).max(10),
        concepts: z.array(z.string()).optional().describe("Claim concepts to map against hits"),
        provider: z.enum(["auto", "odp", "ops", "ppubs", "index"]).optional(),
        limitPerQuery: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ title, queries, concepts = [], provider = "auto", limitPerQuery = 10 }) =>
      guard(async () => {
        const seen = new Map<string, PatentHit>();
        const notes: string[] = [];
        const runs: Array<{ query: string; providers: string[]; count: number }> = [];
        for (const query of queries) {
          const result = await autoPatentSearch(query, limitPerQuery, provider);
          notes.push(...result.notes);
          runs.push({ query, providers: result.providers, count: result.hits.length });
          for (const hit of result.hits) {
            const key = hit.number || hit.displayNumber;
            if (key && !seen.has(key)) seen.set(key, hit);
          }
        }

        const hits = [...seen.values()];
        const searched = runs.some((run) => run.providers.length > 0);
        const lines: string[] = [];
        lines.push(`# Prior art search report: ${title}`);
        lines.push("");
        lines.push(DRAFT_BANNER);
        lines.push("");
        if (!searched) {
          lines.push("> **NO PROVIDER RAN.** This report contains no search evidence and must not be read as a novelty screen.");
          lines.push("");
        }
        lines.push(`Queries run: ${queries.length}. Unique references: ${hits.length}. Provider mode: ${provider}.`);
        lines.push("");
        lines.push("## Search runs");
        for (const run of runs) {
          lines.push(`- "${run.query}": ${run.count} hit(s) from ${run.providers.join(", ") || "no available provider"}`);
        }
        lines.push("");
        lines.push("## References");
        lines.push("| # | Reference | Date | Title | Assignee | Provider |");
        lines.push("|---|-----------|------|-------|----------|----------|");
        hits.slice(0, 100).forEach((hit, index) => {
          lines.push(
            `| ${index + 1} | ${hit.displayNumber || hit.number} | ${hit.publicationDate ?? hit.grantDate ?? hit.filingDate ?? ""} | ${(hit.title ?? "").slice(0, 90)} | ${hit.assignees?.[0] ?? ""} | ${hit.provenance.provider} |`,
          );
        });
        lines.push("");
        if (concepts.length > 0) {
          lines.push("## Concept mapping (draft claim chart skeleton)");
          lines.push("| Concept | Candidate reference | Note |");
          lines.push("|---------|---------------------|------|");
          for (const concept of concepts) {
            const words = concept.toLowerCase().split(/\s+/).filter((word) => word.length > 3);
            const best = hits
              .map((hit) => ({
                hit,
                score: words.filter((word) => `${hit.title ?? ""} ${hit.abstract ?? ""}`.toLowerCase().includes(word)).length,
              }))
              .sort((a, b) => b.score - a.score)[0];
            lines.push(`| ${concept} | ${best?.hit.displayNumber ?? "unmapped"} | ${best?.score ? `${best.score} term match(es); confirm disclosure manually` : "no textual match; inspect manually"} |`);
          }
          lines.push("");
        }
        lines.push("## Gaps and limits");
        for (const note of [...new Set(notes)]) lines.push(`- ${note}`);
        lines.push("- Text search is not a classification search; run CPC classes separately before concluding.");
        lines.push("- Undocumented providers are labeled in each hit and must be verified against official records.");
        lines.push("- This report is not an opinion of patentability.");
        return ok({ markdown: lines.join("\n"), hits, searched, notes: [...new Set(notes)] });
      }),
  );

  server.registerTool(
    "drawing_spec",
    {
      title: "Generate a 37 CFR 1.84 compliant drawing sheet",
      description:
        "Render an SVG sheet with A4 or letter size, fixed margins, scan targets in two catercorner corners, header indicia inside the top margin, black line art, and reference characters at least 0.32 cm high. Shape vocabulary: " +
        JSON.stringify(SHAPE_DOCS),
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        sheet: sheetSchema,
        writeTo: z.string().optional().describe("Absolute path to write the SVG"),
      },
    },
    async ({ sheet, writeTo }) =>
      guard(async () => {
        const rendered = renderSheet(sheet as Parameters<typeof renderSheet>[0]);
        if (writeTo) {
          await mkdir(dirname(resolve(writeTo)), { recursive: true });
          await writeFile(resolve(writeTo), rendered.svg, "utf8");
        }
        return ok({
          svg: rendered.svg,
          sheet: rendered.preset,
          sight: rendered.sight,
          figures: rendered.figures,
          warnings: rendered.warnings,
          writtenTo: writeTo ? resolve(writeTo) : undefined,
          notes: ["Vector SVG for review. Nothing was submitted or filed."],
        });
      }),
  );

  server.registerTool(
    "drawing_validate",
    {
      title: "Validate a drawing against 37 CFR 1.84",
      description:
        "Check an SVG drawing for sheet size, margins and sight, frames, ink color, line weight, minimum text height, reference-character form and placement, view separation and labels, prohibited scale text, and description coverage of reference characters. Returns cited findings plus what the check cannot verify.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        svg: z.string().optional().describe("SVG markup"),
        path: z.string().optional().describe("Path to an SVG file"),
        descriptionText: z.string().optional(),
        expectedFigures: z.array(z.string()).optional(),
        format: z.enum(["json", "markdown"]).optional(),
      },
    },
    async ({ svg, path, descriptionText, expectedFigures, format = "json" }) =>
      guard(async () => {
        let markup = svg;
        if (!markup && path) {
          markup = await readFile(resolve(path), "utf8");
        }
        if (!markup) {
          throw new IpError("INVALID_INPUT", "provide either svg markup or a path", {
            hint: "Pass the sheet returned by drawing_spec, or a file path to an SVG.",
          });
        }
        const report = validateDrawing(markup, { descriptionText, expectedFigures });
        if (format === "markdown") return ok({ markdown: formatReport(report), report });
        return ok(report);
      }),
  );

  server.registerTool(
    "application_draft",
    {
      title: "Draft a patent application for attorney review",
      description:
        "Assemble a specification in examiner-expected order from supplied content, with title, cross-reference, federal sponsorship, field, background, summary, drawings, detailed description, claims, and abstract. Missing sections are reported as gaps, never invented. Output is marked DRAFT - NOT FOR FILING.",
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        title: z.string().min(2),
        inventors: z.array(z.string()).optional(),
        applicant: z.string().optional(),
        docket: z.string().optional(),
        relatedApplications: z.array(z.string()).optional(),
        federallySponsored: z.string().optional(),
        technicalField: z.string().optional(),
        background: z.string().optional(),
        summary: z.string().optional(),
        detailedDescription: z.string().optional(),
        claims: z.string().optional(),
        abstract: z.string().optional(),
        figures: z.array(figureSchema).optional(),
        writeTo: z.string().optional(),
      },
    },
    async (input) =>
      guard(async () => {
        const draft = draftSpecification(input as Parameters<typeof draftSpecification>[0]);
        const lint = input.claims
          ? lintClaims(input.claims, {
              specificationText: [input.title, input.technicalField, input.background, input.summary, input.detailedDescription].filter(Boolean).join("\n"),
              abstractText: input.abstract,
              title: input.title,
            })
          : { claims: [], findings: [] };
        if (input.writeTo) {
          await mkdir(dirname(resolve(input.writeTo)), { recursive: true });
          await writeFile(resolve(input.writeTo), draft.markdown, "utf8");
        }
        return ok({
          markdown: draft.markdown,
          gaps: draft.gaps,
          claimFindings: lint.findings,
          claimStats: lint.claims.length > 0 ? claimStats(lint.claims) : undefined,
          writtenTo: input.writeTo ? resolve(input.writeTo) : undefined,
          notes: ["Draft only. No ADS, declaration, or filing package was generated."],
        });
      }),
  );

  server.registerTool(
    "claims_draft",
    {
      title: "Draft claim scaffolding",
      description:
        "Build one apparatus claim from supplied elements and optionally one method claim from supplied steps. Limitations are never invented; closing gaps are listed.",
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        subject: z.string().min(2).describe("Claim subject, e.g. 'a battery thermal management system'"),
        elements: z.array(z.string().min(3)).describe("Structural elements of the independent claim"),
        methodSteps: z.array(z.string().min(3)).optional(),
      },
    },
    async ({ subject, elements, methodSteps }) =>
      guard(async () => {
        const draft = draftClaims({ subject, elements, methodSteps });
        const normalized = subject.trim().replace(/^(a|an|the)\s+/i, "");
        return ok({
          markdown: draft.markdown,
          gaps: draft.gaps,
          lint: lintClaims(draft.markdown).findings,
          notes: [`Independent claim subject normalized to: "${normalized}"`],
        });
      }),
  );

  server.registerTool(
    "application_lint",
    {
      title: "Lint claims, abstract, and title",
      description:
        "Check claim numbering, forward and multiple dependencies, antecedent basis, means-plus-function triggers, relative terms, specification support, abstract word count (150), and title limits (500 characters, no commendatory language).",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        claims: z.string().min(10),
        specificationText: z.string().optional(),
        abstractText: z.string().optional(),
        title: z.string().optional(),
      },
    },
    async ({ claims, specificationText, abstractText, title }) =>
      guard(async () => {
        const result = lintClaims(claims, { specificationText, abstractText, title });
        return ok({
          ok: result.findings.every((finding) => finding.severity !== "error"),
          stats: claimStats(result.claims),
          claims: result.claims.map((claim) => ({
            number: claim.number,
            independent: claim.independent,
            dependsOn: claim.dependsOn,
            multipleDependency: claim.multipleDependency,
          })),
          findings: result.findings,
        });
      }),
  );

  server.registerTool(
    "disclosure_review",
    {
      title: "Screen public-disclosure bars and the grace clock",
      description:
        "Compute the 35 U.S.C. 102(b)(1) one-year US grace deadline from a recorded disclosure, then apply a cited table of foreign grace provisions: no general grace (EP, GB, DE, FR), narrow exceptions only (CN, IN), and limited 12-month graces with conditions (JP, KR, CA, AU, BR). Date arithmetic only, not legal advice.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        disclosureDate: z.string().describe("ISO date of the earliest public disclosure"),
        disclosureKind: z.enum(["publication", "public-use", "sale", "offer-for-sale", "presentation", "other"]).optional(),
        byInventor: z.boolean().optional(),
        plannedFilingDate: z.string().optional(),
        jurisdictions: z.array(z.string()).optional(),
      },
    },
    async (facts) => guard(async () => ok(assessDisclosure(facts))),
  );

  server.registerTool(
    "drawing_rules",
    {
      title: "List encoded drawing rules",
      description:
        "Return the 37 CFR 1.84 rule set this server validates, with citations, severities, and the eCFR source URL and retrieval date.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => guard(async () => ok({ rules: DRAWING_RULES, presets: SHEET_PRESETS })),
  );

  server.registerTool(
    "attorney_packet",
    {
      title: "Assemble an attorney review packet",
      description:
        "Bundle the concept, drafts, drawing check, prior-art report, and trademark screening into one review packet with open questions and provenance notes. Review-only.",
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        concept: z.string().min(10),
        specification: z.string().optional(),
        claims: z.string().optional(),
        drawingSvg: z.string().optional(),
        priorArtMarkdown: z.string().optional(),
        trademarkFindings: z.string().optional(),
        openQuestions: z.array(z.string()).optional(),
        writeTo: z.string().optional(),
      },
    },
    async ({ concept, specification, claims, drawingSvg, priorArtMarkdown, trademarkFindings, openQuestions = [], writeTo }) =>
      guard(async () => {
        const drawingReport = drawingSvg ? validateDrawing(drawingSvg) : undefined;
        const packet = buildAttorneyPacket({
          concept,
          specification,
          claims,
          drawingReport,
          priorArt: priorArtMarkdown,
          trademarkFindings,
          openQuestions,
        });
        if (writeTo) {
          await mkdir(dirname(resolve(writeTo)), { recursive: true });
          await writeFile(resolve(writeTo), packet, "utf8");
        }
        return ok({ markdown: packet, writtenTo: writeTo ? resolve(writeTo) : undefined, drawingReport });
      }),
  );

  server.registerTool(
    "index_build",
    {
      title: "Build or inspect the local bulk index",
      description:
        "Build a SQLite FTS5 index over a directory of USPTO bulk XML files (patent grants, published applications, trademark daily XML), or report index counts without building.",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        sourceDir: z.string().optional().describe("Directory of XML files; omit to report status only"),
        dbPath: z.string().optional(),
      },
    },
    async ({ sourceDir, dbPath }) =>
      guard(async () => {
        if (!sourceDir) return ok(indexProvider.indexStatus(dbPath));
        const result = await indexProvider.buildIndex(sourceDir, dbPath);
        return ok({ ...result, status: indexProvider.indexStatus(dbPath) });
      }),
  );

  return server;
}
