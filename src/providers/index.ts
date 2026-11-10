import { mkdirSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { XMLParser } from "fast-xml-parser";
import { config } from "../config.js";
import { IpError } from "../errors.js";
import type { Provenance } from "../http.js";
import type { PatentHit, TrademarkHit } from "../types.js";

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
});

export interface IndexStatus {
  dbPath: string;
  exists: boolean;
  patents: number;
  trademarks: number;
  builtAt?: string;
}

export function openIndex(path = config.indexDbPath, readonly = false): DatabaseSync {
  if (!readonly) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { readOnly: readonly });
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS patents(
      doc_number TEXT PRIMARY KEY, kind TEXT, title TEXT, abstract TEXT, claims TEXT,
      description TEXT, filing_date TEXT, grant_date TEXT, inventors TEXT,
      assignees TEXT, cpc TEXT, source_file TEXT
    );
    CREATE TABLE IF NOT EXISTS trademarks(
      serial TEXT PRIMARY KEY, mark TEXT, owner TEXT, goods TEXT, classes TEXT,
      filing_date TEXT, registration_number TEXT, status TEXT, source_file TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS patents_fts USING fts5(
      doc_number UNINDEXED, title, abstract, claims, description, tokenize='porter'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS trademarks_fts USING fts5(
      serial UNINDEXED, mark, owner, goods
    );
  `);
  return db;
}

interface Leaves {
  get(...names: string[]): string | undefined;
  all(...names: string[]): string[];
}

function leaves(node: unknown): Leaves {
  const map = new Map<string, string[]>();
  const push = (key: string, value: string): void => {
    const normalized = key.toLowerCase();
    const bucket = map.get(normalized);
    if (bucket) bucket.push(value);
    else map.set(normalized, [value]);
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child === null || child === undefined) continue;
      if (typeof child === "string") push(key, child);
      else if (typeof child === "number") push(key, String(child));
      else visit(child);
    }
  };
  visit(node);
  return {
    get: (...names) => {
      for (const name of names) {
        const value = map.get(name.toLowerCase())?.find((entry) => entry.trim() !== "");
        if (value) return value.trim();
      }
      return undefined;
    },
    all: (...names) => {
      const values: string[] = [];
      for (const name of names) values.push(...(map.get(name.toLowerCase()) ?? []));
      return [...new Set(values.map((entry) => entry.trim()).filter(Boolean))];
    },
  };
}

function detectKind(payload: unknown): "grant" | "application" | "trademark" | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const keys = Object.keys(payload as Record<string, unknown>).map((key) => key.toLowerCase());
  if (keys.some((key) => key.includes("us-patent-grant"))) return "grant";
  if (keys.some((key) => key.includes("us-patent-application"))) return "application";
  if (keys.some((key) => key.includes("trademark") || key.includes("case-file"))) return "trademark";
  return undefined;
}

function flattenText(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) flattenText(item, out);
    return out;
  }
  if (node === null || node === undefined) return out;
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) flattenText(value, out);
  }
  return out;
}

function subtreeText(node: unknown, key: string, limit: number): string {
  const wanted = key.toLowerCase();
  const find = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = find(item);
        if (hit !== undefined) return hit;
      }
      return undefined;
    }
    if (value === null || typeof value !== 'object') return undefined;
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      if (childKey.toLowerCase() === wanted) return child;
      const hit = find(child);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  const found = find(node);
  if (found === undefined) return '';
  return flattenText(found).join(' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export interface BuildResult {
  scanned: number;
  patents: number;
  trademarks: number;
  skipped: number;
  errors: string[];
}

/** Recursively collect XML files under a directory. */
async function xmlFiles(root: string, out: string[] = []): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) await xmlFiles(full, out);
    else if (extname(entry.name).toLowerCase() === ".xml") out.push(full);
  }
  return out;
}

export async function buildIndex(
  sourceDir: string,
  dbPath = config.indexDbPath,
): Promise<BuildResult> {
  const directory = await stat(sourceDir).catch(() => undefined);
  if (!directory?.isDirectory()) {
    throw new IpError("INVALID_INPUT", `not a directory: ${sourceDir}`, {
      hint: "Point at a folder of USPTO bulk XML files (patent grants, applications, or trademark daily XML).",
    });
  }

  const db = openIndex(dbPath);
  const insertPatent = db.prepare(`
    INSERT OR REPLACE INTO patents(doc_number, kind, title, abstract, claims, description, filing_date, grant_date, inventors, assignees, cpc, source_file)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPatentFts = db.prepare(`
    INSERT INTO patents_fts(doc_number, title, abstract, claims, description) VALUES (?, ?, ?, ?, ?)
  `);
  const insertTrademark = db.prepare(`
    INSERT OR REPLACE INTO trademarks(serial, mark, owner, goods, classes, filing_date, registration_number, status, source_file)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTrademarkFts = db.prepare(`
    INSERT INTO trademarks_fts(serial, mark, owner, goods) VALUES (?, ?, ?, ?)
  `);
  const deletePatentFts = db.prepare(`DELETE FROM patents_fts WHERE doc_number = ?`);
  const deleteTrademarkFts = db.prepare(`DELETE FROM trademarks_fts WHERE serial = ?`);

  const files = await xmlFiles(sourceDir);
  const result: BuildResult = { scanned: files.length, patents: 0, trademarks: 0, skipped: 0, errors: [] };

  for (const file of files) {
    let payload: unknown;
    try {
      payload = parser.parse(await readFile(file, "utf8"));
    } catch (error) {
      result.skipped += 1;
      result.errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const kind = detectKind(payload);
    const index = leaves(payload);

    if (kind === "grant" || kind === "application") {
      const docNumber =
        index.get("doc-number", "patent-number", "publication-number") ??
        index.get("document-number");
      if (!docNumber) {
        result.skipped += 1;
        continue;
      }
      const title = index.get("invention-title", "title");
      const abstract = subtreeText(payload, "abstract", 20_000);
      const claims = subtreeText(payload, "claims", 60_000);
      const description = subtreeText(payload, "description", 120_000);
      const filingDate = index.get("filing-date", "application-filing-date");
      const grantDate = index.get("grant-date", "publication-date", "date");
      const inventors = index.all("last-name", "first-name").join(" ");
      const assignees = index.all("assignee-name", "orgname", "organization-name").join("; ");
      const cpc = index.all("cpc", "classification-cpc", "main-classification").join("; ");
      const number = docNumber.replace(/[^0-9]/g, "");

      deletePatentFts.run(number);
      insertPatent.run(
        number,
        kind,
        title ?? "",
        abstract,
        claims,
        description,
        filingDate ?? "",
        grantDate ?? "",
        inventors,
        assignees,
        cpc,
        file,
      );
      insertPatentFts.run(number, title ?? "", abstract, claims, description);
      result.patents += 1;
      continue;
    }

    if (kind === "trademark") {
      const serial = index.get("serial-number", "application-number")?.replace(/[^0-9]/g, "");
      if (!serial) {
        result.skipped += 1;
        continue;
      }
      const mark = index.get("mark-text-text", "mark-verbalelementtext", "word-mark", "mark-text");
      const owner = index.get("owner-name", "party-name", "name");
      const goods = subtreeText(payload, "goods-services", 20_000);
      const classes = index.all("international-class-number", "class-number").join(",");
      const filingDate = index.get("filing-date");
      const registrationNumber = index.get("registration-number")?.replace(/[^0-9]/g, "");
      const status = index.get("mark-current-status-external-description-text", "status-description-text");

      deleteTrademarkFts.run(serial);
      insertTrademark.run(
        serial,
        mark ?? "",
        owner ?? "",
        goods,
        classes,
        filingDate ?? "",
        registrationNumber ?? "",
        status ?? "",
        file,
      );
      insertTrademarkFts.run(serial, mark ?? "", owner ?? "", goods);
      result.trademarks += 1;
      continue;
    }

    result.skipped += 1;
  }

  db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('built_at', ?)`).run(new Date().toISOString());
  db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('source_dir', ?)`).run(sourceDir);
  db.close();
  return result;
}

export function indexStatus(dbPath = config.indexDbPath): IndexStatus {
  try {
    const db = openIndex(dbPath, true);
    const count = (table: string): number => {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number } | undefined;
      return row?.n ?? 0;
    };
    const builtAt = (db.prepare(`SELECT value FROM meta WHERE key = 'built_at'`).get() as { value?: string } | undefined)
      ?.value;
    const status: IndexStatus = {
      dbPath,
      exists: true,
      patents: count("patents"),
      trademarks: count("trademarks"),
      builtAt,
    };
    db.close();
    return status;
  } catch {
    return { dbPath, exists: false, patents: 0, trademarks: 0 };
  }
}

function provenance(route: string): Provenance {
  return { provider: "index", route, retrievedAt: new Date().toISOString(), note: "local bulk index" };
}

export function searchPatents(
  query: string,
  options: { limit?: number; kind?: "grant" | "application"; dbPath?: string; from?: string; to?: string } = {},
): { hits: PatentHit[]; total: number; provenance: Provenance } {
  const db = openIndex(options.dbPath ?? config.indexDbPath, true);
  try {
    const limit = Math.min(options.limit ?? 20, 100);
    const clauses: string[] = ["patents_fts MATCH ?"];
    const values: Array<string | number> = [query];
    if (options.kind) {
      clauses.push("p.kind = ?");
      values.push(options.kind);
    }
    if (options.from) {
      clauses.push("p.filing_date >= ?");
      values.push(options.from.replace(/[^0-9]/g, ""));
    }
    if (options.to) {
      clauses.push("p.filing_date <= ?");
      values.push(options.to.replace(/[^0-9]/g, ""));
    }
    values.push(limit);
    const rows = db
      .prepare(
        `SELECT p.doc_number, p.kind, p.title, p.abstract, p.filing_date, p.grant_date,
                p.inventors, p.assignees, p.cpc, bm25(patents_fts) AS score
           FROM patents_fts JOIN patents p ON p.doc_number = patents_fts.doc_number
          WHERE ${clauses.join(" AND ")}
          ORDER BY score LIMIT ?`,
      )
      .all(...values) as Array<Record<string, unknown>>;

    const hits: PatentHit[] = rows.map((row) => ({
      kind: "patent",
      number: String(row.doc_number ?? ""),
      displayNumber: String(row.doc_number ?? ""),
      patentKind: row.kind === "application" ? "application" : "grant",
      title: row.title ? String(row.title) : undefined,
      abstract: row.abstract ? String(row.abstract) : undefined,
      filingDate: row.filing_date ? String(row.filing_date) : undefined,
      grantDate: row.grant_date ? String(row.grant_date) : undefined,
      inventors: row.inventors ? String(row.inventors).split(" ").filter(Boolean) : undefined,
      assignees: row.assignees ? String(row.assignees).split("; ").filter(Boolean) : undefined,
      cpc: row.cpc ? String(row.cpc).split("; ").filter(Boolean) : undefined,
      provenance: provenance(`local-fts:patents:${query}`),
    }));
    return { hits, total: hits.length, provenance: provenance("local-fts:patents") };
  } finally {
    db.close();
  }
}

export function searchTrademarks(
  query: string,
  options: { limit?: number; dbPath?: string } = {},
): { hits: TrademarkHit[]; total: number; provenance: Provenance } {
  const db = openIndex(options.dbPath ?? config.indexDbPath, true);
  try {
    const limit = Math.min(options.limit ?? 20, 100);
    const rows = db
      .prepare(
        `SELECT t.serial, t.mark, t.owner, t.goods, t.classes, t.filing_date,
                t.registration_number, t.status, bm25(trademarks_fts) AS score
           FROM trademarks_fts JOIN trademarks t ON t.serial = trademarks_fts.serial
          WHERE trademarks_fts MATCH ? ORDER BY score LIMIT ?`,
      )
      .all(query, limit) as Array<Record<string, unknown>>;

    const hits: TrademarkHit[] = rows.map((row) => ({
      kind: "trademark",
      markText: String(row.mark ?? ""),
      serialNumber: String(row.serial ?? ""),
      registrationNumber: row.registration_number ? String(row.registration_number) : undefined,
      owner: row.owner ? String(row.owner) : undefined,
      filingDate: row.filing_date ? String(row.filing_date) : undefined,
      internationalClasses: row.classes
        ? String(row.classes)
            .split(",")
            .map((entry) => Number(entry))
            .filter((entry) => Number.isFinite(entry))
        : undefined,
      goodsAndServices: row.goods ? String(row.goods) : undefined,
      status: row.status ? String(row.status) : undefined,
      provenance: provenance(`local-fts:trademarks:${query}`),
    }));
    return { hits, total: hits.length, provenance: provenance("local-fts:trademarks") };
  } finally {
    db.close();
  }
}

export const EMPTY_INDEX_WARNING = "Local index returned no rows. Build it first with `ip-search-mcp index build --from <dir>` over an ODP bulk download.";

