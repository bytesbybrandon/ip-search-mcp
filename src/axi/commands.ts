import { readFile } from "node:fs/promises";
import type { CommandSpec, Parsed } from "./args.js";
import { booleanFlag, numberFlag, stringFlag } from "./args.js";
import { callTool } from "./client.js";
import { AxiError } from "./errors.js";
import { cell, emitBlock, emitKV, emitList, print, toonValue } from "./toon.js";

export interface CommandModule {
  spec: CommandSpec;
  run(parsed: Parsed): Promise<number>;
}

interface PatentHit {
  number?: string;
  displayNumber?: string;
  applicationNumber?: string;
  title?: string;
  abstract?: string;
  filingDate?: string;
  grantDate?: string;
  publicationDate?: string;
  inventors?: string[];
  assignees?: string[];
  cpc?: string[];
  status?: string;
  provenance?: { provider?: string };
}

interface TrademarkHit {
  markText?: string;
  serialNumber?: string;
  registrationNumber?: string;
  owner?: string;
  filingDate?: string;
  registrationDate?: string;
  internationalClasses?: number[];
  goodsAndServices?: string;
  status?: string;
  statusDate?: string;
  alive?: boolean;
  markImageUrl?: string;
}

interface PatentSearchPayload {
  total?: number;
  hits: PatentHit[];
  providers?: string[];
  notes?: string[];
}

interface TrademarkSearchPayload {
  hits: TrademarkHit[];
  providers?: string[];
  searched?: boolean;
  notes?: string[];
}

function patentDate(hit: PatentHit): string {
  return (hit.publicationDate ?? hit.grantDate ?? hit.filingDate ?? "").slice(0, 10);
}

function patentRow(hit: PatentHit, full: boolean): Record<string, unknown> {
  return {
    number: hit.displayNumber ?? hit.number ?? "",
    date: patentDate(hit),
    assignee: cell(hit.assignees?.[0], 40, full),
    title: cell(hit.title, 90, full),
    provider: hit.provenance?.provider ?? "",
    inventors: (hit.inventors ?? []).join("; "),
    cpc: (hit.cpc ?? []).slice(0, 4).join("; "),
    status: cell(hit.status, 40, full),
    application: hit.applicationNumber ?? "",
  };
}

function trademarkRow(hit: TrademarkHit, full: boolean): Record<string, unknown> {
  return {
    mark: cell(hit.markText, 40, full),
    serial: hit.serialNumber ?? "",
    classes: (hit.internationalClasses ?? []).join(","),
    owner: cell(hit.owner, 40, full),
    status: cell(hit.status, 40, full),
    filing: (hit.filingDate ?? "").slice(0, 10),
    registration: hit.registrationNumber ?? "",
    alive: hit.alive === undefined ? "" : String(hit.alive),
    goods: cell(hit.goodsAndServices, 120, full),
  };
}

function requestedFields(fields: string | undefined, defaults: string[], allowed: Set<string>): string[] {
  if (!fields) return defaults;
  const extra = fields
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unknown = extra.filter((entry) => !allowed.has(entry));
  if (unknown.length > 0) {
    throw new AxiError(
      `unknown field '${unknown[0]}'`,
      `valid fields: ${[...allowed].join(", ")}`,
    );
  }
  return [...new Set([...defaults, ...extra])];
}

async function readMaybeFile(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  if (!value.startsWith("@")) return value;
  return readFile(value.slice(1), "utf8");
}

const patentsSearch: CommandModule = {
  spec: {
    name: "patents search",
    summary: "Search patents and applications across configured providers",
    args: [{ name: "query", required: true, description: "free-text query" }],
    flags: [
      { name: "limit", type: "string", default: "20", description: "rows to return" },
      { name: "provider", type: "string", values: ["auto", "odp", "ops", "ppubs", "index"], default: "auto", description: "data source" },
      { name: "from", type: "string", description: "ISO date lower bound (ops or index only)" },
      { name: "to", type: "string", description: "ISO date upper bound (ops or index only)" },
      { name: "fields", type: "string", description: "extra columns, comma separated" },
      { name: "full", type: "boolean", description: "do not truncate cell text" },
    ],
    examples: [
      'ip-axi patents search "self-calibrating optical sensor"',
      'ip-axi patents search "battery thermal management" --provider index --fields status,cpc',
      'ip-axi patents search "valve seat" --from 2015-01-01 --to 2020-12-31',
    ],
  },
  async run(parsed) {
    const query = parsed.positionals[0] ?? "";
    const payload = await callTool<PatentSearchPayload>("patents_search", {
      query,
      limit: numberFlag(parsed, "limit", 20),
      provider: stringFlag(parsed, "provider") ?? "auto",
      from: stringFlag(parsed, "from"),
      to: stringFlag(parsed, "to"),
    });
    const full = booleanFlag(parsed, "full");
    const fields = requestedFields(stringFlag(parsed, "fields"), ["number", "date", "assignee", "title"], new Set([
      "number", "date", "assignee", "title", "provider", "inventors", "cpc", "status", "application",
    ]));
    const rows = payload.hits.map((hit) => patentRow(hit, full));
    const lines = [emitList("results", rows, fields, { total: payload.total })];
    if (payload.hits.length === 0) {
      lines.push(`note: 0 results for "${query}" (provider=${stringFlag(parsed, "provider") ?? "auto"})`);
    }
    const first = payload.hits[0];
    const next = [
      first ? `ip-axi patents get ${first.applicationNumber ?? first.number}` : `ip-axi patents search "${query}" --fields provider,status`,
      first?.applicationNumber ? `ip-axi patents docs ${first.applicationNumber}` : 'ip-axi index build --from <dir-of-bulk-xml>',
      'ip-axi status',
    ];
    lines.push(emitBlock("next", next));
    if (payload.notes && payload.notes.length > 0) lines.push(emitBlock("help", payload.notes));
    print(lines.join("\n"));
    return 0;
  },
};

