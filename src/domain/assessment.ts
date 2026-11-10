import type { PatentHit, TrademarkHit } from "../types.js";

export const ASSESSMENT_DISCLAIMER =
  "Not legal advice and not an opinion on patentability, registrability, or infringement. It is a structured screen that tells counsel what to look at first.";

export interface ConceptInput {
  concept: string;
  productName?: string;
  jurisdictions?: string[];
  patentHits?: PatentHit[];
  trademarkHits?: TrademarkHit[];
}

export interface ScreenFinding {
  id: string;
  citation: string;
  severity: "high" | "medium" | "low" | "info";
  message: string;
  question: string;
}

export interface ClassificationGuess {
  scheme: "CPC" | "Nice";
  code: string;
  label: string;
  basis: string;
  confidence: "low" | "medium";
}

export interface Assessment {
  disclaimer: string;
  subjectMatter: ScreenFinding[];
  classifications: ClassificationGuess[];
  closestPatents: Array<{ hit: PatentHit; overlap: number; sharedTerms: string[] }>;
  trademark: {
    markText?: string;
    distinctiveness: { band: string; basis: string; nextQuestion: string };
    dupontFactors: string[];
    candidates: TrademarkHit[];
    classConflicts: string[];
  };
  missingEvidence: string[];
  nextActions: string[];
}

const CPC_HINTS: Array<{ code: string; label: string; terms: string[] }> = [
  { code: "G06N", label: "computing arrangements based on specific computational models (AI/ML)", terms: ["neural", "model", "machine learning", "ai", "inference", "training", "embedding", "llm", "agent"] },
  { code: "G06F", label: "electric digital data processing", terms: ["software", "application", "database", "interface", "browser", "compiler", "memory", "processor", "file"] },
  { code: "G06Q", label: "data processing for administrative, commercial, financial purposes", terms: ["payment", "marketplace", "subscription", "invoice", "booking", "commerce", "business", "workflow", "inventory"] },
  { code: "H04L", label: "transmission of digital information", terms: ["network", "protocol", "packet", "api", "encryption", "authentication", "distributed", "cloud", "message"] },
  { code: "H04W", label: "wireless communication networks", terms: ["wireless", "cellular", "5g", "wifi", "bluetooth", "radio", "mobile"] },
  { code: "A61B", label: "diagnosis, surgery, identification (medical)", terms: ["diagnostic", "patient", "sensor", "surgical", "monitor", "clinical", "medical"] },
  { code: "A61K", label: "preparations for medical, dental, or toilet purposes", terms: ["formulation", "dose", "compound", "pharmaceutical", "treatment", "therapy"] },
  { code: "C12N", label: "microorganisms or enzymes; mutation or genetic engineering", terms: ["enzyme", "gene", "vector", "cell", "crispr", "protein", "microorganism"] },
  { code: "H01M", label: "processes or means for direct conversion of chemical into electrical energy", terms: ["battery", "electrolyte", "anode", "cathode", "fuel cell"] },
  { code: "F16H", label: "gearing or transmission mechanisms", terms: ["gear", "transmission", "bearing", "clutch", "actuator", "linkage"] },
  { code: "B32B", label: "layered products", terms: ["laminate", "coating", "layer", "film", "composite"] },
  { code: "A63F", label: "card, board, or roulette games; video games", terms: ["game", "player", "level", "score", "avatar", "quest"] },
  { code: "G02B", label: "optical elements, systems, or apparatus", terms: ["lens", "optical", "waveguide", "laser", "hologram"] },
  { code: "G01N", label: "investigating or analysing materials", terms: ["assay", "sample", "detector", "spectrometer", "measurement"] },
  { code: "G01B", label: "measuring length, thickness, or position; angular measurement", terms: ["metrology", "calibration", "calibrating", "displacement", "position", "gauge", "drift"] },
];

