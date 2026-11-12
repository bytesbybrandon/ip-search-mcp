/**
 * Freedom-to-operate screening: split an independent claim into elements and
 * mark each as present, absent, or unclear in a feature description. A
 * term-overlap screen for counsel, not an infringement opinion.
 */
import { keyTerms, stem, tokenize } from "./relevance.js";

export type ElementStatus = "present" | "absent" | "unclear";

export interface ElementFinding {
  element: string;
  status: ElementStatus;
  /** Share of the element's content terms found in the feature description. */
  coverage: number;
  found: string[];
  missing: string[];
}

export type ClaimFlag = "all-elements-present" | "element-absent" | "review";

export interface ClaimChart {
  claim: number;
  preamble: string;
  elements: ElementFinding[];
  flag: ClaimFlag;
}

export const FTO_DISCLAIMER =
  "Screening aid only. Elements are compared by shared terms, not by meaning; claim construction, equivalents, and validity are for a licensed practitioner.";

/**
 * Split claim text into its preamble and elements: the body after the
 * transitional phrase, split on semicolons, with each "wherein" clause as its own element.
 * Perf: P0 · O(claim length) · CRAP <= 10 (CC 4).
 */
export function claimElements(text: string): { preamble: string; elements: string[] } {
  const cleaned = text.replace(/^\s*\d+\.\s*/, "").replace(/\s+/g, " ").trim();
  const colon = cleaned.search(/\b(comprising|consisting of|including|having)\b[^:]*:/i);
  const split = colon >= 0 ? cleaned.indexOf(":", colon) : cleaned.indexOf(":");
  const preamble = split >= 0 ? cleaned.slice(0, split).trim() : "";
  const body = split >= 0 ? cleaned.slice(split + 1) : cleaned;
  const elements = body
    .split(/;\s*(?:and\s+)?/i)
    .flatMap((part) => part.split(/,?\s+wherein\s+/i).map((piece, index) => (index > 0 ? `wherein ${piece}` : piece)))
    .map((part) => part.replace(/^\s*and\s+/i, "").replace(/[.;,\s]+$/, "").trim())
    .filter((part) => part.length > 3);
  return { preamble, elements };
}

/**
 * Mark one element against the feature: present when at least 60% of its
 * content terms appear (at least two, unless the element has only one),
 * absent at 25% or less, otherwise unclear.
 * Perf: P0 · O(element terms) · CRAP <= 10 (CC 4).
 */
export function classifyElement(element: string, featureStems: Set<string>): ElementFinding {
  const terms = keyTerms(element, 40);
  const found = terms.filter((term) => featureStems.has(term.stem)).map((term) => term.term);
  const missing = terms.filter((term) => !featureStems.has(term.stem)).map((term) => term.term);
  const coverage = terms.length === 0 ? 0 : Math.round((found.length / terms.length) * 100) / 100;
  const status: ElementStatus = terms.length === 0 ? "unclear" : coverage >= 0.6 && (found.length >= 2 || terms.length === 1) ? "present" : coverage <= 0.25 ? "absent" : "unclear";
  return { element, status, coverage, found, missing };
}

/**
 * Chart every independent claim against a feature description.
 * Perf: P0 · O(claims x element terms) · CRAP <= 10 (CC 3).
 */
export function chartClaims(claims: Array<{ number: number; text: string }>, feature: string): ClaimChart[] {
  const featureStems = new Set(tokenize(feature).map(stem));
  return claims.map((claim) => {
    const { preamble, elements } = claimElements(claim.text);
    const findings = elements.map((element) => classifyElement(element, featureStems));
    const flag: ClaimFlag = findings.some((finding) => finding.status === "absent")
      ? "element-absent"
      : findings.length > 0 && findings.every((finding) => finding.status === "present")
        ? "all-elements-present"
        : "review";
    return { claim: claim.number, preamble, elements: findings, flag };
  });
}
