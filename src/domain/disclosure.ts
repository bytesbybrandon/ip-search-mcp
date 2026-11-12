export interface DisclosureFacts {
  disclosureDate?: string;
  disclosureKind?: "publication" | "public-use" | "sale" | "offer-for-sale" | "presentation" | "other";
  byInventor?: boolean;
  plannedFilingDate?: string;
  jurisdictions?: string[];
}

export interface JurisdictionBar {
  code: string;
  name: string;
  rule: string;
  citation?: string;
  graceMonths: number;
  deadline?: string;
  daysRemaining?: number;
  status: "open" | "closed" | "unknown" | "no-grace";
  note: string;
}

export interface DisclosureAssessment {
  earliestDisclosure?: string;
  usDeadline?: string;
  daysRemaining?: number;
  urgency: "none-recorded" | "routine" | "time-critical" | "barred";
  events: string[];
  jurisdictions: JurisdictionBar[];
  actions: string[];
  disclaimer: string;
}

export type GraceKind = "general" | "conditional" | "narrow" | "none";

export interface GraceRule {
  code: string;
  name: string;
  /** Months before the filing date (or priority date where stated) that an inventor's own disclosure is excused. 0 = no general grace. */
  graceMonths: number;
  kind: GraceKind;
  /** What the period is measured back from. */
  measuredFrom: "priority date" | "filing date";
  citation: string;
  conditions: string;
}

/**
 * Lay summary of national grace provisions for an inventor's own disclosure.
 * A screening aid: counsel confirms each against current text before relying on it.
 */
export const GRACE_RULES: readonly GraceRule[] = [
  {
    code: "EP", name: "European Patent Office", graceMonths: 0, kind: "none", measuredFrom: "filing date",
    citation: "EPC Art. 54(2), Art. 55(1)",
    conditions: "No grace for the applicant's own disclosure. Art. 55 excuses only an evident abuse against the applicant or display at an officially recognised international exhibition, within 6 months before filing; exhibition requires a statement at filing and a certificate within 4 months (Rule 25).",
  },
  {
    code: "GB", name: "United Kingdom", graceMonths: 0, kind: "none", measuredFrom: "filing date",
    citation: "Patents Act 1977 s. 2(4)",
    conditions: "No grace for the applicant's own disclosure. Only a disclosure made in breach of confidence or by unlawful obtaining, or display at a recognised international exhibition, within 6 months before filing.",
  },
  {
    code: "DE", name: "Germany", graceMonths: 0, kind: "none", measuredFrom: "filing date",
    citation: "Patentgesetz § 3(5); Gebrauchsmustergesetz § 3(1)",
    conditions: "Patent: abuse or recognised exhibition within 6 months only. A German utility model keeps a 6-month grace for the applicant's own disclosure.",
  },
  {
    code: "FR", name: "France", graceMonths: 0, kind: "none", measuredFrom: "filing date",
    citation: "Code de la propriété intellectuelle art. L611-13",
    conditions: "Abuse or recognised international exhibition within 6 months only.",
  },
  {
    code: "CN", name: "China", graceMonths: 6, kind: "narrow", measuredFrom: "filing date",
    citation: "Patent Law of the PRC (2020) Art. 24; Implementing Regulations Rule 33",
    conditions: "Narrow 6-month exceptions only: disclosure in the public interest during a national emergency, first exhibition at a government-sponsored or recognised international exhibition, first publication at a prescribed academic or technical meeting, or disclosure without the applicant's consent. A declaration and proof are required. Ordinary self-publication is not covered.",
  },
  {
    code: "JP", name: "Japan", graceMonths: 12, kind: "conditional", measuredFrom: "filing date",
    citation: "Patent Act Art. 30(2)-(3) (12 months since the 2018 amendment)",
    conditions: "Applies to the right holder's own disclosure. The application must state the exception at filing and proof must be filed within 30 days of filing. A disclosure in a patent gazette (an earlier patent publication) is not covered.",
  },
  {
    code: "KR", name: "Republic of Korea", graceMonths: 12, kind: "conditional", measuredFrom: "filing date",
    citation: "Patent Act Art. 30(1)-(3)",
    conditions: "Applies to the right holder's own disclosure. The exception must be claimed (at filing or within the later periods the Act allows, with a fee) and proof filed. A disclosure in a domestic or foreign patent gazette is not covered.",
  },
  {
    code: "CA", name: "Canada", graceMonths: 12, kind: "conditional", measuredFrom: "filing date",
    citation: "Patent Act s. 28.2(1)(a)",
    conditions: "Disclosure by the applicant, or by someone who obtained the information from the applicant, more than 12 months before the Canadian filing date is prior art. The year runs back from the actual Canadian filing date, not the priority date.",
  },
  {
    code: "AU", name: "Australia", graceMonths: 12, kind: "conditional", measuredFrom: "filing date",
    citation: "Patents Act 1990 s. 24(1)(a); Patents Regulations 1991 reg. 2.2(1A)",
    conditions: "Publication or use by or with the consent of the patentee or nominated person is disregarded if a complete application is filed within 12 months. Runs from the Australian complete-application filing date; no declaration is required.",
  },
  {
    code: "BR", name: "Brazil", graceMonths: 12, kind: "general", measuredFrom: "priority date",
    citation: "Industrial Property Law 9.279/1996 Art. 12",
    conditions: "Disclosure by the inventor, by INPI, or by a third party using information from the inventor within 12 months before filing or the priority date is not prior art. Evidence may be requested.",
  },
  {
    code: "IN", name: "India", graceMonths: 12, kind: "narrow", measuredFrom: "filing date",
    citation: "Patents Act 1970 s. 31",
    conditions: "Narrow 12-month exceptions only: display or use at an exhibition notified by the Government, a paper read before a learned society, or a public trial working. Ordinary self-publication is not covered.",
  },
];

