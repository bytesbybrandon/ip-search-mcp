import { readFileSync } from "node:fs";
import { config } from "../src/config.js";

// A stand-in for the USPTO Open Data Portal, for tests that must not touch the
// network: 30 made-up optical-sensor patents for any title query, patents and
// applications by number, an Office Action citation endpoint, a continuity
// endpoint, and the real-shaped grant full text for every dataset file.
const FULL_TEXT = readFileSync(new URL("../../test/fixtures-fulltext/grant-fulltext.xml", import.meta.url), "utf8");
const BASE = "https://api.uspto.gov";

export function grant(number: number, title: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    applicationNumberText: String(15_000_000 + number),
    applicationMetaData: { patentNumber: String(number), inventionTitle: title, filingDate: "2018-05-14", grantDate: "2020-01-07", applicationStatusDescriptionText: "Patented Case" },
    grantDocumentMetaData: { fileLocationURI: `${BASE}/api/v1/datasets/products/files/grants/${number}.xml` },
    ...extra,
  };
}

export function application(applicationNumber: string, title: string): Record<string, unknown> {
  return {
    applicationNumberText: applicationNumber,
    applicationMetaData: { inventionTitle: title, filingDate: "2024-02-01", applicationStatusDescriptionText: "Docketed New Case - Ready for Examination" },
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export interface OdpStubOptions {
  /** Application numbers the Office Action citation endpoint reports as citing the queried patent. */
  citing?: string[];
  /** HTTP status of the Office Action citation endpoint. */
  citationStatus?: number;
  /** HTTP status of the continuity endpoint. */
  continuityStatus?: number;
  /** Filing date of a parent non-provisional the continuity endpoint reports. */
  parentDate?: string;
  /** Extra fields for the patents the number lookup returns. */
  grantExtra?: Record<string, unknown>;
}

export interface OdpStubStats {
  fullTextReads: number;
}

// Responses are cached on disk for the life of the test process, so a test that must reach the
// stub uses its own patent-number range and its own query strings; a repeat is served from cache.
export async function withOdp<T>(firstNumber: number, run: (stats: OdpStubStats) => Promise<T>, options: OdpStubOptions = {}): Promise<T> {
  const realFetch = globalThis.fetch;
  const stats = { fullTextReads: 0 };
  Object.assign(config.providers.odp, { key: "example-key" });
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname.startsWith("/api/v1/datasets/")) {
      stats.fullTextReads += 1;
      return new Response(FULL_TEXT, { status: 200, headers: { "content-type": "application/xml" } });
    }
    if (url.pathname.includes("/oa/")) {
      return (options.citationStatus ?? 200) === 200
        ? json({ response: { docs: (options.citing ?? []).map((patentApplicationNumber) => ({ patentApplicationNumber })) } })
        : json({}, options.citationStatus);
    }
    if (url.pathname.endsWith("/continuity")) {
      const parent = options.parentDate ? [{ claimParentageTypeCode: "CON", parentApplicationFilingDate: options.parentDate }] : [];
      return (options.continuityStatus ?? 200) === 200 ? json({ patentFileWrapperDataBag: [{ parentContinuityBag: parent }] }) : json({}, options.continuityStatus);
    }
    const q = (JSON.parse(String(init?.body ?? "{}")) as { q?: string }).q ?? "";
    const numbers = q.match(/\d{6,8}/g) ?? [];
    if (q.startsWith("applicationMetaData.patentNumber:")) {
      return json({ count: numbers.length, patentFileWrapperDataBag: numbers.map((number) => grant(Number(number), number === "7000001" ? "Optical sensor reference cited earlier" : `Granted example ${number}`, options.grantExtra)) });
    }
    if (q.startsWith("applicationNumberText:")) {
      return json({ count: numbers.length, patentFileWrapperDataBag: numbers.map((number) => application(number, "Optical sensor drift follow-on application")) });
    }
    return json({ count: 30, patentFileWrapperDataBag: Array.from({ length: 30 }, (_, index) => grant(firstNumber + index, `Optical sensor assembly ${index + 1}`)) });
  };
  try {
    return await run(stats);
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(config.providers.odp, { key: undefined });
  }
}