interface Candidate {
  rank: number;
  source: string;
  id: string;
  title: string;
  date?: string;
  grantDate?: string;
  owner?: string;
  url?: string;
  status?: string;
  score: number;
  coverage: number;
  textRead: string;
  matched: string[];
  foundBy: string[];
  why?: string;
}

interface PriorArtPayload {
  terms: Array<{ term: string }>;
  queries: { patent: string[]; text: string[] };
  results: Candidate[];
  runs: Array<{ source: string; query: string; count: number; error?: string }>;
  notes: string[];
}

const priorArtSearch: CommandModule = {
  spec: {
    name: "prior-art search",
    summary: "Ranked prior art for a description: patents, papers, preprints, code",
    args: [{ name: "description", required: true, description: "plain-language description, or @file" }],
    flags: [
      { name: "query", type: "string", description: "explicit boolean queries separated by ';' (replaces generated ones)" },
      { name: "sources", type: "string", default: "patents,papers,preprints,code", description: "comma-separated subset" },
      { name: "limit", type: "string", default: "25", description: "rows to return" },
      { name: "fields", type: "string", description: "extra columns: grant,url,status,owner,coverage,read,found,why,score (date is the earliest relevant date: a patent's effective filing date, a paper's publication date)" },
      { name: "full", type: "boolean", description: "do not truncate cell text" },
    ],
    examples: [
      'ip-axi prior-art search "A handheld optical sensor that recalibrates against a sealed reference surface when drift exceeds a threshold"',
      "ip-axi prior-art search @idea.md --sources patents --fields why,status",
      'ip-axi prior-art search "drift correction" --query \'"reference surface" AND calibrat*\'',
    ],
  },
  async run(parsed) {
    const description = (await readMaybeFile(parsed.positionals.join(" "))) ?? "";
    const explicit = stringFlag(parsed, "query")?.split(";").map((entry) => entry.trim()).filter(Boolean);
    const sources = (stringFlag(parsed, "sources") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    const payload = await callTool<PriorArtPayload>("prior_art_search", {
      description: description.length >= 20 ? description : undefined,
      queries: explicit && explicit.length > 0 ? explicit : description.length < 20 ? [description] : undefined,
      sources,
      limit: numberFlag(parsed, "limit", 25),
    });
    const full = booleanFlag(parsed, "full");
    const fields = requestedFields(stringFlag(parsed, "fields"), ["rank", "source", "id", "date", "title"], new Set([
      "rank", "source", "id", "date", "title", "grant", "url", "status", "owner", "coverage", "read", "found", "why", "score",
    ]));
    const rows = payload.results.map((hit) => ({
      rank: hit.rank,
      source: hit.source,
      id: hit.id,
      date: (hit.date ?? "").slice(0, 10),
      title: cell(hit.title, 80, full),
      grant: (hit.grantDate ?? "").slice(0, 10),
      url: hit.url ?? "",
      status: cell(hit.status, 40, full),
      owner: cell(hit.owner, 40, full),
      coverage: hit.coverage,
      read: hit.textRead,
      found: cell(hit.foundBy.join("; "), 60, full),
      why: cell(hit.why, 160, full),
      score: hit.score,
    }));
    const lines = [
      emitKV([["terms", payload.terms.map((term) => term.term).join(", ")]]),
      emitList("results", rows, fields),
    ];
    const failed = payload.runs.filter((run) => run.error);
    if (failed.length > 0) lines.push(emitBlock("failed", failed.map((run) => `${run.source} "${run.query}": ${run.error}`)));
    const firstPatent = payload.results.find((hit) => hit.source === "patent" && !hit.id.startsWith("US-APP-"));
    lines.push(
      emitBlock("next", [
        firstPatent ? `ip-axi patents read ${firstPatent.id.replace(/^US/, "")} --description @<same description>` : "ip-axi status",
        "ip-axi prior-art search <description> --fields why,url --full",
      ]),
    );
    lines.push(emitBlock("help", payload.notes));
    print(lines.join("\n"));
    return 0;
  },
};

interface Reading {
  id: string;
  applicationNumber?: string;
  title?: string;
  owner?: string;
  status?: string;
  grantDate?: string;
  term: { inForce: string; estimatedExpiry?: string; basis: string[]; caveats: string[]; maintenance: Array<{ year: number; state: string }> };
  claimCount: number;
  independentClaims: Array<{ number: number; text: string; shared: string[]; notInClaim: string[] }>;
  why?: string;
  note?: string;
  url?: string;
}

const patentsRead: CommandModule = {
  spec: {
    name: "patents read",
    summary: "Independent claims, status, estimated expiry, owner, and overlap for patents",
    args: [{ name: "number", required: true, description: "one or more US patent or application numbers" }],
    flags: [
      { name: "description", type: "string", description: "feature to compare each independent claim against, or @file" },
      { name: "full", type: "boolean", description: "print whole claims" },
    ],
    examples: ["ip-axi patents read 9765584", "ip-axi patents read 9765584 15/234,567 --description @idea.md"],
  },
  async run(parsed) {
    const description = await readMaybeFile(stringFlag(parsed, "description"));
    const payload = await callTool<{ readings: Array<{ number: string; ok: boolean; reading?: Reading; error?: { message?: string; hint?: string } }> }>(
      "patent_read",
      { numbers: parsed.positionals, description },
    );
    const full = booleanFlag(parsed, "full");
    const lines: string[] = [];
    for (const entry of payload.readings) {
      if (!entry.ok || !entry.reading) {
        lines.push(emitKV([["number", entry.number], ["error", entry.error?.message ?? "failed"], ["hint", entry.error?.hint ?? ""]]));
        continue;
      }
      const reading = entry.reading;
      lines.push(
        emitKV([
          ["patent", reading.id],
          ["title", reading.title ?? ""],
          ["owner", reading.owner ?? ""],
          ["status", reading.status ?? ""],
          ["in_force", `${reading.term.inForce} (estimate)`],
          ["expiry_estimate", reading.term.estimatedExpiry ?? ""],
          ["maintenance", reading.term.maintenance.map((fee) => `${fee.year}y:${fee.state}`).join(" ")],
          ["claims", `${reading.claimCount} total, ${reading.independentClaims.length} independent`],
          ["why", reading.why ?? ""],
          ["number_note", reading.note ?? ""],
        ]),
      );
      lines.push(emitBlock("term", [...reading.term.basis, ...reading.term.caveats]));
      lines.push(
        emitList(
          "independent",
          reading.independentClaims.map((claim) => ({ claim: claim.number, shared: claim.shared.join("; "), text: cell(claim.text, 400, full) })),
          description ? ["claim", "shared", "text"] : ["claim", "text"],
        ),
      );
    }
    lines.push(emitBlock("next", ["ip-axi patents docs <application> for the file wrapper", "ip-axi prior-art search <description>"]));
    lines.push(emitBlock("help", ["In-force and expiry are estimates from public data; terminal disclaimers and extensions are not visible."]));
    print(lines.join("\n"));
    return 0;
  },
};

interface ElementRow { element: string; status: string; coverage: number }
interface ChartPayload {
  charts: Array<{ id: string; title?: string; owner?: string; inForce: string; estimatedExpiry?: string; flag: string; claims: Array<{ claim: number; flag: string; elements: ElementRow[] }> }>;
  skipped: Array<{ id: string; reason: string }>;
  disclaimer: string;
}

function chartLines(payload: ChartPayload, full: boolean): string[] {
  const lines: string[] = [];
  for (const chart of payload.charts) {
    lines.push(emitKV([["patent", chart.id], ["title", chart.title ?? ""], ["owner", chart.owner ?? ""], ["in_force", `${chart.inForce} (estimate)`], ["expiry_estimate", chart.estimatedExpiry ?? ""], ["flag", chart.flag]]));
    for (const claim of chart.claims) {
      lines.push(emitList(`claim_${claim.claim}`, claim.elements.map((element) => ({ status: element.status, coverage: element.coverage, element: cell(element.element, 140, full) })), ["status", "coverage", "element"]));
    }
  }
  if (payload.skipped.length > 0) lines.push(emitList("skipped", payload.skipped, ["id", "reason"]));
  return lines;
}

const ftoChart: CommandModule = {
  spec: {
    name: "fto chart",
    summary: "Element-by-element charts of in-force patents against a feature",
    args: [{ name: "number", required: true, description: "one or more US patent numbers" }],
    flags: [
      { name: "feature", type: "string", description: "the feature description, or @file (required)" },
      { name: "full", type: "boolean", description: "do not truncate elements" },
    ],
    examples: ["ip-axi fto chart 9765584 --feature @feature.md"],
  },
  async run(parsed) {
    const feature = await readMaybeFile(stringFlag(parsed, "feature"));
    if (!feature) throw new AxiError("--feature is required", "ip-axi fto chart <number> --feature @feature.md");
    const payload = await callTool<ChartPayload>("fto_chart", { numbers: parsed.positionals, feature });
    const lines = chartLines(payload, booleanFlag(parsed, "full"));
    lines.push(emitBlock("next", ["ip-axi patents read <number> --full for the whole claims", "ip-axi vet @feature.md"]));
    lines.push(emitBlock("help", [payload.disclaimer]));
    print(lines.join("\n"));
    return 0;
  },
};

interface ScanPayload {
  earliestMatch?: { date: string; source: string; url: string; signature?: string };
  liveMatch?: { date: string; url: string; signature?: string };
  earliestCapture?: { date: string; source: string; url: string };
  timeline: Array<{ date: string; source: string; url: string; kind: string; signature?: string }>;
  notes: string[];
  incomplete: boolean;
  assessment?: { usDeadline?: string; urgency: string };
}

function scanLines(payload: ScanPayload, full: boolean): string[] {
  const match = payload.earliestMatch
    ? `${payload.earliestMatch.date.slice(0, 10)} ${payload.earliestMatch.source} ${payload.earliestMatch.url} (no later than; it may be earlier)`
    : payload.liveMatch
      ? `none in any archive; seen live ${payload.liveMatch.date.slice(0, 10)} ${payload.liveMatch.url} (first public date unknown, no US deadline computed)`
      : "none found";
  return [
    emitKV([
      ["earliest_match", match],
      ["earliest_capture", payload.earliestCapture ? `${payload.earliestCapture.date.slice(0, 10)} ${payload.earliestCapture.source}` : "none"],
      ["us_deadline", payload.assessment?.usDeadline ? `${payload.assessment.usDeadline} at the latest` : ""],
      ["urgency", payload.assessment ? `${payload.assessment.urgency}${payload.assessment.urgency === "barred" ? "" : " (at the latest date)"}` : ""],
      ["scan_complete", payload.incomplete ? "no (see notes)" : "yes"],
    ]),
    emitList("timeline", payload.timeline.map((event) => ({ ...event, date: event.date.slice(0, 10), url: cell(event.url, 80, full) })), ["date", "source", "kind", "signature", "url"]),
  ];
}

const disclosureScanCommand: CommandModule = {
  spec: {
    name: "disclosure scan",
    summary: "Dated timeline of when pages first showed a feature (Wayback, urlscan, archive.today, live)",
    args: [{ name: "url", required: true, description: "one or more page or bundle URLs" }],
    flags: [
      { name: "signature", type: "string", description: "exact strings to look for, separated by ';' (required)" },
      { name: "full", type: "boolean", description: "do not truncate URLs" },
    ],
    examples: ['ip-axi disclosure scan https://example.com/ https://example.com/app.js --signature "Recalibrate now;driftThreshold"'],
  },
  async run(parsed) {
    const signatures = (stringFlag(parsed, "signature") ?? "").split(";").map((entry) => entry.trim()).filter(Boolean);
    if (signatures.length === 0) throw new AxiError("--signature is required", 'ip-axi disclosure scan <url> --signature "text one;text two"');
    const payload = await callTool<ScanPayload>("disclosure_scan", { urls: parsed.positionals, signatures });
    const lines = scanLines(payload, booleanFlag(parsed, "full"));
    lines.push(emitBlock("next", ["ip-axi vet @features.md --sites <url,url>"]));
    lines.push(emitBlock("help", payload.notes));
    print(lines.join("\n"));
    return 0;
  },
};

interface VetPayload {
  features: Array<{
    feature: { name: string };
    closestArt: Array<{ id: string; title: string; date?: string; coverage: number; source: string }>;
    fto: ChartPayload;
    disclosure?: ScanPayload;
    disclosureSkipped?: string;
    verdict: { recommendation: string; reasons: string[]; cautions: string[] };
    provisional: string;
    fingerprints: Array<{ signature: string; sha256: string }>;
    notes: string[];
  }>;
  notes: string[];
  disclaimer: string;
}

/** Signatures from --signature (repeatable, or separated by ';') and --signatures-file (one per line). */
async function signaturesFrom(parsed: Parsed): Promise<string[]> {
  const file = stringFlag(parsed, "signatures-file");
  const fromFile = file ? (await readFile(file.replace(/^@/, ""), "utf8")).split(/\r?\n/) : [];
  const all = [...(stringFlag(parsed, "signature") ?? "").split(";"), ...fromFile].map((entry) => entry.trim()).filter(Boolean);
  const short = all.find((entry) => entry.length < 3);
  if (short) throw new AxiError(`signature '${short}' is too short`, "a signature must be at least 3 characters; shorter strings match almost any page");
  return [...new Set(all)];
}

/** A notes block of the lines not yet printed for an earlier feature, so shared caveats appear once. */
function noteBlock(name: string, seen: Set<string>, notes: string[]): string[] {
  const fresh = notes.filter((note) => !seen.has(note));
  for (const note of fresh) seen.add(note);
  return fresh.length > 0 ? [emitBlock(name, fresh)] : [];
}

const vetCommand: CommandModule = {
  spec: {
    name: "vet",
    summary: "Vet features one by one: closest art, FTO flags, disclosure, recommendation",
    args: [{ name: "description", required: true, description: "features as text or @file; split by headings, bullets, or paragraphs" }],
    flags: [
      { name: "whole", type: "boolean", description: "vet the description as one feature" },
      { name: "sites", type: "string", description: "comma-separated public URLs to check for disclosure" },
      { name: "signature", type: "string", repeatable: true, description: "exact string that would show a feature is public; repeat the flag or separate with ';'. Applies to every feature" },
      { name: "signatures-file", type: "string", description: "@file with one signature per line" },
      { name: "detectable", type: "string", values: ["yes", "no"], description: "whether the features can be seen from outside the product" },
      { name: "provisional", type: "boolean", description: "print the provisional-ready draft section" },
      { name: "fingerprints", type: "boolean", description: "print signature fingerprints as JSON lines" },
      { name: "full", type: "boolean", description: "do not truncate cell text" },
    ],
    examples: [
      "ip-axi vet @features.md",
      'ip-axi vet @features.md --sites https://example.com/,https://example.com/app.js --signature "Recalibrate now;driftThreshold" --provisional',
      "ip-axi vet @feature.md --whole --detectable no --signatures-file @signatures.txt --fingerprints",
    ],
  },
  async run(parsed) {
    const description = (await readMaybeFile(parsed.positionals.join(" "))) ?? "";
    const detectable = stringFlag(parsed, "detectable");
    const sites = stringFlag(parsed, "sites")?.split(",").map((entry) => entry.trim()).filter(Boolean);
    const signatures = await signaturesFrom(parsed);
    const payload = await callTool<VetPayload>("vet", {
      description,
      whole: booleanFlag(parsed, "whole"),
      sites,
      signatures: signatures.length > 0 ? signatures : undefined,
      detectable: detectable === undefined ? undefined : detectable === "yes",
    });
    const full = booleanFlag(parsed, "full");
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const result of payload.features) {
      lines.push(emitKV([["feature", result.feature.name], ["recommendation", result.verdict.recommendation]]));
      lines.push(emitBlock("reasons", [...result.verdict.reasons, ...result.verdict.cautions]));
      lines.push(emitList("closest", result.closestArt.map((hit) => ({ source: hit.source, id: hit.id, date: (hit.date ?? "").slice(0, 10), coverage: hit.coverage, title: cell(hit.title, 70, full) })), ["source", "id", "date", "coverage", "title"]));
      lines.push(emitList("fto", result.fto.charts.map((chart) => ({ id: chart.id, flag: chart.flag, in_force: chart.inForce })), ["id", "flag", "in_force"]));
      if (result.fto.skipped.length > 0) lines.push(emitList("fto_skipped", result.fto.skipped, ["id", "reason"]));
      if (result.disclosure) {
        lines.push(...scanLines(result.disclosure, full));
        lines.push(...noteBlock("disclosure_notes", seen, result.disclosure.notes));
      } else lines.push(emitKV([["disclosure", `not checked: ${result.disclosureSkipped ?? "unknown reason"}`]]));
      lines.push(...noteBlock("notes", seen, result.notes));
      if (booleanFlag(parsed, "provisional")) lines.push(emitBlock("provisional", result.provisional.split("\n")));
      if (booleanFlag(parsed, "fingerprints")) lines.push(emitBlock("fingerprints", result.fingerprints.map((entry) => JSON.stringify(entry))));
    }
    if (payload.notes.length > 0) lines.push(emitBlock("run_notes", payload.notes));
    lines.push(emitBlock("next", ["ip-axi fto chart <number> --feature @feature.md --full", "ip-axi patents read <number> --description @feature.md"]));
    lines.push(emitBlock("help", [payload.disclaimer]));
    print(lines.join("\n"));
    return 0;
  },
};

