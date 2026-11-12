import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { AxiError } from "./errors.js";

/** A cold prior-art search is paced by provider rate limits and takes minutes; the SDK default is 60 s. */
const REQUEST_TIMEOUT_MS = 10 * 60_000;

let session: Promise<Client> | undefined;
let live: { client: Client; server: { close(): Promise<void> } } | undefined;

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "ip-axi", version: "0.1.0" });
  await client.connect(clientTransport);
  live = { client, server };
  return client;
}

export function getClient(): Promise<Client> {
  if (!session) session = connect();
  return session;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content) || content.length === 0) return "";
  const first: unknown = content[0];
  if (first === null || typeof first !== "object" || !("text" in first)) return "";
  const text: unknown = first.text;
  return typeof text === "string" ? text : "";
}

/** Call an MCP tool in-process and return its JSON payload. */
export async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const client = await getClient();
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT_MS });
  const text = textOf(result.content);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new AxiError(`${name} returned a non-JSON payload`, text.slice(0, 200));
  }
  if (result.isError) {
    const record = payload as { message?: string; hint?: string };
    throw new AxiError(record.message ?? `${name} failed`, record.hint);
  }
  return payload as T;
}

/** Close the in-process MCP session before exiting so libuv handles drain. */
export async function shutdown(): Promise<void> {
  if (!live) return;
  const current = live;
  live = undefined;
  session = undefined;
  await current.client.close().catch(() => undefined);
  await current.server.close().catch(() => undefined);
}
