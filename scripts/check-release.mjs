#!/usr/bin/env node
// Fails when the two publishable manifests disagree, before a release runs.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const wrapper = JSON.parse(readFileSync("packages/ip-axi/package.json", "utf8"));

assert.equal(wrapper.version, root.version, "ip-axi version must match ip-search-mcp");
assert.equal(wrapper.dependencies["ip-search-mcp"], root.version, "ip-axi must depend on the same version");
assert.equal(root.private, undefined, "ip-search-mcp must not be private");
assert.ok(root.files.includes("dist/src"), "ip-search-mcp must publish dist/src");
assert.ok(!root.files.includes("dist"), "ip-search-mcp must not publish compiled tests");
assert.ok(existsSync(join("packages/ip-axi", wrapper.bin["ip-axi"])), "ip-axi bin is missing");

console.log(`release:check ok (${root.name}@${root.version}, ${wrapper.name}@${wrapper.version})`);