const patentsGet: CommandModule = {
  spec: {
    name: "patents get",
    summary: "Retrieve one patent or application by number",
    args: [{ name: "number", required: true, description: "grant, application, publication, or PCT number" }],
    flags: [{ name: "full", type: "boolean", description: "include continuity data" }],
    examples: ["ip-axi patents get 9765584", "ip-axi patents get 15/234,567 --full"],
  },
  async run(parsed) {
    const number = parsed.positionals[0] ?? "";
    const payload = await callTool<Record<string, unknown>>("patent_get", {
      number,
      includeContinuity: booleanFlag(parsed, "full"),
    });
    const parsedNumber = payload.parsed as { kind?: string; display?: string } | undefined;
    const wrapper = payload.odp as Record<string, unknown> | undefined;
    const meta = wrapper?.applicationMetaData as Record<string, unknown> | undefined;
    const pairs: Array<[string, unknown]> = [
      ["number", parsedNumber?.display ?? number],
      ["kind", parsedNumber?.kind ?? ""],
      ["title", meta?.inventionTitle ?? ""],
      ["status", meta?.applicationStatusDescriptionText ?? ""],
      ["filed", meta?.filingDate ?? ""],
      ["granted", meta?.grantDate ?? ""],
      ["cpc", (meta?.cpcClassificationBag as string[] | undefined)?.slice(0, 5).join("; ") ?? ""],
    ];
    const lines = [emitKV(pairs)];
    if (Array.isArray(payload.bibliographic)) {
      const hits = payload.bibliographic as PatentHit[];
      lines.push(emitList("bibliographic", hits.map((hit) => patentRow(hit, true)), ["number", "date", "title"]));
    }
    if (payload.continuity) lines.push(emitKV([["continuity", "included"]]));
    lines.push(
      emitBlock("next", [
        wrapper?.applicationNumberText ? `ip-axi patents docs ${String(wrapper.applicationNumberText)}` : `ip-axi patents search "${String(meta?.inventionTitle ?? number)}"`,
      ]),
    );
    print(lines.join("\n"));
    return 0;
  },
};

