import type { Finding, ValidationReport } from "./drawings/validate.js";
import type { FigureSpec } from "./drawings/render.js";
import type { ClaimFinding } from "./claims.js";

export const DRAFT_BANNER = [
  "> **DRAFT - NOT FOR FILING**",
  ">",
  "> Prepared for review by a licensed patent practitioner. This document is not legal advice, is not an opinion of patentability, and must not be signed or filed as-is. Every placeholder marked ATTORNEY INPUT REQUIRED must be resolved before any filing.",
].join("\n");

export interface SpecificationInput {
  title: string;
  inventors?: string[];
  applicant?: string;
  docket?: string;
  relatedApplications?: string[];
  federallySponsored?: string;
  technicalField?: string;
  background?: string;
  summary?: string;
  detailedDescription?: string;
  claims?: string;
  abstract?: string;
  figures?: FigureSpec[];
  referenceCharacters?: Array<{ number: number; description?: string }>;
}

export interface SpecificationDraft {
  markdown: string;
  gaps: string[];
  figures: Array<{ label: string; referenceCharacters: number[] }>;
}

function referenceNumbers(figures: FigureSpec[] = []): number[] {
  const numbers = new Set<number>();
  for (const figure of figures) {
    for (const element of figure.elements) {
      if (element.type === "reference") numbers.add(element.number);
    }
  }
  return [...numbers].sort((a, b) => a - b);
}

function section(title: string, body: string | undefined, gapLabel: string, gaps: string[]): string {
  if (!body || body.trim() === "") {
    gaps.push(gapLabel);
    return `## ${title}\n\n[ATTORNEY INPUT REQUIRED: ${gapLabel}]\n`;
  }
  return `## ${title}\n\n${body.trim()}\n`;
}

/**
 * Assemble a specification skeleton in the order examiners expect: title,
 * cross-reference, federal sponsorship, field, background, summary, drawings,
 * detailed description, claims, abstract. Missing sections are surfaced as gaps
 * instead of being invented.
 */
export function draftSpecification(input: SpecificationInput): SpecificationDraft {
  const gaps: string[] = [];
  const figures = (input.figures ?? []).map((figure, index) => ({
    label: figure.label ?? `FIG. ${index + 1}`,
    referenceCharacters: figure.elements
      .filter((element): element is Extract<typeof element, { type: "reference" }> => element.type === "reference")
      .map((element) => element.number),
  }));

  const drawingDescriptions = figures
    .map((figure) => `${figure.label} illustrates ${figure.referenceCharacters.length > 0 ? `elements ${figure.referenceCharacters.join(", ")}` : "the disclosed subject matter"}.`)
    .join("\n");

  const crossReference =
    input.relatedApplications && input.relatedApplications.length > 0
      ? input.relatedApplications.map((entry) => `${entry}`).join("\n\n")
      : undefined;

  const referenceList = referenceNumbers(input.figures ?? []);
  const referenceBlock =
    referenceList.length > 0
      ? `Reference characters used in the drawings: ${referenceList.join(", ")}. Each character designates the same element in every view.
`
      : undefined;

  const parts: string[] = [];
  parts.push(DRAFT_BANNER);
  parts.push("");
  parts.push(`# ${input.title.trim() || "TITLE REQUIRED"}`);
  if (!input.title.trim()) gaps.push("Title (37 CFR 1.72(a))");
  parts.push("");
  parts.push(
    `Inventor(s): ${input.inventors?.join(", ") || "[ATTORNEY INPUT REQUIRED: inventorship]"}  `,
  );
  parts.push(`Applicant: ${input.applicant || "[ATTORNEY INPUT REQUIRED: applicant and ownership]"}  `);
  parts.push(`Docket: ${input.docket || "[ATTORNEY INPUT REQUIRED: docket]"}  `);
  parts.push("");
  if (!input.inventors?.length) gaps.push("Inventorship (35 USC 115)");
  if (!input.applicant) gaps.push("Applicant and ownership (37 CFR 1.76 ADS)");

  parts.push(
    section("Cross-Reference to Related Applications", crossReference, "Cross-reference to related applications (37 CFR 1.78)", gaps),
  );
  parts.push(
    section(
      "Statement Regarding Federally Sponsored Research or Development",
      input.federallySponsored,
      "Federally sponsored research statement, or an explicit statement that none applies (37 CFR 1.78(c))",
      gaps,
    ),
  );
  parts.push(section("Technical Field", input.technicalField, "Technical field paragraph", gaps));
  parts.push(section("Background", input.background, "Background of the invention", gaps));
  parts.push(section("Summary", input.summary, "Summary of the invention", gaps));

  if (figures.length === 0) {
    gaps.push("Brief description of the several views of the drawing (37 CFR 1.74)");
    parts.push("## Brief Description of the Drawings\n\n[ATTORNEY INPUT REQUIRED: at least one drawing view or an explicit statement that no drawing is required]\n");
  } else {
    parts.push(`## Brief Description of the Drawings\n\n${drawingDescriptions}\n`);
  }

  parts.push(
    section(
      "Detailed Description",
      [referenceBlock, input.detailedDescription].filter(Boolean).join("\n\n"),
      "Detailed description with full support for every claim term (35 USC 112(a))",
      gaps,
    ),
  );
  parts.push(
    section("Claims", input.claims, "Claims (35 USC 112(b))", gaps),
  );
  parts.push(
    section("Abstract", input.abstract, "Abstract of 150 words or fewer on a separate sheet (37 CFR 1.72(b))", gaps),
  );

  parts.push("## Assembly Checklist");
  parts.push(
    [
      "- [ ] Title under 500 characters, no commendatory language (37 CFR 1.72(a))",
      "- [ ] Abstract 150 words or fewer (37 CFR 1.72(b))",
      "- [ ] Every claim term has written-description support (35 USC 112(a))",
      "- [ ] Every reference character in the drawings appears in the description (37 CFR 1.84(p)(5))",
      "- [ ] Application Data Sheet prepared (37 CFR 1.76)",
      "- [ ] Inventor declarations executed (35 USC 115)",
      "- [ ] Drawings validated against 37 CFR 1.84",
      "- [ ] Practitioner review completed and filing instructions confirmed",
    ].join("\n"),
  );

  return { markdown: parts.join("\n"), gaps, figures: figures.map((figure) => ({ ...figure, referenceCharacters: [...new Set(figure.referenceCharacters)] })) };
}

