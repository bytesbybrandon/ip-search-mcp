import type { CommandSpec } from "./args.js";
import { emitBlock, emitList } from "./toon.js";

export function renderHelp(tool: string, spec: CommandSpec): string {
  const parts: string[] = [];
  parts.push(`command: ${[tool, spec.name].filter(Boolean).join(" ")}`);
  parts.push(`summary: ${spec.summary}`);

  const args = spec.args ?? [];
  if (args.length > 0) {
    parts.push(
      emitList(
        "args",
        args.map((arg) => ({
          name: arg.name,
          required: arg.required ? "yes" : "no",
          description: arg.description,
        })),
        ["name", "required", "description"],
      ),
    );
  }

  const rows = spec.flags.map((flag) => ({
    flag: `--${flag.name}`,
    default: flag.default === undefined ? "" : String(flag.default),
    description: flag.values ? `${flag.description} (${flag.values.join("|")})` : flag.description,
  }));
  rows.push({ flag: "--help", default: "", description: "show this help" });
  parts.push(emitList("flags", rows, ["flag", "default", "description"]));

  if (spec.examples.length > 0) parts.push(emitBlock("examples", spec.examples));
  return parts.join("\n");
}

export function renderRootHelp(tool: string, specs: CommandSpec[]): string {
  const parts: string[] = [];
  parts.push(`tool: ${tool}`);
  parts.push("summary: patent and trademark research, drawing validation, and local bulk index");
  parts.push(
    emitList(
      "commands",
      specs.map((spec) => ({ command: spec.name, summary: spec.summary })),
      ["command", "summary"],
    ),
  );
  parts.push(
    emitBlock("examples", [
      "ip-axi",
      'ip-axi patents search "optical sensor calibration"',
      "ip-axi trademarks get 87454105",
      "ip-axi drawings validate ip/drawings/fig-1.svg --description @ip/specification.md",
    ]),
  );
  parts.push("Run `ip-axi <command> --help` for flags and defaults.");
  return parts.join("\n");
}
