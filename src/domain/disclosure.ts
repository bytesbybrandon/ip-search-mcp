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

const ABSOLUTE_NOVELTY = ["EP", "CN", "JP", "KR", "DE", "FR", "GB", "IN", "BR", "AU", "CA"];

const JURISDICTION_NAMES: Record<string, string> = {
  US: "United States",
  EP: "European Patent Office",
  CN: "China",
  JP: "Japan",
  KR: "Republic of Korea",
  DE: "Germany",
  FR: "France",
  GB: "United Kingdom",
  IN: "India",
  BR: "Brazil",
  AU: "Australia",
  CA: "Canada",
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
    graceMonths: 12,
    deadline: isoDate(usDeadline),
    daysRemaining: usDays,
    status: usStatus,
    note:
      facts.byInventor === false
        ? "A third-party disclosure before the inventor's own filing can still bar if it is not excepted by 102(b)(1)(B); treat the third-party date as the trigger."
        : "The inventor's own disclosure starts the one-year clock.",
  });

  for (const code of facts.jurisdictions ?? ABSOLUTE_NOVELTY) {
    if (code === "US") continue;
    const absolute = ABSOLUTE_NOVELTY.includes(code);
    jurisdictions.push({
      code,
      name: JURISDICTION_NAMES[code] ?? code,
      rule: absolute
        ? "Absolute novelty: any public disclosure before the priority date destroys novelty, with only narrow exceptions (for example EPO, abuse, and certain exhibitions)"
        : "Check the national grace provision before relying on a disclosure exception",
      graceMonths: 0,
      status: absolute ? "no-grace" : "unknown",
      note: absolute
        ? "A US filing does not retroactively cure a prior public disclosure in this jurisdiction unless a valid priority claim precedes the disclosure."
        : "National law requires confirmation.",
    });
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
    actions.push("For absolute-novelty jurisdictions, only a filing date before the first public disclosure preserves novelty.");
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
