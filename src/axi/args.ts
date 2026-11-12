import { UsageError } from "./errors.js";

export interface FlagSpec {
  name: string;
  type: "string" | "boolean";
  default?: string | boolean;
  values?: string[];
  /** A string flag that may be given more than once; the values join with ";". */
  repeatable?: boolean;
  description: string;
}

export interface ArgSpec {
  name: string;
  required: boolean;
  description: string;
}

export interface CommandSpec {
  name: string;
  summary: string;
  args?: ArgSpec[];
  flags: FlagSpec[];
  examples: string[];
}

export interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean>;
  help: boolean;
}

export function validFlagsHint(spec: CommandSpec): string {
  const names = spec.flags.map((flag) => `--${flag.name}`);
  names.push("--help");
  return `valid flags for '${spec.name || "ip-axi"}': ${names.join(", ")}`;
}

export function parseArgs(argv: string[], spec: CommandSpec): Parsed {
  const flags: Record<string, string | boolean> = {};
  for (const flag of spec.flags) {
    if (flag.default !== undefined) flags[flag.name] = flag.default;
  }
  const positionals: string[] = [];
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token.startsWith("--")) {
      let name = token.slice(2);
      let inline: string | undefined;
      const equals = name.indexOf("=");
      if (equals >= 0) {
        inline = name.slice(equals + 1);
        name = name.slice(0, equals);
      }
      const flag = spec.flags.find((entry) => entry.name === name);
      if (!flag) {
        throw new UsageError(`unknown flag --${name}`, validFlagsHint(spec));
      }
      if (flag.type === "boolean") {
        if (inline !== undefined) {
          throw new UsageError(`flag --${name} does not take a value`, validFlagsHint(spec));
        }
        flags[name] = true;
        continue;
      }
      let value = inline;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new UsageError(`flag --${name} requires a value`, `usage: --${name} <value>`);
        }
        value = next;
        i += 1;
      }
      if (flag.values && !flag.values.includes(value)) {
        throw new UsageError(
          `invalid value '${value}' for --${name}`,
          `valid values: ${flag.values.join(", ")}`,
        );
      }
      flags[name] = flag.repeatable && typeof flags[name] === "string" ? `${flags[name]};${value}` : value;
      continue;
    }
    positionals.push(token);
  }

  if (!help) {
    for (const arg of spec.args ?? []) {
      if (arg.required && positionals.length === 0) {
        throw new UsageError(`missing argument <${arg.name}>`, `usage: ip-axi ${spec.name} <${arg.name}>`);
      }
    }
  }

  return { positionals, flags, help };
}

export function stringFlag(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function booleanFlag(parsed: Parsed, name: string): boolean {
  return parsed.flags[name] === true;
}

export function numberFlag(parsed: Parsed, name: string, fallback: number): number {
  const raw = stringFlag(parsed, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    throw new UsageError(`--${name} must be a positive number`, `got '${raw}'`);
  }
  return Math.floor(value);
}
