import { IpError } from "./errors.js";

export type NumberKind = "grant" | "application" | "publication" | "pct";

export interface ParsedPatentNumber {
  kind: NumberKind | "ambiguous";
  /** Digits only, as the USPTO stores them for search. */
  digits: string;
  /** Human display form, e.g. 9,765,584. */
  display: string;
  raw: string;
  /** Competing readings when an eight-digit value fits both series codes and grants. */
  alternatives: Array<{ kind: NumberKind; display: string }>;
}

const PCT_RE = /^PCT\/([A-Z]{2})(\d{4})\/(\d{6})$/;
const PUBLICATION_RE = /^(US\s*)?(20\d{2})\/?(\d{7})(\s*A\d?)?$/i;

/**
 * Normalize a patent identifier.
 *
 * Eight-digit values are genuinely ambiguous: application series 10 through 19
 * (10/123,456) collide with grants 10,000,000 through 11,999,999 issued from
 * 2018 onward. Separators resolve it; without them both readings are returned.
 */
export function parsePatentNumber(input: string): ParsedPatentNumber {
  const raw = input.trim();
  if (raw === "") throw new IpError("INVALID_INPUT", "patent number is empty");

  const upper = raw.toUpperCase().replace(/\s+/g, "");
  const pct = upper.match(PCT_RE);
  if (pct) {
    const [, country = "", year = "", serial = ""] = pct;
    return {
      kind: "pct",
      digits: `${country}${year}${serial}`,
      display: `PCT/${country}${year}/${serial}`,
      raw,
      alternatives: [],
    };
  }

  const publication = upper.match(PUBLICATION_RE);
  if (publication) {
    const year = publication[2] ?? "";
    const serial = publication[3] ?? "";
    return {
      kind: "publication",
      digits: `${year}${serial}`,
      display: `US ${year}/${serial} A1`,
      raw,
      alternatives: [],
    };
  }

  const stripped = upper.replace(/^US/, "");
  const digits = stripped.replace(/[^0-9]/g, "");
  if (digits.length < 5) {
    throw new IpError("INVALID_INPUT", `not a recognizable patent number: ${raw}`, {
      hint: "Pass a grant (9,765,584), application (15/234,567), publication (US 2020/0123456 A1), or PCT number.",
    });
  }

  const series = Number(digits.slice(0, 2));

  if (digits.length === 8 && /\/|-/.test(stripped)) {
    if (series < 1 || series > 40) {
      throw new IpError("INVALID_INPUT", `application series code out of range: ${digits.slice(0, 2)}`);
    }
    return {
      kind: "application",
      digits,
      display: formatApplication(digits),
      raw,
      alternatives: [],
    };
  }

  if (digits.length === 8 && /,/.test(stripped)) {
    return { kind: "grant", digits, display: formatGrant(digits), raw, alternatives: [] };
  }

  if (digits.length === 7) {
    return { kind: "grant", digits, display: formatGrant(digits), raw, alternatives: [] };
  }

  if (digits.length === 8) {
    const asApplication = series >= 1 && series <= 29;
    const asGrant = Number(digits) >= 10_000_000;
    if (asApplication && asGrant) {
      return {
        kind: "ambiguous",
        digits,
        display: formatGrant(digits),
        raw,
        alternatives: [
          { kind: "grant", display: formatGrant(digits) },
          { kind: "application", display: formatApplication(digits) },
        ],
      };
    }
    if (asApplication) {
      return {
        kind: "application",
        digits,
        display: formatApplication(digits),
        raw,
        alternatives: [],
      };
    }
    if (asGrant) {
      return { kind: "grant", digits, display: formatGrant(digits), raw, alternatives: [] };
    }
  }

  throw new IpError("INVALID_INPUT", `cannot classify patent number: ${raw}`, {
    hint: "Supported: 7 or 8 digit grants, 8 digit applications, 11 digit US publications, PCT numbers.",
  });
}

function formatGrant(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatApplication(digits: string): string {
  return `${digits.slice(0, 2)}/${digits.slice(2, 5)},${digits.slice(5)}`;
}

/** ODP file-wrapper endpoints take applicationNumberText with no separators. */
export function applicationNumberText(input: string): string {
  const parsed = parsePatentNumber(input);
  if (parsed.kind === "application") return parsed.digits;
  throw new IpError(
    "INVALID_INPUT",
    `${parsed.display} is ${parsed.kind === "ambiguous" ? "ambiguous" : `a ${parsed.kind}`}, not an application number`,
    { hint: "File-wrapper endpoints require the application number, e.g. 15/234,567." },
  );
}

export function normalizeSerial(input: string): string {
  const digits = input.replace(/^SN\s*/i, "").replace(/[^0-9]/g, "");
  if (digits.length !== 8) {
    throw new IpError("INVALID_INPUT", `trademark serial numbers are 8 digits: ${input}`);
  }
  return digits;
}

export function normalizeRegistration(input: string): string {
  const digits = input.replace(/^RN\s*/i, "").replace(/[^0-9]/g, "");
  if (digits.length < 5 || digits.length > 8) {
    throw new IpError("INVALID_INPUT", `registration numbers are 5 to 8 digits: ${input}`);
  }
  return digits;
}

/**
 * Query forms for a patent identifier. Ambiguous eight-digit input yields both
 * readings so a search never silently drops half the answer.
 */
export function patentQueryVariants(input: string): string[] {
  const parsed = parsePatentNumber(input);
  const variants: string[] = [parsed.digits];
  if (parsed.kind === "ambiguous") {
    for (const alternative of parsed.alternatives) variants.push(alternative.display);
  }
  if (parsed.kind === "grant") variants.push(parsed.display);
  if (parsed.kind === "publication") {
    variants.push(`${parsed.digits.slice(0, 4)}/${parsed.digits.slice(4)}`);
  }
  return [...new Set(variants)];
}
