/**
 * Patent term and in-force estimate from public file-wrapper data. An
 * estimate for triage, not a legal status: terminal disclaimers, term
 * extensions, and reinstatements are not visible here.
 */

export interface TermFacts {
  status?: string;
  /** ODP application type code or label (UTL, DES, PLT; "Utility", "Design", "Plant"). */
  applicationType?: string;
  filingDate?: string;
  /** Earliest US non-provisional filing date this application claims the benefit of (continuation, divisional). */
  earliestNonProvisionalDate?: string;
  grantDate?: string;
  ptaDays?: number;
  events?: Array<{ date?: string; description?: string }>;
  today?: string;
}

export type InForce = "in-force" | "expired" | "lapsed" | "uncertain" | "pending" | "abandoned" | "unknown";

export interface TermEstimate {
  inForce: InForce;
  /** Estimated expiry: utility and plant, earliest non-provisional filing + 20 years + PTA; design, 15 (or 14) years from grant. */
  estimatedExpiry?: string;
  maintenance: Array<{ year: 4 | 8 | 12; dueBy: string; graceEnds: string; paid: boolean; state: "paid" | "due-later" | "in-grace" | "missed" }>;
  basis: string[];
  caveats: string[];
}

const FEE_YEAR: Record<4 | 8 | 12, RegExp> = {
  4: /Maintenance Fee, 4th (Year|Yr)|3\.5 yr surcharge/i,
  8: /Maintenance Fee, 8th (Year|Yr)|7\.5 yr surcharge/i,
  12: /Maintenance Fee, 12th (Year|Yr)|11\.5 yr surcharge/i,
};

function addYears(iso: string, years: number, months = 0, days = 0): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  date.setUTCMonth(date.getUTCMonth() + months);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Perf: P1 · O(events) · CRAP <= 15 (CC 12, branch coverage >= 80%).
 */
export function estimateTerm(facts: TermFacts): TermEstimate {
  const today = (facts.today ?? new Date().toISOString()).slice(0, 10);
  const status = facts.status ?? "";
  const events = facts.events ?? [];
  const basis: string[] = [];
  const caveats = [
    "Estimate only. Terminal disclaimers, patent term extension (35 U.S.C. 156), and reinstatement after late payment are not visible in this data.",
  ];
  const maintenance: TermEstimate["maintenance"] = [];

  if (!facts.grantDate) {
    const abandoned = /abandon/i.test(status);
    basis.push(status ? `ODP status: ${status}` : "No grant date in the record.");
    return { inForce: abandoned ? "abandoned" : status ? "pending" : "unknown", maintenance, basis, caveats };
  }

  if (/^DES|design/i.test(facts.applicationType ?? "")) {
    // 35 U.S.C. 173: 15 years from grant for applications filed on or after 2015-05-13, else 14. No maintenance fees.
    const years = (facts.filingDate ?? "") >= "2015-05-13" ? 15 : 14;
    const estimatedExpiry = addYears(facts.grantDate, years);
    basis.push(`Design patent: ${years} years from grant (35 U.S.C. 173); no maintenance fees.`);
    const ended = today >= estimatedExpiry;
    return { inForce: /expired/i.test(status) || ended ? "expired" : "in-force", estimatedExpiry, maintenance, basis, caveats };
  }
  const plant = /^PLT|plant/i.test(facts.applicationType ?? "");

  const start = facts.earliestNonProvisionalDate ?? facts.filingDate;
  let estimatedExpiry: string | undefined;
  if (start) {
    estimatedExpiry = addYears(start, 20, 0, facts.ptaDays ?? 0);
    basis.push(
      `20 years from ${start}${facts.earliestNonProvisionalDate ? " (earliest non-provisional in the chain)" : " (this application's filing date)"} plus ${facts.ptaDays ?? 0} days of term adjustment.`,
    );
    if (!facts.earliestNonProvisionalDate) caveats.push("Continuity was not checked; a parent non-provisional would make the term end earlier.");
  }

  // Plant patents, like designs, owe no maintenance fees (35 U.S.C. 41(b)).
  for (const year of plant ? [] : ([4, 8, 12] as const)) {
    const dueBy = addYears(facts.grantDate, year, -6);
    const graceEnds = addYears(facts.grantDate, year);
    const paid = events.some((event) => FEE_YEAR[year].test(event.description ?? ""));
    const state = paid ? "paid" : today < dueBy ? "due-later" : today <= graceEnds ? "in-grace" : "missed";
    maintenance.push({ year, dueBy, graceEnds, paid, state });
  }

  const expireEvent = [...events].reverse().find((event) => /expire patent/i.test(event.description ?? ""));
  const reinstated = events.some(
    (event) => /accept late payment of maintenance fees? - granted|accept delayed payment of maintenance fee.*granted/i.test(event.description ?? "") && (event.date ?? "") >= (expireEvent?.date ?? ""),
  );
  if (reinstated) basis.push("A late maintenance-fee payment was accepted on petition after expiry.");
  if (!reinstated && (/expired|nonpayment/i.test(status) || expireEvent)) {
    basis.push(`ODP status: ${status || "expired"}${expireEvent?.date ? ` (event ${expireEvent.date.slice(0, 10)})` : ""}.`);
    return { inForce: "lapsed", estimatedExpiry, maintenance, basis, caveats };
  }
  if (estimatedExpiry && today >= estimatedExpiry) {
    basis.push("The estimated full term has ended.");
    return { inForce: "expired", estimatedExpiry, maintenance, basis, caveats };
  }
  const missed = maintenance.find((entry) => entry.state === "missed");
  if (missed && !reinstated) {
    // ODP still says the patent stands and records no expiry, so do not call it lapsed.
    basis.push(`No payment event found for the ${missed.year}th-year maintenance fee, whose grace ended ${missed.graceEnds}, but ODP records no expiry.`);
    return { inForce: "uncertain", estimatedExpiry, maintenance, basis, caveats: [...caveats, "Confirm fee status on Patent Center before relying on this patent being in force or lapsed."] };
  }
  basis.push(status ? `ODP status: ${status}.` : "Granted; no expiry or lapse event recorded.");
  return { inForce: "in-force", estimatedExpiry, maintenance, basis, caveats };
}
