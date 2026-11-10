import type { Provenance } from "./http.js";

export type PatentKind = "grant" | "application" | "publication" | "pct";

export interface PatentHit {
  kind: "patent";
  number: string;
  displayNumber: string;
  patentKind: PatentKind;
  title?: string;
  abstract?: string;
  filingDate?: string;
  effectiveFilingDate?: string;
  grantDate?: string;
  publicationDate?: string;
  inventors?: string[];
  assignees?: string[];
  cpc?: string[];
  status?: string;
  applicationNumber?: string;
  url?: string;
  provenance: Provenance;
}

export interface TrademarkHit {
  kind: "trademark";
  markText: string;
  serialNumber?: string;
  registrationNumber?: string;
  owner?: string;
  filingDate?: string;
  registrationDate?: string;
  internationalClasses?: number[];
  goodsAndServices?: string;
  status?: string;
  statusDate?: string;
  alive?: boolean;
  markImageUrl?: string;
  provenance: Provenance;
}

export interface PatentDocument {
  documentCode?: string;
  description?: string;
  officialDate?: string;
  pageCount?: number;
  downloadUrl?: string;
  provenance: Provenance;
}

export interface SearchEnvelope<T> {
  total?: number;
  hits: T[];
  notes: string[];
  provenance: Provenance[];
  facets?: Record<string, Array<{ value: string; count: number }>>;
}

export interface Evidence {
  claim: string;
  source: string;
  retrievedAt: string;
  note?: string;
}
