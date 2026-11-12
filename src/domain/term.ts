/**
 * Patent term and in-force estimate from public file-wrapper data. An
 * estimate for triage, not a legal status: terminal disclaimers, term
 * extensions, and reinstatements are not visible here.
 */

export interface TermFacts {
  status?: string;
  filingDate?: string;
  /** Earliest US non-provisional filing date this application claims the benefit of (continuation, divisional). */
  earliestNonProvisionalDate?: string;
  grantDate?: string;
  ptaDays?: number;
  events?: Array<{ date?: string; description?: string }>;
  today?: string;
}

export type InForce = "in-force" | "expired" | "lapsed" | "pending" | "abandoned" | "unknown";

export interface TermEstimate {
  inForce: InForce;
  /** Estimated expiry: earliest non-provisional filing + 20 years + PTA. */
  estimatedExpiry?: string;
  maintenance: Array<{ year: 4 | 8 | 12; dueBy: string; graceEnds: string; paid: boolean; state: "paid" | "due-later" | "in-grace" | "missed" }>;
  basis: string[];
  caveats: string[];
}

function addYears(iso: string, years: number, months = 0, days = 0): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  date.setUTCMonth(date.getUTCMonth() + months);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Perf: P1 · O(events) · CRAP <= 15 (CC 11, branch coverage >= 80%).
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

  const start = facts.earliestNonProvisionalDate ?? facts.filingDate;
  let estimatedExpiry: string | undefined;
  if (start) {
    estimatedExpiry = addYears(start, 20, 0, facts.ptaDays ?? 0);
    basis.push(
      `20 years from ${start}${facts.earliestNonProvisionalDate ? " (earliest non-provisional in the chain)" : " (this application's filing date)"} plus ${facts.ptaDays ?? 0} days of term adjustment.`,
    );
    if (!facts.earliestNonProvisionalDate) caveats.push("Continuity was not checked; a parent non-provisional would make the term end earlier.");
  }

  for (const year of [4, 8, 12] as const) {
    const dueBy = addYears(facts.grantDate, year, -6);
    const graceEnds = addYears(facts.grantDate, year);
    const paid = events.some((event) => new RegExp(`Maintenance Fee, ${year}th Year`, "i").test(event.description ?? "") && /payment/i.test(event.description ?? ""));
    const state = paid ? "paid" : today < dueBy ? "due-later" : today <= graceEnds ? "in-grace" : "missed";
    maintenance.push({ year, dueBy, graceEnds, paid, state });
  }

  const expireEvent = events.find((event) => /expire patent/i.test(event.description ?? ""));
  if (/expired|nonpayment/i.test(status) || expireEvent) {
    basis.push(`ODP status: ${status || "expired"}${expireEvent?.date ? ` (event ${expireEvent.date.slice(0, 10)})` : ""}.`);
    return { inForce: "lapsed", estimatedExpiry, maintenance, basis, caveats };
  }
  if (estimatedExpiry && today >= estimatedExpiry) {
    basis.push("The estimated full term has ended.");
    return { inForce: "expired", estimatedExpiry, maintenance, basis, caveats };
  }
  const missed = maintenance.find((entry) => entry.state === "missed");
  if (missed) {
    basis.push(`No payment event for the ${missed.year}th-year maintenance fee and its grace ended ${missed.graceEnds}.`);
    return { inForce: "lapsed", estimatedExpiry, maintenance, basis, caveats: [...caveats, "A payment may be recorded late; confirm on Patent Center."] };
  }
  basis.push(status ? `ODP status: ${status}.` : "Granted; no expiry or lapse event recorded.");
  return { inForce: "in-force", estimatedExpiry, maintenance, basis, caveats };
}