const patentsDocs: CommandModule = {
  spec: {
    name: "patents docs",
    summary: "List file-wrapper documents for an application",
    args: [{ name: "application", required: true, description: "application number, e.g. 19131214" }],
    flags: [
      { name: "limit", type: "string", default: "25", description: "rows to return" },
      { name: "code", type: "string", description: "filter by document code substring" },
      { name: "full", type: "boolean", description: "do not truncate descriptions" },
    ],
    examples: ["ip-axi patents docs 19131214", "ip-axi patents docs 19131214 --code CTNF --limit 5"],
  },
  async run(parsed) {
    const application = parsed.positionals[0] ?? "";
    const payload = await callTool<{ count: number; documents: Array<Record<string, unknown>> }>(
      "patent_documents",
      {
        application,
        codeFilter: stringFlag(parsed, "code"),
        limit: numberFlag(parsed, "limit", 25),
      },
    );
    const full = booleanFlag(parsed, "full");
    const rows = payload.documents.map((document) => ({
      date: String(document.officialDate ?? ""),
      code: String(document.documentCode ?? ""),
      description: cell(String(document.description ?? ""), 70, full),
      pages: String(document.pages ?? ""),
    }));
    const lines = [emitList("documents", rows, ["date", "code", "description", "pages"], { total: payload.count })];
    if (rows.length === 0) lines.push(`note: 0 documents for application ${application}`);
    const url = payload.documents.find((document) => typeof document.downloadUrl === "string")?.downloadUrl;
    lines.push(
      emitBlock("next", [
        url ? `open "${String(url)}"` : `ip-axi patents get ${application}`,
        `ip-axi patents docs ${application} --full`,
      ]),
    );
    print(lines.join("\n"));
    return 0;
  },
};

