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
  /** `not-excused`: a 12-month grace exists but does not cover a disclosure by someone other than the inventor. */
  status: "open" | "closed" | "unknown" | "no-grace" | "not-excused";
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
    citation: "EPC Art. 54(2), Art. 55(1)-(2); Rule 25",
    conditions: "No grace for the applicant's own disclosure. Art. 55 excuses only an evident abuse against the applicant or display at an officially recognised international exhibition, within 6 months before the actual EP filing date (a priority date does not move it back). Exhibition: state it at filing and file the certificate within 4 months (Rule 25).",
  },
  {
    code: "GB", name: "United Kingdom", graceMonths: 0, kind: "none", measuredFrom: "filing date",
    citation: "Patents Act 1977 s. 2(4)-(5); Patents Rules 2007 r. 5",
    conditions: "No grace for the applicant's own disclosure. Only a disclosure made in breach of confidence or by unlawful obtaining, or display at a recognised international exhibition, within 6 months before filing. Exhibition: written statement at filing, evidence within 4 months.",
  },
  {
    code: "DE", name: "Germany", graceMonths: 0, kind: "none", measuredFrom: "filing date",
    citation: "Patentgesetz § 3(5); Gebrauchsmustergesetz § 3(1)",
    conditions: "Patent: abuse or recognised exhibition within 6 months before filing only. A German utility model keeps a 6-month grace for disclosures based on the applicant's own work, counted from its priority date.",
  },
  {
    code: "FR", name: "France", graceMonths: 0, kind: "none", measuredFrom: "filing date",
    citation: "Code de la propriété intellectuelle art. L611-13, R612-22",
    conditions: "Abuse or recognised international exhibition within 6 months before filing only. Exhibition: declare at filing, proof within 4 months.",
  },
  {
    code: "CN", name: "China", graceMonths: 6, kind: "narrow", measuredFrom: "priority date",
    citation: "Patent Law of the PRC (2020) Art. 24; Implementing Regulations (2023) Rules 12, 33, 124",
    conditions: "Narrow 6-month exceptions only, counted from the priority date where one is claimed: first disclosure in the public interest during a national emergency, first exhibition at a government-sponsored or recognised international exhibition, first publication at a prescribed academic or technical meeting, or disclosure without the applicant's consent. Exhibitions and meetings: declare at filing, proof within 2 months. Ordinary self-publication is not covered.",
  },
  {
    code: "JP", name: "Japan", graceMonths: 12, kind: "conditional", measuredFrom: "filing date",
    citation: "Patent Act Art. 30(1)-(4) (12 months for applications filed from 2018-06-09); Art. 184-14",
    conditions: "Covers the right holder's own disclosure, except publication in a patent, utility model, design, or trademark gazette. Counted back from the Japanese filing date or the PCT international filing date, not a Paris priority date. State the exception at filing and file proof within 30 days.",
  },
  {
    code: "KR", name: "Republic of Korea", graceMonths: 12, kind: "conditional", measuredFrom: "filing date",
    citation: "Patent Act Art. 30(1)-(3); Arts. 199-200",
    conditions: "Covers the right holder's own disclosure, except publication of a Korean or foreign application or registration. Counted back from the Korean filing date or the PCT international filing date. Claim it at filing with proof within 30 days, or later for a fee (during the amendment period or within 3 months of the decision to grant).",
  },
  {
    code: "CA", name: "Canada", graceMonths: 12, kind: "conditional", measuredFrom: "filing date",
    citation: "Patent Act s. 28.2(1)(a)",
    conditions: "Disclosure by the applicant, or by someone who obtained the information directly or indirectly from the applicant, is excused within the year before the Canadian filing date, not the priority date. No declaration is required.",
  },
  {
    code: "AU", name: "Australia", graceMonths: 12, kind: "conditional", measuredFrom: "filing date",
    citation: "Patents Act 1990 s. 24(1); Patents Regulations 1991 reg. 2.2C (also 2.2-2.2D)",
    conditions: "Publication or use by or with the consent of the patentee or nominated person is disregarded if a complete application is filed within 12 months of it. A provisional filing does not anchor this general grace. No declaration is required.",
  },
  {
    code: "BR", name: "Brazil", graceMonths: 12, kind: "general", measuredFrom: "priority date",
    citation: "Industrial Property Law 9.279/1996 Art. 12",
    conditions: "Disclosure by the inventor, by INPI publishing an application filed without the inventor's consent, or by a third party using information from the inventor, within 12 months before the filing or priority date, is not prior art. INPI may require a declaration with proof.",
  },
  {
    code: "IN", name: "India", graceMonths: 12, kind: "narrow", measuredFrom: "filing date",
    citation: "Patents Act 1970 ss. 29(2)-(3), 31, 32",
    conditions: "Narrow exceptions only: display at an exhibition notified by the Government or a paper read before a learned society, if the application follows within 12 months (s. 31); public working for reasonable trial within the year before the priority date (s. 32); publication without consent (s. 29). Ordinary self-publication is not covered.",
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
  if (byInventor === false) {
    return {
      ...base,
      graceMonths: rule.graceMonths,
      status: "not-excused",
      note: "Grace generally covers the applicant's own disclosure or one derived from the applicant; a disclosure by an independent third party is not excused.",
    };
  }
  const deadline = addMonths(disclosure, rule.graceMonths);
  return {
    ...base,
    graceMonths: rule.graceMonths,
    deadline: isoDate(deadline),
    daysRemaining: daysBetween(today, deadline),
    status: reference > deadline ? "closed" : "open",
    note: `Counted back from the ${rule.measuredFrom}. Conditions apply; see the rule text.`,
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

  const thirdParty = facts.byInventor === false;
  const usDeadline = addMonths(disclosure, 12);
  const today = new Date();
  const usDays = daysBetween(today, usDeadline);
  const reference = planned ?? today;
  const usStatus: JurisdictionBar["status"] = thirdParty ? "not-excused" : reference > usDeadline ? "closed" : "open";

  jurisdictions.push({
    code: "US",
    name: JURISDICTION_NAMES.US ?? "United States",
    rule: "35 U.S.C. 102(b)(1)(A)-(B): one-year grace period from a disclosure by the inventor or one who obtained the subject matter from the inventor",
    citation: "35 U.S.C. 102(b)(1)",
    graceMonths: 12,
    ...(thirdParty ? {} : { deadline: isoDate(usDeadline), daysRemaining: usDays }),
    status: usStatus,
    note: thirdParty
      ? "A disclosure by an independent third party is prior art and gets no grace period. It is excepted only if it derives from the inventor or follows the inventor's own earlier public disclosure (102(b)(1)(A)-(B)); until that is established, report no window."
      : "The inventor's own disclosure starts the one-year clock.",
  });

  for (const code of facts.jurisdictions ?? DEFAULT_FOREIGN) {
    if (code === "US") continue;
    jurisdictions.push(foreignBar(code, disclosure, reference, today, facts.byInventor));
  }

  const urgency: DisclosureAssessment["urgency"] = usStatus !== "open" ? "barred" : usDays <= 90 ? "time-critical" : "routine";

  const actions: string[] = [];
  if (thirdParty) {
    actions.push(
      "The disclosure by someone other than the inventor is not excused: absent derivation it is prior art in every jurisdiction and no grace period applies. The only remaining question is whether it derives from the inventor (35 U.S.C. 102(b)(1)(A)-(B)); establish and document that before relying on any grace.",
    );
  } else if (usStatus === "closed") {
    actions.push("The one-year US grace period has run from the recorded date; document any earlier conception, diligence, or an earlier priority filing before proceeding.");
  } else {
    actions.push(`File a US application on or before ${isoDate(usDeadline)} to preserve the grace-period benefit.`);
  }
  if (jurisdictions.some((entry) => entry.status === "no-grace")) {
    actions.push("For jurisdictions without a general grace period (EP, GB, DE, FR, and CN or IN outside their narrow exceptions), only a filing date before the first public disclosure preserves novelty.");
  }
  if (jurisdictions.some((entry) => entry.status === "open" && entry.code !== "US")) {
    actions.push("Where a foreign 12-month grace applies, meet its formalities (JP and KR: claim the exception and file proof; JP, KR, CA, and AU count back from the national or PCT international filing date, not the US priority date).");
  }
  if (!thirdParty) actions.push("Calendar the deadline with a docketing system; this tool computes dates but does not docket them.");

  return {
    earliestDisclosure: isoDate(disclosure),
    ...(thirdParty ? {} : { usDeadline: isoDate(usDeadline), daysRemaining: usDays }),
    urgency,
    events,
    jurisdictions,
    actions,
    disclaimer: "Date arithmetic only; not legal advice. Confirm every date and exception with counsel.",
  };
}
