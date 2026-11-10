#!/usr/bin/env node
// Fails when skills/ip-axi/SKILL.md stops covering every AXI command.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const help = spawnSync(process.execPath, ["dist/src/axi/index.js", "--help"], { encoding: "utf8" });
if (help.status !== 0) {
  console.error("ip-axi --help failed");
  process.exit(1);
}
const commands = [...help.stdout.matchAll(/^  ([a-z][a-z ]*),/gm)].map((match) => match[1].trim());
const skill = readFileSync(new URL("../skills/ip-axi/SKILL.md", import.meta.url), "utf8");
const missing = commands.filter((command) => !skill.includes(command));
if (missing.length > 0) {
  console.error(`SKILL.md is stale; missing commands: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`skill:check ok (${commands.length} commands covered)`);