const patentsFamily: CommandModule = {
  spec: {
    name: "patents family",
    summary: "Worldwide family members via EPO OPS",
    args: [{ name: "number", required: true, description: "publication number" }],
    flags: [{ name: "full", type: "boolean", description: "print the raw family payload" }],
    examples: ["ip-axi patents family US.2020.0123456.A1"],
  },
  async run(parsed) {
    const number = parsed.positionals[0] ?? "";
    const payload = await callTool<{ family: unknown; provenance: { provider: string } }>("patent_family", { number });
    const lines = [emitKV([["number", number], ["provider", payload.provenance.provider]])];
    if (booleanFlag(parsed, "full")) lines.push(emitKV([["family", JSON.stringify(payload.family).slice(0, 4000)]]));
    lines.push(emitBlock("next", [`ip-axi patents family ${number} --full`]));
    print(lines.join("\n"));
    return 0;
  },
};

const trademarksSearch: CommandModule = {
  spec: {
    name: "trademarks search",
    summary: "Find candidate marks (candidates only; hydrate with trademarks get)",
    args: [{ name: "mark", required: true, description: "mark text" }],
    flags: [
      { name: "limit", type: "string", default: "20", description: "rows to return" },
      { name: "class", type: "string", description: "Nice class 1-45" },
      { name: "status", type: "string", values: ["live", "dead"], description: "alive filter" },
      { name: "owner", type: "string", description: "owner name filter" },
      { name: "fields", type: "string", description: "extra columns, comma separated" },
      { name: "full", type: "boolean", description: "do not truncate cell text" },
    ],
    examples: [
      "ip-axi trademarks search DOCKER",
      "ip-axi trademarks search lumen --class 9 --status live",
    ],
  },
  async run(parsed) {
    const mark = parsed.positionals[0] ?? "";
    const classValue = stringFlag(parsed, "class");
    const payload = await callTool<TrademarkSearchPayload>("trademarks_search", {
      markText: mark,
      limit: numberFlag(parsed, "limit", 20),
      internationalClass: classValue ? Number(classValue) : undefined,
      status: stringFlag(parsed, "status"),
      ownerName: stringFlag(parsed, "owner"),
    });
    const full = booleanFlag(parsed, "full");
    const fields = requestedFields(stringFlag(parsed, "fields"), ["mark", "serial", "classes", "owner"], new Set([
      "mark", "serial", "classes", "owner", "status", "filing", "registration", "alive", "goods",
    ]));
    const rows = payload.hits.map((hit) => trademarkRow(hit, full));
    const lines = [emitList("candidates", rows, fields)];
    if (rows.length === 0) {
      lines.push(
        `note: 0 candidates for "${mark}" (providers ${(payload.providers ?? []).join(", ") || "none"}; class=${classValue ?? "any"})`,
      );
    }
    const first = payload.hits[0]?.serialNumber;
    lines.push(
      emitBlock("next", [
        first ? `ip-axi trademarks get ${first}` : 'ip-axi trademarks search "<broader term>"',
        'ip-axi status',
      ]),
    );
    if (payload.notes && payload.notes.length > 0) lines.push(emitBlock("help", payload.notes));
    print(lines.join("\n"));
    return 0;
  },
};

