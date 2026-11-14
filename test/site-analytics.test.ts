import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SITE = fileURLToPath(new URL("../../site/", import.meta.url));
const HOST = "https://umami-production-abb4.up.railway.app";
const TRACKER_SRC = `${HOST}/script.js`;
const WEBSITE_ID = "d5932082-8acf-4e4b-82da-66309d74fe94";
const DOMAINS = ["bytesbybrandon.github.io"];

/** Every public page GitHub Pages serves from site/, in a stable order. */
function pages(): string[] {
  return (readdirSync(SITE, { recursive: true }) as string[])
    .filter((entry) => entry.endsWith(".html"))
    .sort();
}

function read(page: string): string {
  return readFileSync(`${SITE}${page}`, "utf8");
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

test("every public page carries exactly one Umami tracker", () => {
  const found = pages();
  assert.ok(found.includes("index.html"), "the landing page is published");
  assert.ok(found.includes("privacy/index.html"), "the privacy page is published");
  for (const page of found) {
    const tags = [...read(page).matchAll(/<script\b[^>]*>/gi)]
      .map((match) => match[0])
      .filter((tag) => (attribute(tag, "src") ?? "").startsWith(`${HOST}/`));
    assert.equal(tags.length, 1, `${page} loads one tracker`);
    const tracker = tags[0]!;
    assert.equal(attribute(tracker, "src"), TRACKER_SRC, `${page} loads the self-hosted script`);
    assert.equal(attribute(tracker, "data-website-id"), WEBSITE_ID, `${page} sends this site's website id`);
    assert.deepEqual(attribute(tracker, "data-domains")?.split(","), DOMAINS, `${page} counts this hostname only`);
    assert.equal(attribute(tracker, "data-do-not-track"), "true", `${page} honors Do Not Track`);
    assert.match(tracker, /\sdefer(\s|>)/, `${page} defers the tracker so it does not block the page`);
  }
});

test("the landing page links its privacy page", () => {
  assert.match(read("index.html"), /href="\.\/privacy\/"/);
});

test("the privacy page states what the tracker collects", () => {
  const html = read("privacy/index.html");
  assert.match(html, /<h2[^>]*>Site analytics<\/h2>/);
  assert.match(html, /Umami/);
  assert.match(html, /no cookies/i);
  assert.match(html, /Do Not Track/);
});
