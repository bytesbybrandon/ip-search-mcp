export interface ParsedClaim {
  number: number;
  text: string;
  independent: boolean;
  dependsOn: number[];
  multipleDependency: boolean;
  referencePhrase?: string;
}

export interface ClaimFinding {
  severity: "error" | "warning" | "advisory";
  ruleId: string;
  citation: string;
  message: string;
  claim?: number;
}

const STOPWORDS = new Set([
  "a", "an", "the", "of", "and", "or", "to", "in", "on", "for", "with", "by", "at", "from", "as",
  "is", "are", "be", "being", "that", "which", "wherein", "whereby", "said", "least", "one", "two",
  "method", "system", "apparatus", "device", "comprising", "configured", "adapted", "operable",
  "step", "steps", "first", "second", "third", "thereof", "therein", "thereto", "such", "each",
  "has", "have", "includes", "include", "comprises", "comprise", "disposed", "mounted", "configured",
  "coupled", "attached", "located", "arranged", "extending", "defines", "defining", "formed", "provided", "adapted",
]);

export function parseClaims(raw: string): ParsedClaim[] {
  const text = raw.replace(/\r\n/g, "\n");
  const starts: Array<{ number: number; index: number }> = [];
  const pattern = /(?:^|\n)\s*(\d{1,3})\s*[.)]\s+/g;
  for (const match of text.matchAll(pattern)) {
    starts.push({ number: Number(match[1]), index: match.index + (match[0].startsWith("\n") ? 1 : 0) });
  }
  if (starts.length === 0) return [];

  const claims: ParsedClaim[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]!.index : text.length;
    const body = text
      .slice(start.index, end)
      .replace(/^\s*\d{1,3}\s*[.)]\s+/, "")
      .trim();
    const reference = body.slice(0, 240).match(/(?:the\s+)?claims?\s+((?:\d+|and|or|to|through|[,\s\-–])+)/i);
    const dependsOn = reference ? parseClaimNumbers(reference[0]) : [];
    claims.push({
      number: start.number,
      text: body,
      independent: dependsOn.length === 0,
      dependsOn,
      multipleDependency: dependsOn.length > 1 || /\bclaims?\s+\d+\s*(?:-|–|to|through)\s*\d+/i.test(body.slice(0, 240)),
      referencePhrase: reference?.[0],
    });
  }
  return claims;
}

function parseClaimNumbers(phrase: string): number[] {
  const numbers: number[] = [];
  const rangePattern = /(\d+)\s*(?:-|–|to|through)\s*(\d+)/gi;
  let remaining = phrase;
  for (const match of phrase.matchAll(rangePattern)) {
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (from <= to && to - from < 30) {
      for (let n = from; n <= to; n += 1) numbers.push(n);
    }
    remaining = remaining.replace(match[0], " ");
  }
  for (const match of remaining.matchAll(/\d+/g)) numbers.push(Number(match[0]));
  return [...new Set(numbers)].filter((value) => value > 0);
}

/** Content words used for antecedent-basis and spec-support checks. */
function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

function nounPhrases(text: string): string[] {
  // English noun phrases are head-final, so the last content word after
  // "the" or "said" is the term whose earlier introduction matters.
  const phrases: string[] = [];
  for (const match of text.matchAll(/\b(?:the|said)\s+((?:[a-z][a-z0-9-]*\s+)?[a-z][a-z0-9-]*)/gi)) {
    const words = (match[1] ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 1 && !STOPWORDS.has(word));
    const head = words[words.length - 1];
    if (head) phrases.push(head);
  }
  return [...new Set(phrases)];
}

