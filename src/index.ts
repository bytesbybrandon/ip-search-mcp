#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runCli } from "./cli.js";
import { createServer } from "./server.js";

const args = process.argv.slice(2);

if (args.length > 0 && !args.includes("--stdio")) {
  const code = await runCli(args);
  process.exit(code);
}

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT", () => {
  void server.close().then(() => process.exit(0));
});