const trademarksGet: CommandModule = {
  spec: {
    name: "trademarks get",
    summary: "Authoritative TSDR case status",
    args: [{ name: "identifier", required: true, description: "serial, registration, IR, or REF number" }],
    flags: [{ name: "full", type: "boolean", description: "include goods and services" }],
    examples: ["ip-axi trademarks get 87454105", "ip-axi trademarks get 6096739 --full"],
  },
  async run(parsed) {
    const identifier = parsed.positionals[0] ?? "";
    const payload = await callTool<{
      markText?: string;
      status?: string;
      owner?: string;
      registrationNumber?: string;
      serialNumber?: string;
      filingDate?: string;
      registrationDate?: string;
      internationalClasses?: number[];
      goodsAndServices?: string;
    }>("trademark_get", { identifier });
    const pairs: Array<[string, unknown]> = [
      ["mark", payload.markText ?? ""],
      ["status", payload.status ?? ""],
      ["owner", payload.owner ?? ""],
      ["serial", payload.serialNumber ?? ""],
      ["registration", payload.registrationNumber ?? ""],
      ["filed", payload.filingDate ?? ""],
      ["registered", payload.registrationDate ?? ""],
      ["classes", (payload.internationalClasses ?? []).join(",")],
    ];
    if (booleanFlag(parsed, "full")) pairs.push(["goods", payload.goodsAndServices ?? ""]);
    const lines = [emitKV(pairs)];
    lines.push(
      emitBlock("next", [
        payload.serialNumber ? `ip-axi trademarks docs ${payload.serialNumber}` : "ip-axi trademarks get <serial>",
      ]),
    );
    print(lines.join("\n"));
    return 0;
  },
};