export interface ClaimDraftInput {
  subject: string;
  elements: string[];
  methodSteps?: string[];
  kind?: "apparatus" | "method";
}

export interface ClaimDraft {
  markdown: string;
  gaps: string[];
}

/**
 * Minimal claim scaffold: one apparatus claim built from the supplied elements,
 * one method claim from the supplied steps. No limitations are invented.
 */
export function draftClaims(input: ClaimDraftInput): ClaimDraft {
  const gaps: string[] = [];
  const elements = input.elements.map((element) => element.trim()).filter(Boolean);
  if (elements.length === 0) {
    gaps.push("At least one structural element for the independent claim");
  }
  const subject = input.subject.trim() || "apparatus";
  const lines: string[] = [];

  const body = elements.length > 0
    ? elements
        .map((element, index) =>
          index === elements.length - 1
            ? `and ${element}`
            : index === elements.length - 2
              ? `${element};`
              : `${element};`,
        )
        .join("\n    ")
    : "[ATTORNEY INPUT REQUIRED: claim elements]";

  lines.push("1. A " + subject + " comprising:");
  lines.push("    " + body + ".");
  lines.push("");

  if (input.methodSteps && input.methodSteps.length > 0) {
    const number = 2;
    lines.push(`${number}. A method of using the ${subject}, comprising:`);
    input.methodSteps.forEach((step, index) => {
      const prefix = index === 0 ? "    " : "    ";
      lines.push(`${prefix}${step}${index === input.methodSteps!.length - 1 ? "." : ";"}`);
    });
    lines.push("");
  }

  lines.push(
    "<!-- Dependent claims: add limitations that narrow the independent claim. Each dependent claim must further limit the claim it references (37 CFR 1.75(c)). -->",
  );
  gaps.push("Dependent claims with narrowing limitations");
  gaps.push("Claim differentiation review against the closest prior art");

  return { markdown: lines.join("\n"), gaps };
}

export interface PacketInput {
  concept: string;
  specification?: string;
  claims?: string;
  drawingReport?: ValidationReport;
  priorArt?: string;
  trademarkFindings?: string;
  openQuestions: string[];
}

export function buildAttorneyPacket(input: PacketInput): string {
  const lines: string[] = [];
  lines.push("# Attorney Review Packet");
  lines.push("");
  lines.push(DRAFT_BANNER);
  lines.push("");
  lines.push("## Concept");
  lines.push(input.concept.trim());
  lines.push("");
  lines.push("## Draft materials");
  lines.push(input.specification ? "Specification draft attached below." : "No specification draft yet.");
  lines.push(input.claims ? "Claims draft attached below." : "No claims draft yet.");
  lines.push(
    input.drawingReport
      ? `Drawing check: ${input.drawingReport.ok ? "no blocking errors" : `${input.drawingReport.findings.filter((f) => f.severity === "error").length} blocking errors`} against 37 CFR 1.84.`
      : "Drawings not validated.",
  );
  lines.push("");
  lines.push("## Prior art gathered");
  lines.push(input.priorArt?.trim() || "No prior-art search recorded.");
  lines.push("");
  lines.push("## Trademark screening");
  lines.push(input.trademarkFindings?.trim() || "No trademark screening recorded.");
  lines.push("");
  lines.push("## Open questions for counsel");
  for (const question of input.openQuestions) lines.push(`- ${question}`);
  lines.push("");
  lines.push("## Provenance");
  lines.push("Every search hit in this packet carries a provider, route, and retrieval timestamp. Undocumented sources are labeled and must be verified against official records.");
  return lines.join("\n");
}

export type { Finding, ClaimFinding };
