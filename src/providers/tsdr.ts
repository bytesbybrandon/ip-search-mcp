import { XMLParser } from "fast-xml-parser";
import { config } from "../config.js";
import { IpError } from "../errors.js";
import { requestJson, requestText } from "../http.js";
import type { Provenance } from "../http.js";
import { normalizeRegistration, normalizeSerial } from "../numbers.js";
import type { TrademarkHit } from "../types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

function requireKey(): string {
  const key = config.providers.tsdr.key;
  if (!key) {
    throw new IpError("CREDENTIAL_MISSING", "TSDR key is not configured", {
      provider: "tsdr",
      hint:
        "Create a key at https://account.uspto.gov/api-manager/ and set USPTO_TSDR_API_KEY. A TSDR key and an ODP key are different credentials and are never sent to each other's hosts.",
    });
  }
  return key;
}

function headers(): Record<string, string> {
  return { [config.providers.tsdr.keyHeader ?? "USPTO-API-KEY"]: requireKey() };
}

function identifierPath(id: string): string {
  if (/^\d{8}$/.test(id)) return `sn${id}`;
  if (/^\d{5,8}$/.test(id)) return `rn${id}`;
  if (/^IR/i.test(id)) return `ir${id.replace(/^IR/i, "")}`;
  if (/^REF/i.test(id)) return `ref${id.replace(/^REF/i, "")}`;
  throw new IpError("INVALID_INPUT", `unrecognized trademark identifier: ${id}`, {
    hint: "Use an 8 digit serial number, a registration number, an IR number, or REF<reference>.",
  });
}

/** Every leaf in a parsed XML tree, keyed by lower-case tag name. */
function leafIndex(node: unknown, out: Map<string, string[]> = new Map()): Map<string, string[]> {
  if (Array.isArray(node)) {
    for (const item of node) leafIndex(item, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith("@")) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" || typeof item === "number") push(out, key, String(item));
        else leafIndex(item, out);
      }
      continue;
    }
    if (value === null || value === undefined) continue;
    if (typeof value === "object") {
      leafIndex(value, out);
      continue;
    }
    push(out, key, String(value));
  }
  return out;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const normalized = key.toLowerCase();
  const existing = map.get(normalized);
  if (existing) existing.push(value);
  else map.set(normalized, [value]);
}

function first(map: Map<string, string[]>, ...names: string[]): string | undefined {
  for (const name of names) {
    const values = map.get(name.toLowerCase());
    const value = values?.find((entry) => entry.trim() !== "");
    if (value) return value.trim();
  }
  return undefined;
}

function all(map: Map<string, string[]>, ...names: string[]): string[] {
  const values: string[] = [];
  for (const name of names) values.push(...(map.get(name.toLowerCase()) ?? []));
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export interface TsdrStatus {
  markText?: string;
  serialNumber?: string;
  registrationNumber?: string;
  owner?: string;
  filingDate?: string;
  registrationDate?: string;
  status?: string;
  statusDate?: string;
  internationalClasses: number[];
  goodsAndServices?: string;
  markImageUrl?: string;
  provenance: Provenance;
}

export async function caseStatus(identifier: string): Promise<TsdrStatus> {
  const id = identifierPath(identifier);
  const result = await requestText({
    provider: "tsdr",
    route: `/ts/cd/casestatus/${id}/info`,
    headers: headers(),
    rateLimit: { name: "tsdr:default", perMinute: 60 },
    cache: { ttlMs: 60_000 },
    sourceId: id,
  });

  const xml = result.text;
  if (!xml.includes("<")) {
    throw new IpError("UPSTREAM", "TSDR returned a non-XML case status body", {
      provider: "tsdr",
      details: xml.slice(0, 300),
    });
  }

  const index = leafIndex(parser.parse(xml));
  const classes = all(index, "internationalClassNumber", "classNumber", "niceClass")
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 1 && value <= 45);
  const status = first(
    index,
    "nationalStatusExternalDescriptionText",
    "markCurrentStatusExternalDescriptionText",
    "markCurrentStatusDescriptionText",
    "statusDescriptionText",
  );
  const markText = first(index, "markVerbalElementText", "markLiteralElementText", "wordMark");
  const serialNumber = first(index, "applicationNumberText", "applicationNumber", "serialNumber");
  const registrationNumber = first(index, "registrationNumber");
  const ownerName = first(
    index,
    "entityName",
    "organizationStandardName",
    "ownerName",
    "partyName",
    "name",
  );
  const filingDate = first(index, "applicationDate", "applicationFilingDate", "filingDate");
  const registrationDate = first(index, "registrationDate");
  const statusDate = first(index, "nationalStatusDate", "markCurrentStatusDate", "statusDate");
  const goods = first(index, "goodsServicesDescriptionText", "goodsAndServicesDescriptionText", "goodsAndServices");

  return {
    markText,
    serialNumber: serialNumber ? serialNumber.replace(/[^0-9]/g, "") : undefined,
    registrationNumber: registrationNumber ? registrationNumber.replace(/[^0-9]/g, "") : undefined,
    owner: ownerName,
    filingDate: filingDate?.slice(0, 10),
    registrationDate: registrationDate?.slice(0, 10),
    status,
    statusDate: statusDate?.slice(0, 10),
    internationalClasses: [...new Set(classes)].sort((a, b) => a - b),
    goodsAndServices: goods,
    markImageUrl: serialNumber
      ? `${config.providers.tsdr.baseUrl}/ts/cd/rawImage/${serialNumber.replace(/[^0-9]/g, "")}`
      : undefined,
    provenance: result.provenance,
  };
}

