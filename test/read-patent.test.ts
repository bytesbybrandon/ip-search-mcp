import assert from "node:assert/strict";
import test from "node:test";
import { readPatent } from "../src/research.js";
import { withOdp } from "./odp-stub.js";

// Number lookups, continuity, and searches are cached on disk, so each reading below uses
// its own patent number and each search its own query.

test("an eight-digit number without separators says which reading was used", async () => {
  await withOdp(9_600_000, async () => {
    const asGrant = await readPatent("11234567");
    assert.equal(asGrant.id, "US11234567");
    assert.match(asGrant.note ?? "", /fits both a grant and an application number; read as the grant\. Pass 11\/234,567 to read the application/);

    const asApplication = await readPatent("11/234,567");
    assert.equal(asApplication.id, "US-APP-11234567");
    assert.equal(asApplication.note, undefined);
    assert.equal(asApplication.url, "https://patentcenter.uspto.gov/applications/11234567");

    const seven = await readPatent("9765584");
    assert.equal(seven.note, undefined);
    assert.equal(seven.url, "https://patents.google.com/patent/US9765584");
  });
});

test("the term estimate says whether continuity was checked, found a parent, or failed", async () => {
  await withOdp(9_700_000, async () => {
    const none = await readPatent("9765590");
    assert.ok(none.term.basis.some((line) => /No earlier non-provisional parent found/.test(line)));
    assert.ok(!none.term.caveats.some((line) => /Continuity was not checked/.test(line)), "continuity was checked, so it must not be called unchecked");
    assert.equal(none.term.estimatedExpiry, "2038-05-14");
  });
  await withOdp(9_710_000, async () => {
    const parent = await readPatent("9765591");
    assert.equal(parent.term.estimatedExpiry, "2034-09-30");
    assert.ok(!parent.term.basis.some((line) => /No earlier non-provisional parent/.test(line)));
  }, { parentDate: "2014-09-30" });
  await withOdp(9_720_000, async () => {
    const failed = await readPatent("9765592");
    assert.ok(failed.term.caveats.some((line) => /continuity lookup failed.*may end earlier/.test(line)), JSON.stringify(failed.term.caveats));
    assert.ok(!failed.term.basis.some((line) => /No earlier non-provisional parent/.test(line)), "a failed lookup must not claim that no parent exists");
    assert.ok(!failed.term.caveats.some((line) => /Continuity was not checked/.test(line)));
  }, { continuityStatus: 400 });
});

test("the owner is the latest ownership assignment, not a lender or licensee", async () => {
  await withOdp(
    9_800_000,
    async () => {
      const reading = await readPatent("9765593");
      assert.equal(reading.owner, "Second Owner Inc.");
    },
    {
      grantExtra: {
        assignmentBag: [
          { assignmentRecordedDate: "2019-03-01", conveyanceText: "ASSIGNMENT OF ASSIGNORS INTEREST (SEE DOCUMENT FOR DETAILS).", assigneeBag: [{ assigneeNameText: "First Owner LLC" }] },
          { assignmentRecordedDate: "2021-06-01", conveyanceText: "MERGER (SEE DOCUMENT FOR DETAILS).", assigneeBag: [{ assigneeNameText: "Second Owner Inc." }] },
          { assignmentRecordedDate: "2023-01-10", conveyanceText: "SECURITY INTEREST (SEE DOCUMENT FOR DETAILS).", assigneeBag: [{ assigneeNameText: "Example Bank N.A." }] },
          { assignmentRecordedDate: "2024-02-02", conveyanceText: "LICENSE (SEE DOCUMENT FOR DETAILS).", assigneeBag: [{ assigneeNameText: "Example Licensee Ltd." }] },
        ],
      },
    },
  );
});
