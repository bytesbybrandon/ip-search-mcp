import assert from "node:assert/strict";
import test from "node:test";
import { chartClaims, claimElements, classifyElement } from "../src/domain/fto.js";
import { stem, tokenize } from "../src/domain/relevance.js";
import { createHash } from "node:crypto";
import { decide, deriveSignatures, fingerprints, provisionalSection, splitFeatures } from "../src/domain/vet.js";
import { parseArgs } from "../src/axi/args.js";
import { specs } from "../src/axi/commands.js";
import { LIVE_PAGE_LIMIT, livePage, parseTimemap, waybackDate, type Capture } from "../src/providers/archives.js";
import { disclosureScan, earliestWaybackMatch, ftoCharts, searchGaps, WAYBACK_FALLBACK_PAGES } from "../src/vet.js";
import { json, withOdp } from "./odp-stub.js";

const CLAIM =
  "1. A sensor assembly comprising: a housing; an optical sensor disposed in the housing; and a reference surface sealed in a chamber of the housing, wherein the optical sensor recalibrates against the reference surface when drift exceeds a threshold.";
const FEATURE =
  "A handheld optical sensor sits in a housing and recalibrates against a reference surface sealed in a chamber whenever measured drift exceeds a threshold.";

test("claim elements split on semicolons and wherein clauses", () => {
  const { preamble, elements } = claimElements(CLAIM);
  assert.equal(preamble, "A sensor assembly comprising");
  assert.deepEqual(elements, [
    "a housing",
    "an optical sensor disposed in the housing",
    "a reference surface sealed in a chamber of the housing",
    "wherein the optical sensor recalibrates against the reference surface when drift exceeds a threshold",
  ]);
});

test("elements are present, absent, or unclear by shared content terms", () => {
  const stems = new Set(tokenize(FEATURE).map(stem));
  assert.equal(classifyElement("an optical sensor disposed in the housing", stems).status, "present");
  assert.equal(classifyElement("a wireless radio transmitting packets to a base station", stems).status, "absent");
  assert.equal(classifyElement("a battery powering the optical sensor", stems).status, "unclear");
});

test("a claim with every element present is flagged; one absent element clears it", () => {
  const [flagged] = chartClaims([{ number: 1, text: CLAIM }], FEATURE);
  assert.equal(flagged?.flag, "all-elements-present");
  const [cleared] = chartClaims([{ number: 1, text: `${CLAIM.replace(/\.$/, "")}; and a wireless radio transmitting packets to a base station.` }], FEATURE);
  assert.equal(cleared?.flag, "element-absent");
});

test("descriptions split into features by headings, bullets, or paragraphs", () => {
  const headed = splitFeatures("# Drift recalibration\nThe sensor recalibrates against a sealed reference surface when drift exceeds a threshold.\n\n# Thermal guard\nA thermistor pauses measurement while the housing warms above a set temperature limit.");
  assert.deepEqual(headed.map((feature) => feature.name), ["Drift recalibration", "Thermal guard"]);
  assert.match(headed[1]!.description, /thermistor/);
  const paragraphs = splitFeatures("The sensor recalibrates against a sealed reference surface when drift exceeds a threshold.\n\nA thermistor pauses measurement while the housing warms above a set temperature limit.");
  assert.equal(paragraphs.length, 2);
  assert.equal(splitFeatures("One short feature about a sensor that recalibrates itself in the field.").length, 1);
});

test("verdict: closed grace publishes, crowded publishes, open grace files, undetectable keeps secret", () => {
  assert.equal(decide({ closestCoverage: 0.3, ftoFlags: [], disclosedOn: "2024-01-01", usGrace: "closed" }).recommendation, "publish-defensively");
  assert.equal(decide({ closestCoverage: 0.9, ftoFlags: [] }).recommendation, "publish-defensively");
  const open = decide({ closestCoverage: 0.3, ftoFlags: ["US9765584"], disclosedOn: "2026-06-01", usGrace: "open", usDeadline: "2027-06-01" });
  assert.equal(open.recommendation, "file");
  assert.ok(open.reasons.some((reason) => reason.includes("2027-06-01")));
  assert.ok(open.cautions.some((caution) => caution.includes("US9765584")));
  assert.equal(decide({ closestCoverage: 0.3, ftoFlags: [], detectable: false }).recommendation, "keep-secret");
  const unknown = decide({ closestCoverage: 0.3, ftoFlags: [] });
  assert.equal(unknown.recommendation, "file");
  assert.ok(unknown.cautions.some((caution) => /secret/.test(caution)));
});

