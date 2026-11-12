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
 * than eight words join the previous feature; ones before the first feature
 * (a title line) join the first.
 * Perf: P0 · O(lines) · CRAP <= 15 (CC 9).
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
  let lead = "";
  for (const chunk of chunks.map((entry) => entry.trim()).filter(Boolean)) {
    const heading = /^\s{0,3}#{1,6}\s+(.+)$/m.exec(chunk.split("\n")[0] ?? "")?.[1];
    const body = chunk.replace(marker, "").trim();
    const words = body.split(/\s+/).length;
    if (words < 8) {
      if (features.length > 0) features[features.length - 1]!.description += `\n${body}`;
      else lead = lead ? `${lead}\n${body}` : body;
      continue;
    }
    const name = (heading ?? body.split(/[.:\n]/)[0] ?? body).split(/\s+/).slice(0, 8).join(" ");
    const description = heading ? body.slice(heading.length).trim() || body : body;
    features.push({ name, description: lead ? `${lead}\n${description}` : description });
    lead = "";
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
  /** Earliest dated archive match of the feature's signatures: the latest date the feature can have become public. */
  disclosedOn?: string;
  /** Date the signatures were seen on a live page when no archive capture shows them: public now, first date unknown. */
  seenLiveOn?: string;
  /** US grace status for the archive-dated disclosure. */
  usGrace?: "open" | "closed";
  usDeadline?: string;
  /** Whether the feature can be seen or inferred from outside the product. Unknown by default. */
  detectable?: boolean;
  /** What the evidence leaves out: failed or skipped searches, unreadable patents, an unchecked or partly failed disclosure scan. */
  gaps?: string[];
}

export interface Verdict {
  recommendation: Recommendation;
  reasons: string[];
  cautions: string[];
}

/**
 * One recommendation per feature, with the reasons that drove it. An archive
 * date is the latest the feature can have become public, so a grace period
 * still open on it may already have started; a live-only match has no date
 * and gets no deadline. Perf: P0 · O(1) · CRAP <= 20 (CC 12).
 */
export function decide(input: VerdictInput): Verdict {
  const reasons: string[] = [];
  const cautions: string[] = [];
  const gaps = input.gaps ?? [];
  const crowded = input.closestCoverage >= 0.75;
  if (gaps.length > 0) {
    cautions.push(`Evidence is partial: ${gaps.join("; ")}. Treat the recommendation as provisional until these are resolved.`);
  }
  if (input.ftoFlags.length > 0) {
    cautions.push(`In-force patents with an independent claim whose every element appears in the feature: ${input.ftoFlags.join(", ")}. Have counsel review them before shipping.`);
  }
  if (input.disclosedOn) {
    cautions.push(`Public no later than ${input.disclosedOn}: absolute-novelty jurisdictions (EP, GB, DE, FR, CN) are likely already lost.`);
  } else if (input.seenLiveOn) {
    cautions.push(`Seen live on ${input.seenLiveOn}, first public date unknown: absolute-novelty jurisdictions (EP, GB, DE, FR, CN) may already be lost.`);
  }
  const nothingFound = gaps.length === 0 ? "No public disclosure found and no close prior art in the searched sources" : "Nothing found in the sources that could be checked, which is not a clearance";
  let recommendation: Recommendation;
  if (input.disclosedOn && input.usGrace === "closed") {
    recommendation = "publish-defensively";
    reasons.push(`Public no later than ${input.disclosedOn}, more than a year ago: the US grace period has ended, so a patent is likely barred. A clear dated publication keeps others from patenting it.`);
  } else if (crowded) {
    recommendation = "publish-defensively";
    reasons.push(`Close prior art covers about ${Math.round(input.closestCoverage * 100)}% of the feature's key terms; any claims would be narrow.`);
  } else if (input.disclosedOn) {
    recommendation = "file";
    reasons.push(`Public no later than ${input.disclosedOn}; the US grace period ends on or before ${input.usDeadline ?? "one year after that date"} and may already be running from an earlier date. File as soon as possible.`);
  } else if (input.seenLiveOn) {
    recommendation = "file";
    reasons.push(`Seen live on ${input.seenLiveOn}, but no archive capture shows it, so when it first became public is unknown and the US grace period may already have run. Establish the first public date: if it is more than a year back, a US patent is likely barred and publishing defensively is the alternative; if not, file now.`);
  } else if (input.detectable === false) {
    recommendation = "keep-secret";
    reasons.push(`${nothingFound}, and the feature cannot be seen from outside: a trade secret keeps it without disclosing it.`);
  } else {
    recommendation = "file";
    reasons.push(`${nothingFound}.`);
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