function hasAntecedent(text: string, phrase: string): boolean {
  const head = phrase.split(/\s+/).pop() ?? phrase;
  const patterns = [
    new RegExp(`\\b(?:a|an)\\s+(?:[a-z0-9-]+\\s+){0,3}${escape(head)}\\b`, "i"),
    new RegExp(`\\b(?:at least one|one or more|a plurality of)\\s+(?:[a-z0-9-]+\\s+){0,3}${escape(head)}\\b`, "i"),
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface LintOptions {
  specificationText?: string;
  abstractText?: string;
  title?: string;
}

export function lintClaims(raw: string, options: LintOptions = {}): { claims: ParsedClaim[]; findings: ClaimFinding[] } {
  const claims = parseClaims(raw);
  const findings: ClaimFinding[] = [];

  if (claims.length === 0) {
    return {
      claims,
      findings: [
        {
          severity: "error",
          ruleId: "claims.present",
          citation: "35 U.S.C. 112(b); 37 CFR 1.75",
          message: "No numbered claims found. A utility application must conclude with one or more claims.",
        },
      ],
    };
  }

  claims.forEach((claim, index) => {
    if (claim.number !== index + 1) {
      findings.push({
        severity: "error",
        ruleId: "claims.numbering",
        citation: "37 CFR 1.126",
        message: `Claim numbering is not sequential: expected ${index + 1}, found ${claim.number}.`,
        claim: claim.number,
      });
    }
  });

  const byNumber = new Map(claims.map((claim) => [claim.number, claim]));

  for (const claim of claims) {
    if (!claim.independent) {
      for (const parent of claim.dependsOn) {
        const parentClaim = byNumber.get(parent);
        if (!parentClaim) {
          findings.push({
            severity: "error",
            ruleId: "claims.reference",
            citation: "37 CFR 1.75(c); MPEP 608.01(n)",
            message: `Claim ${claim.number} refers to claim ${parent}, which does not exist.`,
            claim: claim.number,
          });
          continue;
        }
        if (parent >= claim.number) {
          findings.push({
            severity: "error",
            ruleId: "claims.forward",
            citation: "MPEP 608.01(n)",
            message: `Claim ${claim.number} depends from claim ${parent}; a dependent claim must refer to a preceding claim.`,
            claim: claim.number,
          });
        }
        if (parentClaim.multipleDependency && claim.multipleDependency) {
          findings.push({
            severity: "error",
            ruleId: "claims.multiple-dependent",
            citation: "37 CFR 1.75(c)",
            message: `Claim ${claim.number} is multiple dependent and depends from multiple dependent claim ${parent}.`,
            claim: claim.number,
          });
        }
      }

      if (claim.multipleDependency && /\band\b/i.test(claim.referencePhrase ?? "")) {
        findings.push({
          severity: "warning",
          ruleId: "claims.alternative",
          citation: "37 CFR 1.75(c)",
          message: `Claim ${claim.number} names several claims with "and"; a multiple dependent claim must refer to them in the alternative ("or").`,
          claim: claim.number,
        });
      }
    }

    const antecedentScope = claim.independent ? claim.text : `${ancestorText(claim, byNumber)} ${claim.text}`;

    for (const phrase of nounPhrases(claim.text)) {
      const regex = new RegExp(`\\b(?:the|said)\\s+${escape(phrase)}\\b`, "gi");
      const firstUse = claim.text.search(regex);
      if (firstUse < 0) continue;
      const before = antecedentScope.slice(0, antecedentScope.lastIndexOf(claim.text) + firstUse);
      if (!hasAntecedent(before, phrase)) {
        findings.push({
          severity: "warning",
          ruleId: "claims.antecedent",
          citation: "35 U.S.C. 112(b); MPEP 2173.05(e)",
          message: `Claim ${claim.number} uses "${phrase}" before introducing it; add "a" or "an" antecedent.`,
          claim: claim.number,
        });
      }
    }

    if (/\b(means|step)\s+for\b/i.test(claim.text)) {
      findings.push({
        severity: "warning",
        ruleId: "claims.112f",
        citation: "35 U.S.C. 112(f); MPEP 2181",
        message: `Claim ${claim.number} uses means-plus-function language; claim scope is limited to the corresponding structure in the specification and equivalents.`,
        claim: claim.number,
      });
    }

    for (const term of ["about", "substantially", "approximately", "essentially", "generally"]) {
      if (new RegExp(`\\b${term}\\b`, "i").test(claim.text)) {
        findings.push({
          severity: "advisory",
          ruleId: "claims.relative-term",
          citation: "35 U.S.C. 112(b); MPEP 2173.05(b)",
          message: `Claim ${claim.number} uses "${term}"; relative terms invite a definiteness rejection unless the specification gives a objective boundary.`,
          claim: claim.number,
        });
      }
    }

    if (!claim.text.trim().endsWith(".")) {
      findings.push({
        severity: "advisory",
        ruleId: "claims.punctuation",
        citation: "MPEP 608.01(m)",
        message: `Claim ${claim.number} does not end with a period.`,
        claim: claim.number,
      });
    }
  }

  const independent = claims.filter((claim) => claim.independent);
  if (independent.length === 0) {
    findings.push({
      severity: "error",
      ruleId: "claims.independent",
      citation: "37 CFR 1.75",
      message: "Every claim depends from another claim; at least one independent claim is required.",
    });
  }

  if (options.specificationText) {
    const stem = (word: string): string => word.replace(/(ing|ed|es|s)$/, "").replace(/e$/, "") || word;
    const specWords = new Set(contentWords(options.specificationText).map(stem));
    for (const claim of claims) {
      const missing = contentWords(claim.text).filter((word) => !specWords.has(stem(word)));
      if (missing.length > 0) {
        findings.push({
          severity: "warning",
          ruleId: "claims.support",
          citation: "35 U.S.C. 112(a); MPEP 2163",
          message: `Claim ${claim.number} uses terms absent from the specification: ${[...new Set(missing)].slice(0, 12).join(", ")}.`,
          claim: claim.number,
        });
      }
    }
  }

  if (options.abstractText) {
    const words = options.abstractText.trim().split(/\s+/).filter(Boolean).length;
    if (words > 150) {
      findings.push({
        severity: "error",
        ruleId: "abstract.length",
        citation: "37 CFR 1.72(b)",
        message: `Abstract is ${words} words; the limit is 150 words on a separate sheet.`,
      });
    }
  }

  if (options.title) {
    const length = options.title.trim().length;
    if (length > 500) {
      findings.push({
        severity: "error",
        ruleId: "title.length",
        citation: "37 CFR 1.72(a)",
        message: `Title is ${length} characters; the limit is 500 characters.`,
      });
    }
    if (/\b(new|improved)\b/i.test(options.title)) {
      findings.push({
        severity: "advisory",
        ruleId: "title.quality",
        citation: "37 CFR 1.72(a)",
        message: "Avoid commendatory words such as new or improved in the title.",
      });
    }
  }

  return { claims, findings };
}

function ancestorText(
  claim: ParsedClaim,
  byNumber: Map<number, ParsedClaim>,
  seen: Set<number> = new Set(),
): string {
  const parts: string[] = [];
  for (const parent of claim.dependsOn) {
    const parentClaim = byNumber.get(parent);
    if (!parentClaim || seen.has(parent)) continue;
    seen.add(parent);
    parts.push(parentClaim.text);
    parts.push(ancestorText(parentClaim, byNumber, seen));
  }
  return parts.join(" ");
}

export function claimStats(claims: ParsedClaim[]): {
  total: number;
  independent: number;
  dependent: number;
  multipleDependent: number;
  maxDependencyDepth: number;
} {
  const byNumber = new Map(claims.map((claim) => [claim.number, claim]));
  const depth = (claim: ParsedClaim, seen = new Set<number>()): number => {
    if (claim.dependsOn.length === 0 || seen.has(claim.number)) return 0;
    seen.add(claim.number);
    return (
      1 +
      Math.max(
        0,
        ...claim.dependsOn.map((parent) => {
          const parentClaim = byNumber.get(parent);
          return parentClaim ? depth(parentClaim, seen) : 0;
        }),
      )
    );
  };
  return {
    total: claims.length,
    independent: claims.filter((claim) => claim.independent).length,
    dependent: claims.filter((claim) => !claim.independent).length,
    multipleDependent: claims.filter((claim) => claim.multipleDependency).length,
    maxDependencyDepth: Math.max(0, ...claims.map((claim) => depth(claim))),
  };
}