test("fingerprints normalize and hash each signature", () => {
  const [print] = fingerprints("Drift recalibration", ["  Recalibrate   NOW "]);
  assert.equal(print?.normalized, "recalibrate now");
  assert.equal(print?.sha256, createHash("sha256").update("recalibrate now").digest("hex"));
  assert.deepEqual(deriveSignatures("The reference surface is sealed. Drift is measured against the reference surface."), ["reference surface"]);
  assert.deepEqual(deriveSignatures(FEATURE), [], "single words are never derived: they match almost any page");
});

test("provisional section marks gaps and keeps the draft banner", () => {
  const text = provisionalSection({ feature: { name: "Drift recalibration", description: FEATURE }, closestArt: [{ id: "US9765584", title: "Self-calibrating optical sensor housing", date: "2010-01-01" }] });
  assert.match(text, /DRAFT/);
  assert.match(text, /US9765584 \(2010-01-01\)/);
  assert.match(text, /ATTORNEY INPUT REQUIRED: embodiments/);
  assert.match(text, /comprising:/);
});

test("archive date helpers", () => {
  assert.equal(waybackDate("20150930234511"), "2015-09-30T23:45:11Z");
  const map = parseTimemap('<https://archive.ph/b>; rel="memento"; datetime="Tue, 02 Jan 2024 00:00:00 GMT",\n<https://archive.ph/a>; rel="first memento"; datetime="Mon, 01 Jan 2024 00:00:00 GMT"');
  assert.deepEqual(map.map((entry) => entry.date.slice(0, 10)), ["2024-01-01", "2024-01-02"]);
});

test("earliest Wayback match binary-searches with few fetches", async () => {
  const captures: Capture[] = Array.from({ length: 64 }, (_, index) => ({ date: `d${index}`, timestamp: String(index), original: "https://example.com/" }));
  let fetches = 0;
  const content = async (capture: Capture) => {
    fetches += 1;
    return Number(capture.timestamp) >= 37 ? "<p>Recalibrate now</p>" : "<p>coming soon</p>";
  };
  const { found, failed } = await earliestWaybackMatch(captures, ["recalibrate NOW"], content);
  assert.equal(found?.capture.timestamp, "37");
  assert.equal(found?.signature, "recalibrate NOW");
  assert.equal(failed, 0);
  assert.ok(fetches <= 12, `fetches ${fetches}`);
  assert.deepEqual(await earliestWaybackMatch(captures, ["absent text"], async () => "nothing"), { failed: 0 });

  const many: Capture[] = Array.from({ length: 500 }, (_, index) => ({ date: `d${index}`, timestamp: String(index), original: "https://example.com/" }));
  fetches = 0;
  await earliestWaybackMatch(many, ["recalibrate now"], async (capture) => {
    fetches += 1;
    return Number(capture.timestamp) >= 301 ? "Recalibrate now" : "";
  });
  assert.ok(fetches <= 16, `a 500-capture page costs ${fetches} fetches; the documented fallback cap relies on at most about 15`);
});

test("a failed capture fetch is counted and never read as a miss", async () => {
  const captures: Capture[] = Array.from({ length: 64 }, (_, index) => ({ date: `d${index}`, timestamp: String(index), original: "https://example.com/" }));
  // The feature first appears at 5; the probe of sample 12 fails, which used to count as a miss and move the answer to 13.
  const { found, failed } = await earliestWaybackMatch(captures, ["recalibrate now"], async (capture) => {
    const index = Number(capture.timestamp);
    if (index === 12) throw new Error("503");
    return index >= 5 ? "Recalibrate now" : "coming soon";
  });
  assert.ok(failed >= 1, "the failure is reported");
  assert.ok(found !== undefined && Number(found.capture.timestamp) >= 5);
  const allFail = await earliestWaybackMatch(captures, ["recalibrate now"], async () => {
    throw new Error("429");
  });
  assert.equal(allFail.found, undefined);
  assert.ok(allFail.failed > 0, "no match with failed probes is not the same as no match");
});

test("a short leading heading is not a feature, and its words stay with the first real one", () => {
  const [first, second, ...rest] = splitFeatures("# Features\n\n## Drift recalibration\nThe sensor recalibrates against a sealed reference surface when drift exceeds a threshold.\n\n## Thermal guard\nA thermistor pauses measurement while the housing warms above a set temperature limit.");
  assert.equal(rest.length, 0);
  assert.equal(first?.name, "Drift recalibration");
  assert.equal(second?.name, "Thermal guard");
  assert.match(first!.description, /recalibrates against a sealed reference surface/);
  assert.equal(splitFeatures("Just a title").length, 1, "an all-short description is still one feature");
});