const NICE_HINTS: Array<{ code: string; label: string; terms: string[] }> = [
  { code: "9", label: "software, electronics, recorded media", terms: ["software", "app", "platform", "saas", "electronic", "downloadable", "device"] },
  { code: "42", label: "computer, scientific, and technology services", terms: ["saas", "cloud", "hosting", "development", "technical support", "consulting"] },
  { code: "35", label: "advertising, business management", terms: ["marketing", "advertising", "business", "management", "recruitment", "retail"] },
  { code: "36", label: "insurance, financial, monetary affairs", terms: ["finance", "payment", "investment", "insurance", "lending", "banking"] },
  { code: "41", label: "education, entertainment, sports", terms: ["course", "training", "education", "entertainment", "podcast", "video", "fitness"] },
  { code: "44", label: "medical, hygiene, beauty care services", terms: ["clinic", "therapy", "medical", "dental", "wellness", "spa"] },
  { code: "25", label: "clothing, footwear, headgear", terms: ["apparel", "clothing", "shirt", "shoe", "hat", "wear"] },
  { code: "28", label: "games, toys, sporting articles", terms: ["toy", "game", "sport", "puzzle", "play"] },
  { code: "5", label: "pharmaceuticals and preparations", terms: ["drug", "medicine", "supplement", "pharmaceutical"] },
  { code: "30", label: "staple foods", terms: ["food", "snack", "coffee", "tea", "bakery", "cereal"] },
  { code: "32", label: "beers and non-alcoholic beverages", terms: ["beverage", "drink", "juice", "water", "beer"] },
  { code: "43", label: "food and drink services, accommodation", terms: ["restaurant", "cafe", "hotel", "catering", "lodging"] },
  { code: "45", label: "personal and legal services", terms: ["legal", "security", "personal", "concierge", "dating"] },
];

const DESCRIPTIVE_MARKERS = ["best", "premium", "quick", "easy", "fast", "pro", "plus", "ultra", "prime", "smart", "total", "complete", "direct", "express", "value", "budget"];

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3);
}

function overlapScore(concept: string, hit: PatentHit): { overlap: number; sharedTerms: string[] } {
  const conceptTerms = new Set(tokenize(concept));
  const hitText = [hit.title, hit.abstract, ...(hit.cpc ?? []), ...(hit.assignees ?? [])]
    .filter(Boolean)
    .join(" ");
  const hitTerms = new Set(tokenize(hitText));
  const shared = [...conceptTerms].filter((term) => hitTerms.has(term));
  return { overlap: shared.length, sharedTerms: shared.slice(0, 8) };
}

