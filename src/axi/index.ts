#!/usr/bin/env node
import { aliases, commands, home, specs } from "./commands.js";
import { parseArgs, type CommandSpec } from "./args.js";
import { renderHelp, renderRootHelp } from "./help.js";
import { AxiError, UsageError, renderError } from "./errors.js";
import { print } from "./toon.js";
import { shutdown } from "./client.js";

const TOOL = "ip-axi";

async function main(argv: string[]): Promise<number> {
  const words: string[] = [];
  for (const token of argv) {
    if (token.startsWith("-")) break;
    words.push(token);
  }

  let key: string | undefined;
  let consumed = 0;
  for (let length = Math.min(2, words.length); length >= 1; length -= 1) {
    const candidate = words.slice(0, length).join(" ");
    const resolved = aliases[candidate] ?? candidate;
    if (commands[resolved]) {
      key = resolved;
      consumed = length;
      break;
    }
  }

  if (!key) {
    if (words.length === 0) {
      const parsed = parseArgs(argv, home.spec);
      if (parsed.help) {
        print(renderRootHelp(TOOL, specs));
        return 0;
      }
      return home.run(parsed);
    }
    throw new UsageError(
      `unknown command '${words.join(" ")}'`,
      `commands: ${Object.keys(commands).join(", ")}`,
    );
  }

  const command = commands[key]!;
  const spec: CommandSpec = command.spec;
  const parsed = parseArgs(argv.slice(consumed), spec);
  if (parsed.help) {
    print(renderHelp(TOOL, spec));
    return 0;
  }
  return command.run(parsed);
}

try {
  const code = await main(process.argv.slice(2));
  await shutdown();
  process.exitCode = code;
} catch (error) {
  if (error instanceof AxiError) {
    print(renderError(error));
    await shutdown();
    process.exitCode = error.exitCode;
  } else {
    print(`error: ${error instanceof Error ? error.message : String(error)}`);
    await shutdown();
    process.exitCode = 1;
  }
}
