/**
 * Pure parts of vetting a feature: splitting a description into features,
 * the recommendation, the provisional-ready draft section, and fingerprints.
 */
import { createHash } from "node:crypto";
import { assessConcept } from "./assessment.js";
import { keyPhrases } from "./relevance.js";
import { DRAFT_BANNER, draftClaims } from "./spec.js";

export interface Feature {
  name: string;
  description: string;
  /** Exact strings that would show the feature is public (UI text, identifiers, bundle symbols). */
  signatures?: string[];
}

/**
 * Split a description into features: markdown headings or top-level bullets
 * when present, else blank-line paragraphs, else one feature. Pieces shorter
 * than eight words join the previous feature.
 * Perf: P0 · O(lines) · CRAP <= 15 (CC 8).
 */
export function splitFeatures(text: string): Feature[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const marker = /^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/;
  const structured = lines.filter((line) => marker.test(line)).length >= 2;
  const chunks: string[] = [];
  if (structured) {
    for (const line of lines) {
      if (marker.test(line) || chunks.length === 0) chunks.push(line);
      else chunks[chunks.length - 1] += `\n${line}`;
    }
  } else {
    chunks.push(...text.split(/\n\s*\n/));
  }
  const features: Feature[] = [];
  for (const chunk of chunks.map((entry) => entry.trim()).filter(Boolean)) {
    const heading = /^\s{0,3}#{1,6}\s+(.+)$/m.exec(chunk.split("\n")[0] ?? "")?.[1];
    const body = chunk.replace(marker, "").trim();
    const words = body.split(/\s+/).length;
    if (words < 8 && features.length > 0) {
      features[features.length - 1]!.description += `\n${body}`;
      continue;
    }
    const name = (heading ?? body.split(/[.:\n]/)[0] ?? body).split(/\s+/).slice(0, 8).join(" ");
    features.push({ name, description: heading ? body.slice(heading.length).trim() || body : body });
  }
  return features.length > 0 ? features : [{ name: text.trim().split(/\s+/).slice(0, 8).join(" "), description: text.trim() }];
}

/**
 * Signatures to look for when none are given: only phrases of two or more
 * words that the description repeats. Single words match almost any page, so
 * they are never derived; with no repeated phrase, nothing is derived and the
 * caller should ask for signatures. Perf: P0 · O(n) · CRAP <= 10 (CC 1).
 */
export function deriveSignatures(description: string): string[] {
  return keyPhrases(description, 4).filter((phrase) => phrase.includes(" "));
}

export interface Fingerprint {
  feature: string;
  signature: string;
  normalized: string;
  sha256: string;
}

/**
 * Fingerprints a pre-publication check can match against outgoing text:
 * each signature normalized (lower case, collapsed whitespace) and hashed.
 * Perf: P0 · O(signatures) · CRAP <= 10 (CC 1).
 */
export function fingerprints(feature: string, signatures: string[]): Fingerprint[] {
  return signatures.map((signature) => {
    const normalized = signature.toLowerCase().replace(/\s+/g, " ").trim();
    return { feature, signature, normalized, sha256: createHash("sha256").update(normalized).digest("hex") };
  });
}

export type Recommendation = "file" | "publish-defensively" | "keep-secret";

export interface VerdictInput {
  /** Weighted term coverage of the closest reference (0 to 1). */
  closestCoverage: number;
  /** In-force patents with an independent claim whose every element appears in the feature. */
  ftoFlags: string[];
  /** Earliest dated public match of the feature's signatures, if any. */
  disclosedOn?: string;
  /** US grace status for that disclosure. */
  usGrace?: "open" | "closed";
  usDeadline?: string;
  /** Whether the feature can be seen or inferred from outside the product. Unknown by default. */
  detectable?: boolean;
}

export interface Verdict {
  recommendation: Recommendation;
  reasons: string[];
  cautions: string[];
}

/**
 * One recommendation per feature, with the reasons that drove it.
 * Perf: P0 · O(1) · CRAP <= 15 (CC 7).
 */