const trademarksDocs: CommandModule = {
  spec: {
    name: "trademarks docs",
    summary: "TSDR document list for a case",
    args: [{ name: "identifier", required: true, description: "serial or registration number" }],
    flags: [
      { name: "limit", type: "string", default: "25", description: "rows to return" },
      { name: "full", type: "boolean", description: "do not truncate descriptions" },
    ],
    examples: ["ip-axi trademarks docs 87454105"],
  },
  async run(parsed) {
    const identifier = parsed.positionals[0] ?? "";
    const payload = await callTool<{
      documents: Array<Record<string, unknown>>;
      bundlePdfUrl: string;
    }>("trademark_documents", { identifier });
    const full = booleanFlag(parsed, "full");
    const limit = numberFlag(parsed, "limit", 25);
    const rows = payload.documents.slice(0, limit).map((document) => ({
      date: String(document.date ?? ""),
      code: String(document.code ?? ""),
      description: cell(String(document.description ?? ""), 60, full),
      pages: String(document.pages ?? ""),
    }));
    const lines = [emitList("documents", rows, ["date", "code", "description", "pages"], { total: payload.documents.length })];
    if (rows.length === 0) lines.push(`note: 0 documents for ${identifier}`);
    lines.push(emitBlock("next", [`open "${payload.bundlePdfUrl}"`, `ip-axi trademarks get ${identifier}`]));
    print(lines.join("\n"));
    return 0;
  },
};

const drawingsValidate: CommandModule = {
  spec: {
    name: "drawings validate",
    summary: "Check an SVG sheet against 37 CFR 1.84",
    args: [{ name: "path", required: true, description: "path to an SVG file" }],
    flags: [
      { name: "description", type: "string", description: "description text or @file for reference-character coverage" },
      { name: "expected", type: "string", description: "comma-separated figure labels, e.g. \"FIG. 1,FIG. 2\"" },
      { name: "full", type: "boolean", description: "show every finding and the unverifiable list" },
    ],
    examples: [
      "ip-axi drawings validate ip/drawings/fig-1.svg",
      "ip-axi drawings validate fig-1.svg --description @ip/specification.md --expected \"FIG. 1\"",
    ],
  },
  async run(parsed) {
    const path = parsed.positionals[0] ?? "";
    const descriptionText = await readMaybeFile(stringFlag(parsed, "description"));
    const expected = stringFlag(parsed, "expected")
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const payload = await callTool<{
      ok: boolean;
      findings: Array<{ severity: string; ruleId: string; citation: string; message: string }>;
      measurements: Record<string, unknown>;
      unverifiable: string[];
    }>("drawing_validate", { path, descriptionText, expectedFigures: expected });
    const errors = payload.findings.filter((finding) => finding.severity === "error");
    const warnings = payload.findings.filter((finding) => finding.severity === "warning");
    const shown = booleanFlag(parsed, "full") ? payload.findings : payload.findings.slice(0, 8);
    const lines = [
      emitKV([
        ["sheet", path],
        ["ok", payload.ok],
        ["errors", errors.length],
        ["warnings", warnings.length],
        ["minTextMm", String((payload.measurements as Record<string, unknown>).minFontSizeMm ?? "")],
        ["refs", ((payload.measurements as Record<string, unknown>).referenceCharacters as number[] | undefined)?.join(",") ?? ""],
      ]),
    ];
    if (shown.length > 0) {
      lines.push(
        emitList(
          "findings",
          shown.map((finding) => ({
            severity: finding.severity,
            rule: finding.ruleId,
            citation: finding.citation,
            message: cell(finding.message, 100, booleanFlag(parsed, "full")),
          })),
          ["severity", "rule", "citation", "message"],
          { total: payload.findings.length },
        ),
      );
    }
    if (payload.findings.length > shown.length) {
      lines.push(`note: ${payload.findings.length - shown.length} more findings; add --full`);
    }
    if (booleanFlag(parsed, "full") && payload.unverifiable.length > 0) {
      lines.push(emitBlock("unverifiable", payload.unverifiable));
    }
    lines.push(emitBlock("next", [`ip-axi drawings validate ${path} --full`]));
    print(lines.join("\n"));
    return 0;
  },
};