test("verdict: an archive date is a latest bound, a live-only match has no deadline, partial evidence is stated", () => {
  const archived = decide({ closestCoverage: 0.3, ftoFlags: [], disclosedOn: "2026-06-01", usGrace: "open", usDeadline: "2027-06-01" });
  assert.match(archived.reasons.join(" "), /no later than 2026-06-01.*on or before 2027-06-01.*may already be running/);
  const live = decide({ closestCoverage: 0.3, ftoFlags: [], seenLiveOn: "2026-11-12" });
  assert.equal(live.recommendation, "file");
  assert.match(live.reasons.join(" "), /first became public is unknown.*may already have run/);
  assert.ok(!/2027-11-12/.test(JSON.stringify(live)), "no deadline is computed from today's date");
  const partial = decide({ closestCoverage: 0, ftoFlags: [], gaps: ["searches failed: openalex", "public disclosure not checked (no sites given)"] });
  assert.ok(partial.cautions.some((caution) => /Evidence is partial: searches failed: openalex; public disclosure not checked/.test(caution)));
  assert.ok(!partial.reasons.some((reason) => /No public disclosure found and no close prior art/.test(reason)), "a partial run does not claim there is nothing out there");
  assert.match(partial.reasons.join(" "), /not a clearance/);
  assert.match(decide({ closestCoverage: 0, ftoFlags: [] }).reasons.join(" "), /No public disclosure found and no close prior art/);
});

test("search gaps name skipped and failed sources and unread full texts", () => {
  assert.deepEqual(searchGaps({ runs: [{ source: "odp", query: "q", count: 3 }], notes: [] }), []);
  const gaps = searchGaps({
    runs: [
      { source: "openalex", query: "a", count: 0, error: "RATE_LIMITED" },
      { source: "openalex", query: "b", count: 0, error: "RATE_LIMITED" },
      { source: "arxiv", query: "a", count: 4 },
    ],
    notes: ["patents skipped: USPTO_ODP_API_KEY not set. Create one.", "full text for 15000001 failed: boom"],
  });
  assert.deepEqual(gaps, ["patents were not searched (USPTO_ODP_API_KEY not set)", "searches failed: openalex", "full text unread for 1 patent(s)"]);
});

test("the vet command takes signatures from a repeated flag or ';'", () => {
  const spec = specs.find((entry) => entry.name === "vet")!;
  assert.equal(parseArgs(["f.md", "--signature", "Recalibrate now", "--signature", "driftThreshold"], spec).flags.signature, "Recalibrate now;driftThreshold");
  assert.equal(parseArgs(["f.md", "--signature=a one;b two"], spec).flags.signature, "a one;b two");
  assert.equal(parseArgs(["f.md", "--signatures-file", "@sigs.txt"], spec).flags["signatures-file"], "@sigs.txt");
});

test("charting reads past expired and unreadable patents until enough in-force ones are charted", async () => {
  const extra = (number: number): Record<string, unknown> => {
    if (number <= 9_960_003) {
      return { applicationMetaData: { patentNumber: String(number), inventionTitle: `Expired example ${number}`, filingDate: "2000-01-10", grantDate: "2003-02-04", applicationStatusDescriptionText: "Patented Case" } };
    }
    return number === 9_960_004 ? { grantDocumentMetaData: undefined } : {};
  };
  await withOdp(9_960_000, async () => {
    const numbers = ["9960001", "9960002", "9960003", "9960004", "9960005", "9960006", "9960007"];
    const result = await ftoCharts(numbers, FEATURE, 2);
    assert.deepEqual(result.charts.map((chart) => chart.id), ["US9960005", "US9960006"], "the top two in force are charted, not the top two ranked");
    assert.ok(result.charts[0]!.claims.length > 0);
    assert.deepEqual(result.skipped.map((entry) => [entry.id, entry.reason]), [
      ["US9960001", "not in force (expired)"],
      ["US9960002", "not in force (expired)"],
      ["US9960003", "not in force (expired)"],
      ["US9960004", "claims not readable"],
    ]);
    assert.equal(result.skipped.filter((entry) => entry.unreadable).length, 1);
    assert.ok(!result.charts.some((chart) => chart.id === "US9960007"), "reading stops once enough are charted");
  }, { grantExtra: extra });
});

test("a patent whose claims cannot be read is skipped, not cleared", async () => {
  await withOdp(9_961_000, async () => {
    const result = await ftoCharts(["9961001"], FEATURE);
    assert.deepEqual(result.charts, []);
    assert.deepEqual(result.skipped, [{ id: "US9961001", reason: "claims not readable", unreadable: true }]);
  }, { grantExtra: { grantDocumentMetaData: undefined } });
});