export function decide(input: VerdictInput): Verdict {
  const reasons: string[] = [];
  const cautions: string[] = [];
  const crowded = input.closestCoverage >= 0.75;
  if (input.ftoFlags.length > 0) {
    cautions.push(`In-force patents with an independent claim whose every element appears in the feature: ${input.ftoFlags.join(", ")}. Have counsel review them before shipping.`);
  }
  if (input.disclosedOn) {
    cautions.push(`Public since ${input.disclosedOn}: absolute-novelty jurisdictions (EP, GB, DE, FR, CN) are likely already lost.`);
  }
  let recommendation: Recommendation;
  if (input.disclosedOn && input.usGrace === "closed") {
    recommendation = "publish-defensively";
    reasons.push(`Public since ${input.disclosedOn}, more than a year ago: the US grace period has ended, so a patent is likely barred. A clear dated publication keeps others from patenting it.`);
  } else if (crowded) {
    recommendation = "publish-defensively";
    reasons.push(`Close prior art covers about ${Math.round(input.closestCoverage * 100)}% of the feature's key terms; any claims would be narrow.`);
  } else if (input.disclosedOn) {
    recommendation = "file";
    reasons.push(`Public since ${input.disclosedOn}; the US grace period is still open${input.usDeadline ? ` until ${input.usDeadline}` : ""}. File before it closes.`);
  } else if (input.detectable === false) {
    recommendation = "keep-secret";
    reasons.push("No public disclosure found, no close prior art, and the feature cannot be seen from outside: a trade secret keeps it without disclosing it.");
  } else {
    recommendation = "file";
    reasons.push("No public disclosure found and no close prior art in the searched sources.");
  }
  if (input.detectable === undefined && recommendation === "file") {
    cautions.push("If the feature cannot be seen or inferred from outside the product, keeping it secret is an alternative to filing.");
  }
  return { recommendation, reasons, cautions };
}

export interface ProvisionalInput {
  feature: Feature;
  closestArt: Array<{ id: string; title: string; date?: string }>;
}

/**
 * A provisional-ready draft section built only from what was supplied:
 * title, field (classification guesses), background (closest art found),
 * summary, elements, and a claim scaffold. Gaps are marked for the attorney.
 * Perf: P0 · O(description) · CRAP <= 10 (CC 2).
 */
export function provisionalSection(input: ProvisionalInput): string {
  const { feature } = input;
  const sentences = feature.description.split(/(?<=[.;])\s+/).map((entry) => entry.replace(/[.;]\s*$/, "").trim()).filter((entry) => entry.split(/\s+/).length >= 4);
  const elements = sentences.slice(0, 6).map((entry) => entry.charAt(0).toLowerCase() + entry.slice(1));
  const classes = assessConcept({ concept: feature.description }).classifications.filter((entry) => entry.scheme === "CPC").map((entry) => `${entry.code} (${entry.label})`);
  const claim = draftClaims({ subject: feature.name, elements });
  return [
    DRAFT_BANNER,
    "",
    `## Title\n\n${feature.name}`,
    `## Field\n\n${classes.length > 0 ? `Classification guesses: ${classes.join("; ")}.` : "[ATTORNEY INPUT REQUIRED: field of the invention]"}`,
    `## Background\n\n${input.closestArt.length > 0 ? input.closestArt.map((art) => `- ${art.id}${art.date ? ` (${art.date})` : ""}: ${art.title}`).join("\n") : "[ATTORNEY INPUT REQUIRED: background and known approaches]"}`,
    `## Summary\n\n${feature.description}`,
    `## Elements\n\n${elements.map((entry) => `- ${entry}`).join("\n") || "[ATTORNEY INPUT REQUIRED: elements]"}`,
    "## Detailed description and drawings\n\n[ATTORNEY INPUT REQUIRED: embodiments, alternatives, and figures]",
    `## Claim scaffold\n\n${claim.markdown}`,
  ].join("\n\n");
}