const indexBuild: CommandModule = {
  spec: {
    name: "index build",
    summary: "Build the local FTS5 index from USPTO bulk XML",
    flags: [
      { name: "from", type: "string", description: "directory of XML files (required)" },
      { name: "db", type: "string", description: "database path override" },
    ],
    examples: ["ip-axi index build --from D:/uspto/patents", "ip-axi index status"],
  },
  async run(parsed) {
    const sourceDir = stringFlag(parsed, "from");
    if (!sourceDir) throw new AxiError("missing --from <dir>", "ip-axi index build --from <dir-of-bulk-xml>");
    const payload = await callTool<{
      scanned: number;
      patents: number;
      trademarks: number;
      skipped: number;
      errors: string[];
      status: { dbPath: string; patents: number; trademarks: number };
    }>("index_build", { sourceDir, dbPath: stringFlag(parsed, "db") });
    print(
      [
        emitKV([
          ["db", payload.status.dbPath],
          ["scanned", payload.scanned],
          ["patents", payload.patents],
          ["trademarks", payload.trademarks],
          ["skipped", payload.skipped],
          ["totalPatents", payload.status.patents],
          ["totalTrademarks", payload.status.trademarks],
        ]),
        payload.errors.length > 0 ? emitBlock("errors", payload.errors.slice(0, 5)) : "",
        emitBlock("next", ['ip-axi patents search "optical sensor" --provider index', "ip-axi index status"]),
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return 0;
  },
};

const indexStatus: CommandModule = {
  spec: {
    name: "index status",
    summary: "Local index counts and build time",
    flags: [],
    examples: ["ip-axi index status"],
  },
  async run() {
    const payload = await callTool<{ dbPath: string; exists: boolean; patents: number; trademarks: number; builtAt?: string }>(
      "index_build",
      {},
    );
    print(
      [
        emitKV([
          ["db", payload.dbPath],
          ["exists", payload.exists],
          ["patents", payload.patents],
          ["trademarks", payload.trademarks],
          ["builtAt", payload.builtAt ?? ""],
        ]),
        emitBlock("next", ["ip-axi index build --from <dir-of-bulk-xml>"]),
      ].join("\n"),
    );
    return 0;
  },
};

const status: CommandModule = {
  spec: {
    name: "status",
    summary: "Provider configuration and index state",
    flags: [],
    examples: ["ip-axi status"],
  },
  async run() {
    const payload = await callTool<{
      allowUnofficial: boolean;
      providers: Array<{ provider: string; configured: boolean; required: string[] }>;
      localIndex: { exists: boolean; patents: number; trademarks: number; builtAt?: string };
    }>("credential_status", {});
    const lines = [
      emitList("providers", payload.providers.map((provider) => ({
        provider: provider.provider,
        configured: provider.configured,
        needs: provider.required.join(","),
      })), ["provider", "configured", "needs"]),
      emitKV([
        ["unofficial", payload.allowUnofficial],
        ["index", payload.localIndex.exists ? `${payload.localIndex.patents} patents, ${payload.localIndex.trademarks} trademarks` : "not built"],
      ]),
      emitBlock("next", ["ip-axi patents search \"optical sensor\"", "ip-axi index build --from <dir-of-bulk-xml>"]),
    ];
    print(lines.join("\n"));
    return 0;
  },
};

export const home: CommandModule = {
  spec: {
    name: "",
    summary: "Live provider and index status",
    flags: [{ name: "version", type: "boolean", description: "print the tool version" }],
    examples: ["ip-axi", "ip-axi --version"],
  },
  async run(parsed) {
    if (parsed.flags.version === true) {
      print("ip-axi: 0.1.0 (axi/1.0-2026-07)");
      return 0;
    }
    const bin = process.argv[1] ?? "ip-axi";
    const payload = await callTool<{
      providers: Array<{ provider: string; configured: boolean }>;
      localIndex: { exists: boolean; patents: number; trademarks: number; builtAt?: string };
    }>("credential_status", {});
    print(
      [
        emitKV([
          ["bin", bin],
          ["tool", "ip-axi 0.1.0"],
          ["desc", "patent and trademark research, drawing validation, local bulk index"],
        ]),
        emitList("providers", payload.providers.map((provider) => ({
          provider: provider.provider,
          configured: provider.configured,
        })), ["provider", "configured"]),
        emitKV([
          ["index", payload.localIndex.exists ? `${payload.localIndex.patents} patents, ${payload.localIndex.trademarks} trademarks` : "not built"],
        ]),
        emitBlock("next", [
          'ip-axi patents search "optical sensor calibration"',
          "ip-axi trademarks get 87454105",
          "ip-axi drawings validate <path.svg> --description @<spec.md>",
        ]),
        emitBlock("help", [
          "ip-axi --help",
          "ip-axi <command> --help",
        ]),
      ].join("\n"),
    );
    return 0;
  },
};

export const commands: Record<string, CommandModule> = {
  "prior-art search": priorArtSearch,
  vet: vetCommand,
  "fto chart": ftoChart,
  "disclosure scan": disclosureScanCommand,
  "patents read": patentsRead,
  "patents search": patentsSearch,
  "patents get": patentsGet,
  "patents docs": patentsDocs,
  "patents family": patentsFamily,
  "trademarks search": trademarksSearch,
  "trademarks get": trademarksGet,
  "trademarks docs": trademarksDocs,
  "drawings validate": drawingsValidate,
  "index build": indexBuild,
  "index status": indexStatus,
  status,
};

export const aliases: Record<string, string> = {
  patents: "patents search",
  trademarks: "trademarks search",
  drawings: "drawings validate",
  index: "index status",
  "prior-art": "prior-art search",
};

export const specs: CommandSpec[] = [status, vetCommand, priorArtSearch, ftoChart, disclosureScanCommand, patentsSearch, patentsRead, patentsGet, patentsDocs, patentsFamily, trademarksSearch, trademarksGet, trademarksDocs, drawingsValidate, indexBuild, indexStatus].map(
  (command) => command.spec,
);

export { toonValue };