function subjectMatterScreen(concept: string): ScreenFinding[] {
  const lower = concept.toLowerCase();
  const findings: ScreenFinding[] = [];
  const softwareish = /\b(software|app|platform|algorithm|model|data|compute|cloud|ai|machine learning|process|workflow)\b/.test(lower);
  const mental = /\b(mental|human|judgment|decision|organiz|compar|rank|classif|collect|select|arrange)\b/.test(lower);
  const math = /\b(equation|formula|math|statistic|probability|optimization|score|weight)\b/.test(lower);
  const commercial = /\b(payment|sale|marketplace|subscription|advertis|offer|price|auction|trade)\b/.test(lower);
  const technical = /\b(sensor|circuit|hardware|actuator|valve|pump|antenna|laser|polymer|alloy|battery|enzyme|cell|turbine|engine|robot)\b/.test(lower);
  const improvement = /\b(improv|reduce|latency|throughput|accuracy|efficien|bandwidth|power consumption|yield|durab)\b/.test(lower);

  if (softwareish && !technical) {
    findings.push({
      id: "101.software",
      citation: "35 U.S.C. 101; Alice Corp. v. CLS Bank, 573 U.S. 208 (2014)",
      severity: "high",
      message: "The concept reads as software without a recited hardware or technical improvement, which invites a step-two abstract-idea analysis.",
      question: "What specific technical improvement in computer functioning, or specific machine integration, is recited rather than merely a generic computer implementing the idea?",
    });
  }
  if (mental) {
    findings.push({
      id: "101.mental",
      citation: "35 U.S.C. 101; MPEP 2106.04(a)(2)",
      severity: "medium",
      message: "Steps phrased as human comparison, organization, or judgment are the core of the judicial abstract-idea categories.",
      question: "Can each step be tied to a concrete technical operation that cannot practically be performed in the mind?",
    });
  }
  if (math) {
    findings.push({
      id: "101.math",
      citation: "35 U.S.C. 101; Gottschalk v. Benson, 409 U.S. 63 (1972)",
      severity: "medium",
      message: "Mathematical relationships and formulas are abstract unless integrated into a practical technical application.",
      question: "Where is the formula integrated into a process that produces a technical result beyond the numbers themselves?",
    });
  }
  if (commercial) {
    findings.push({
      id: "101.commercial",
      citation: "35 U.S.C. 101; MPEP 2106.04(a)(2)(III)",
      severity: "medium",
      message: "Commercial arrangements such as payment, pricing, and marketplace matching fall within organizing human activity.",
      question: "Which claim element is a technical mechanism rather than a business rule?",
    });
  }
  if (technical || improvement) {
    findings.push({
      id: "101.technical",
      citation: "35 U.S.C. 101; MPEP 2106.05(a)",
      severity: "info",
      message: "The description carries technical elements or measurable improvements that can support an integration argument.",
      question: "Which of these technical effects is measurable and recited in the claim, not only in the description?",
    });
  }
  findings.push({
    id: "102.search_gap",
    citation: "35 U.S.C. 102, 103",
    severity: "info",
    message: "Novelty and obviousness cannot be assessed from the concept alone; they need dated prior-art hits.",
    question: "Are there dated public disclosures, products, or filings that predate this concept?",
  });
  return findings;
}

function matchesTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

function classify(concept: string): ClassificationGuess[] {
  const lower = concept.toLowerCase();
  const guesses: ClassificationGuess[] = [];
  for (const entry of CPC_HINTS) {
    const matched = entry.terms.filter((term) => matchesTerm(lower, term));
    if (matched.length >= 1) {
      guesses.push({
        scheme: "CPC",
        code: entry.code,
        label: entry.label,
        basis: matched.join(", "),
        confidence: matched.length >= 2 ? "medium" : "low",
      });
    }
  }
  for (const entry of NICE_HINTS) {
    const matched = entry.terms.filter((term) => matchesTerm(lower, term));
    if (matched.length >= 1) {
      guesses.push({
        scheme: "Nice",
        code: entry.code,
        label: entry.label,
        basis: matched.join(", "),
        confidence: matched.length >= 2 ? "medium" : "low",
      });
    }
  }
  return guesses
    .sort((a, b) => Number(b.confidence === "medium") - Number(a.confidence === "medium"))
    .slice(0, 10);
}

function distinctiveness(markText: string | undefined, concept: string): Assessment["trademark"]["distinctiveness"] {
  if (!markText) {
    return {
      band: "unassessed",
      basis: "No mark text supplied.",
      nextQuestion: "What exact word, phrase, or logo is proposed, and for which goods or services?",
    };
  }
  const mark = markText.toLowerCase().trim();
  const conceptWords = tokenize(concept);
  const markWords = tokenize(mark);
  if (markWords.length > 0 && markWords.every((word) => conceptWords.includes(word) || DESCRIPTIVE_MARKERS.includes(word))) {
    return {
      band: "descriptive or generic (screen only)",
      basis: "The mark is composed of words taken from the goods or service description, or from common laudatory terms.",
      nextQuestion: "Is the mark generic for these goods (never registrable on the Principal Register) or merely descriptive (registrable only with acquired distinctiveness under 15 U.S.C. 1052(f))?",
    };
  }
  if (markWords.some((word) => DESCRIPTIVE_MARKERS.some((marker) => word.includes(marker)))) {
    return {
      band: "possibly descriptive",
      basis: "A laudatory or descriptive modifier appears in the mark.",
      nextQuestion: "Does the mark immediately describe an ingredient, quality, or feature of the goods to a purchaser?",
    };
  }
  return {
    band: "needs human classification on the Abercrombie spectrum",
    basis: "The text alone does not show obvious generic or descriptive content.",
    nextQuestion: "Place the mark as generic, descriptive, suggestive, arbitrary, or fanciful (Abercrombie & Fitch Co. v. Hunting World, 537 F.2d 4 (2d Cir. 1976)). Suggestive and stronger marks are the registrable bands.",
  };
}