export function toTrademarkHit(status: TsdrStatus): TrademarkHit {
  const alive = status.status ? !/dead|abandon|cancel|expired/i.test(status.status) : undefined;
  return {
    kind: "trademark",
    markText: status.markText ?? "(mark text unavailable)",
    serialNumber: status.serialNumber,
    registrationNumber: status.registrationNumber,
    owner: status.owner,
    filingDate: status.filingDate,
    registrationDate: status.registrationDate,
    internationalClasses: status.internationalClasses.length > 0 ? status.internationalClasses : undefined,
    goodsAndServices: status.goodsAndServices,
    status: status.status,
    statusDate: status.statusDate,
    alive,
    markImageUrl: status.markImageUrl,
    provenance: status.provenance,
  };
}

export interface TsdrDocument {
  identifier?: string;
  code?: string;
  description?: string;
  date?: string;
  pages?: number;
  url?: string;
}

/**
 * Document metadata via the documented bundle XML. TSDR publishes a bundle PDF
 * and ZIP URL per case; per-document content URLs need an identifier that this
 * endpoint does not always return, so they are only emitted when present.
 */
export async function caseDocuments(
  identifier: string,
): Promise<{
  documents: TsdrDocument[];
  bundlePdfUrl: string;
  provenance: Provenance;
}> {
  const id = identifierPath(identifier);
  const serial = id.startsWith("sn") ? id.slice(2) : undefined;
  const result = await requestText({
    provider: "tsdr",
    route: `/ts/cd/casedocs/bundle.xml`,
    query: serial ? { sn: serial } : { rn: id.slice(2) },
    headers: headers(),
    rateLimit: { name: "tsdr:default", perMinute: 60 },
    cache: { ttlMs: 5 * 60_000 },
    sourceId: id,
  });

  const parsed = parser.parse(result.text);
  const documents: TsdrDocument[] = [];
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const code = str(record["DocumentTypeCode"]);
    const urlList = record["UrlPathList"];
    const url =
      str(record["UrlPath"]) ??
      (urlList && typeof urlList === "object"
        ? str((urlList as Record<string, unknown>)["UrlPath"])
        : undefined);
    if (code || url) {
      const pages = Number(record["TotalPageQuantity"]);
      documents.push({
        identifier: url ?? str(record["OriginalFileName"]),
        code,
        description: str(record["DocumentTypeCodeDescriptionText"]),
        date: str(record["MailRoomDate"])?.slice(0, 10),
        pages: Number.isFinite(pages) ? pages : undefined,
        url,
      });
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(parsed);

  const base = config.providers.tsdr.baseUrl;
  return {
    documents,
    bundlePdfUrl: serial
      ? `${base}/ts/cd/casedocs/bundle.pdf?sn=${serial}`
      : `${base}/ts/cd/casedocs/bundle.pdf?rn=${id.slice(2)}`,
    provenance: result.provenance,
  };
}

/** Batch status screen. TSDR exposes caseMultiStatus for a comma-separated list. */
export async function caseMultiStatus(serials: string[]): Promise<TsdrStatus[]> {
  const normalized = serials.map(normalizeSerial);
  const result = await requestJson<unknown>({
    provider: "tsdr",
    route: `/ts/cd/caseMultiStatus/${normalized.map((serial) => `sn${serial}`).join(",")}`,
    headers: headers(),
    rateLimit: { name: "tsdr:default", perMinute: 60 },
    cache: { ttlMs: 60_000 },
  }).catch(async () => {
    throw new IpError("UPSTREAM", "TSDR multi-status call failed", {
      provider: "tsdr",
      hint: "TSDR rate limit is 60 requests per minute per key. Batch at most 20 serials per call.",
    });
  });

  const statuses: TsdrStatus[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const serial = record.applicationNumber ?? record.serialNumber;
    if (typeof serial === "string") {
      statuses.push({
        markText: typeof record.markVerbalElementText === "string" ? record.markVerbalElementText : undefined,
        serialNumber: serial.replace(/[^0-9]/g, ""),
        registrationNumber:
          typeof record.registrationNumber === "string"
            ? record.registrationNumber.replace(/[^0-9]/g, "")
            : undefined,
        status:
          typeof record.markCurrentStatusExternalDescriptionText === "string"
            ? record.markCurrentStatusExternalDescriptionText
            : undefined,
        internationalClasses: [],
        provenance: result.provenance,
      });
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(result.data);
  return statuses;
}

export function registrationLookup(registration: string): string {
  return normalizeRegistration(registration);
}