const DEFAULT_FOREIGN = GRACE_RULES.map((rule) => rule.code);

const JURISDICTION_NAMES: Record<string, string> = {
  US: "United States",
  ...Object.fromEntries(GRACE_RULES.map((rule) => [rule.code, rule.name])),
};

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const iso = Date.parse(value);
  if (Number.isFinite(iso)) return new Date(iso);
  return undefined;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addMonths(date: Date, months: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCMonth(copy.getUTCMonth() + months);
  return copy;
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * Screen the 35 U.S.C. 102(b)(1) one-year grace period and the absolute-novelty
 * jurisdictions that do not offer one. Dates are computed, not legal advice.
 */
/**
 * One foreign jurisdiction's bar for a given disclosure.
 * Perf: P1 · O(rules) · CRAP <= 15 (CC 7, branch coverage >= 80%).
 */
function foreignBar(code: string, disclosure: Date, reference: Date, today: Date, byInventor: boolean | undefined): JurisdictionBar {
  const rule = GRACE_RULES.find((entry) => entry.code === code);
  if (!rule) {
    return {
      code, name: JURISDICTION_NAMES[code] ?? code, rule: "Not in the encoded table", graceMonths: 0,
      status: "unknown", note: "National law requires confirmation.",
    };
  }
  const base = { code, name: rule.name, rule: rule.conditions, citation: rule.citation };
  if (rule.kind === "none" || rule.kind === "narrow") {
    return {
      ...base,
      graceMonths: 0,
      status: "no-grace",
      note:
        rule.kind === "narrow"
          ? `Only the narrow exceptions above (${rule.graceMonths} months) apply; an ordinary publication by the inventor destroys novelty here unless a priority filing precedes it.`
          : "A US filing does not cure a prior public disclosure here unless a valid priority claim precedes the disclosure.",
    };
  }
  const deadline = addMonths(disclosure, rule.graceMonths);
  return {
    ...base,
    graceMonths: rule.graceMonths,
    deadline: isoDate(deadline),
    daysRemaining: daysBetween(today, deadline),
    status: reference > deadline ? "closed" : "open",
    note:
      byInventor === false
        ? "Grace generally covers the applicant's own disclosure or one derived from the applicant; a disclosure by an independent third party is not excused."
        : `Counted back from the ${rule.measuredFrom}. Conditions apply; see the rule text.`,
  };
}

export function assessDisclosure(facts: DisclosureFacts): DisclosureAssessment {
  const disclosure = parseDate(facts.disclosureDate);
  const planned = parseDate(facts.plannedFilingDate);
  const events: string[] = [];
  const jurisdictions: JurisdictionBar[] = [];

  if (!disclosure) {
    return {
      urgency: "none-recorded",
      events: ["No public-disclosure date recorded."],
      jurisdictions: [],
      actions: [
        "Record any publication, public use, sale, or offer for sale with its date and who made it.",
        "If nothing has been disclosed, keep it that way until filing strategy is set.",
      ],
      disclaimer: "Date arithmetic only; not legal advice.",
    };
  }

  events.push(
    `${facts.disclosureKind ?? "disclosure"} on ${isoDate(disclosure)}${facts.byInventor === false ? " by someone other than the inventor" : facts.byInventor === true ? " by the inventor" : " by an unrecorded party"}`,
  );

  const usDeadline = addMonths(disclosure, 12);
  const today = new Date();
  const usDays = daysBetween(today, usDeadline);
  const reference = planned ?? today;
  const usStatus: JurisdictionBar["status"] = reference > usDeadline ? "closed" : "open";

  jurisdictions.push({
    code: "US",
    name: JURISDICTION_NAMES.US ?? "United States",
    rule: "35 U.S.C. 102(b)(1)(A)-(B): one-year grace period from a disclosure by the inventor or one who obtained the subject matter from the inventor",
    citation: "35 U.S.C. 102(b)(1)",
    graceMonths: 12,
    deadline: isoDate(usDeadline),
    daysRemaining: usDays,
    status: usStatus,
    note:
      facts.byInventor === false
        ? "A third-party disclosure before the inventor's own filing can still bar if it is not excepted by 102(b)(1)(B); treat the third-party date as the trigger."
        : "The inventor's own disclosure starts the one-year clock.",
  });

  for (const code of facts.jurisdictions ?? DEFAULT_FOREIGN) {
    if (code === "US") continue;
    jurisdictions.push(foreignBar(code, disclosure, reference, today, facts.byInventor));
  }

  const urgency: DisclosureAssessment["urgency"] =
    usStatus === "closed" ? "barred" : usDays <= 90 ? "time-critical" : "routine";

  const actions: string[] = [];
  if (usStatus === "closed") {
    actions.push("The one-year US grace period has run from the recorded date; document any earlier conception, diligence, or an earlier priority filing before proceeding.");
  } else {
    actions.push(`File a US application on or before ${isoDate(usDeadline)} to preserve the grace-period benefit.`);
  }
  if (jurisdictions.some((entry) => entry.status === "no-grace")) {
    actions.push("For jurisdictions without a general grace period (EP, GB, DE, FR, and CN or IN outside their narrow exceptions), only a filing date before the first public disclosure preserves novelty.");
  }
  if (jurisdictions.some((entry) => entry.status === "open" && entry.code !== "US")) {
    actions.push("Where a foreign 12-month grace applies, meet its formalities (JP and KR: claim the exception and file proof; CA and AU: count from the national filing date, not the US priority date).");
  }
  if (facts.byInventor === false) {
    actions.push("Establish whether the third-party disclosure derives from the inventor (35 U.S.C. 102(b)(1)(B)) and document the evidence.");
  }
  actions.push("Calendar the deadline with a docketing system; this tool computes dates but does not docket them.");

  return {
    earliestDisclosure: isoDate(disclosure),
    usDeadline: isoDate(usDeadline),
    daysRemaining: usDays,
    urgency,
    events,
    jurisdictions,
    actions,
    disclaimer: "Date arithmetic only; not legal advice. Confirm every date and exception with counsel.",
  };
}