function trademarkScreen(markText: string | undefined, concept: string, hits: TrademarkHit[]): Assessment["trademark"] {
  const guess = distinctiveness(markText, concept);
  const classes = new Map<string, TrademarkHit[]>();
  for (const hit of hits) {
    for (const niceClass of hit.internationalClasses ?? []) {
      const key = String(niceClass);
      const bucket = classes.get(key);
      if (bucket) bucket.push(hit);
      else classes.set(key, [hit]);
    }
  }
  const classConflicts = [...classes.entries()]
    .filter(([, bucket]) => bucket.length > 0)
    .map(([niceClass, bucket]) => `class ${niceClass}: ${bucket.length} candidate(s), e.g. ${bucket[0]?.markText ?? ""} (${bucket[0]?.serialNumber ?? "no serial"})`);

  return {
    markText,
    distinctiveness: guess,
    dupontFactors: [
      "Similarity of the marks in appearance, sound, connotation, and commercial impression (DuPont factor 1).",
      "Similarity of the goods or services and their trade channels (factors 2 and 3).",
      "Sophistication of purchasers and conditions of sale (factor 4).",
      "Fame of the prior mark, if any (factor 5).",
      "Number and nature of similar marks in use on similar goods (factor 6).",
      "Any actual confusion evidence (factor 7).",
      "Whether the mark is arbitrary, suggestive, or descriptive in the relevant class (factor 11).",
    ],
    candidates: hits.slice(0, 20),
    classConflicts,
  };
}

export function assessConcept(input: ConceptInput): Assessment {
  const patentHits = input.patentHits ?? [];
  const closest = patentHits
    .map((hit) => ({ hit, ...overlapScore(input.concept, hit) }))
    .sort((a, b) => b.overlap - a.overlap)
    .filter((entry) => entry.overlap > 0)
    .slice(0, 5);

  const missingEvidence: string[] = [];
  if (patentHits.length === 0) missingEvidence.push("No patent or application hits were supplied; novelty is unassessed.");
  if (!input.productName) missingEvidence.push("No product name supplied; trademark screening is limited to the concept text.");
  if ((input.trademarkHits ?? []).length === 0) missingEvidence.push("No trademark candidates were supplied; clearance is unassessed.");
  missingEvidence.push("Ownership, inventorship, and any prior sale or public use are not inferable from a description.");

  const classification = classify(input.concept);
  const cpc = classification.filter((entry) => entry.scheme === "CPC");
  const nice = classification.filter((entry) => entry.scheme === "Nice");

  const nextActions: string[] = [
    "Run a patent search over the closest CPC codes and the concept's distinguishing terms.",
    cpc.length > 0
      ? `Start CPC scanning at ${cpc.map((entry) => entry.code).join(", ")}.`
      : "Propose at least one CPC code before searching, or search by keyword only and accept lower recall.",
    nice.length > 0
      ? `Screen trademarks in Nice class ${nice.map((entry) => entry.code).join(", ")}.`
      : "Identify the goods or services and their Nice classes before a trademark screen.",
    "Record every search as provider, route, query, and retrieval time so counsel can reproduce it.",
    "Have a licensed practitioner review the screen before any filing decision.",
  ];

  return {
    disclaimer: ASSESSMENT_DISCLAIMER,
    subjectMatter: subjectMatterScreen(input.concept),
    classifications: classification,
    closestPatents: closest,
    trademark: trademarkScreen(input.productName, input.concept, input.trademarkHits ?? []),
    missingEvidence,
    nextActions,
  };
}