function wayback(request: URL, handlers: { captures?: Record<string, string[][]>; pages?: string[][]; content?: (path: string) => string }): Response {
  if (request.pathname.startsWith("/cdx/search/cdx")) {
    const target = request.searchParams.get("url") ?? "";
    return json(target.endsWith("/*") ? (handlers.pages ?? [["original", "mimetype"]]) : (handlers.captures?.[target] ?? [["timestamp", "original", "digest"]]));
  }
  if (request.pathname.startsWith("/web/")) return new Response(handlers.content?.(request.pathname) ?? "", { status: 200 });
  if (request.pathname.startsWith("/api/v1/search/")) return json({ results: [] });
  return new Response("blocked", { status: 403 });
}

async function withWeb<T>(handle: (request: URL) => Response, run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => handle(new URL(typeof input === "string" || input instanceof URL ? input : input.url));
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("a signature seen only on the live page is public now with no date, deadline, or assessment", async () => {
  await withWeb(
    (request) => (request.host === "live-only.example" ? new Response("<p>Recalibrate now</p>", { status: 200 }) : wayback(request, {})),
    async () => {
      const scan = await disclosureScan(["https://live-only.example/"], ["recalibrate now"]);
      assert.equal(scan.earliestMatch, undefined);
      assert.equal(scan.liveMatch?.source, "live");
      assert.equal(scan.assessment, undefined, "no grace arithmetic from today's date");
      assert.ok(scan.notes.some((note) => /first public date is unknown.*No deadline is computed/.test(note)));
    },
  );
});

test("an archive match is dated by its capture and gets a latest-possible assessment", async () => {
  await withWeb(
    (request) =>
      request.host === "archived.example"
        ? new Response("<p>Recalibrate now</p>", { status: 200 })
        : wayback(request, { captures: { "https://archived.example/": [["timestamp", "original", "digest"], ["20240102030405", "https://archived.example/", "d1"]] }, content: () => "Recalibrate now" }),
    async () => {
      const scan = await disclosureScan(["https://archived.example/"], ["recalibrate now"]);
      assert.equal(scan.earliestMatch?.source, "wayback");
      assert.equal(scan.earliestMatch?.date, "2024-01-02T03:04:05Z");
      assert.equal(scan.assessment?.usDeadline, "2025-01-02");
      assert.equal(scan.assessment?.urgency, "barred");
      assert.equal(scan.incomplete, false);
    },
  );
});

test("a host-wide Wayback fallback is capped and reports the matching page, never the URL asked about", async () => {
  const pages = [["original", "mimetype"], ...["/a", "/b", "/c", "/d", "/about-this-site"].map((path) => [`https://fallback.example${path}`, "text/html"])];
  let contentFetches = 0;
  await withWeb(
    (request) =>
      request.host === "fallback.example"
        ? new Response("nothing", { status: 200 })
        : wayback(request, {
            pages,
            captures: { "https://fallback.example/b": [["timestamp", "original", "digest"], ["20230501000000", "https://fallback.example/b", "d1"]] },
            content: () => {
              contentFetches += 1;
              return "Recalibrate now";
            },
          }),
    async () => {
      const scan = await disclosureScan(["https://fallback.example/"], ["recalibrate now"]);
      assert.equal(scan.earliestMatch?.url, "https://fallback.example/b");
      assert.ok(scan.timeline.every((event) => event.source === "live" || event.url !== "https://fallback.example/"), "no archive event is attributed to the URL asked about");
      assert.ok(scan.notes.some((note) => note.includes(`at most ${WAYBACK_FALLBACK_PAGES}`) && !note.includes("/d,") && !note.includes("/about-this-site")));
      assert.ok(contentFetches <= 16 * WAYBACK_FALLBACK_PAGES);
    },
  );
});

test("a live page is streamed and read only up to the cap, and says it was cut short", async () => {
  const realFetch = globalThis.fetch;
  let pulls = 0;
  let cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(1024 * 1024).fill(97));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 },
    );
  try {
    const page = await livePage("https://endless.example/app.js");
    assert.equal(page.truncated, true);
    assert.equal(page.text.length, LIVE_PAGE_LIMIT);
    assert.equal(cancelled, true, "the rest of the body is never downloaded");
    assert.ok(pulls <= 5, `pulls ${pulls}`);
    globalThis.fetch = async () => new Response("<p>small</p>", { status: 200 });
    assert.deepEqual(await livePage("https://small.example/"), { text: "<p>small</p>", truncated: false });
  } finally {
    globalThis.fetch = realFetch;
  }
});
