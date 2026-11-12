# ip-search-mcp

[![CI](https://github.com/bytesbybrandon/ip-search-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/bytesbybrandon/ip-search-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An MCP server and command-line tool for vetting new ideas: it searches prior art, reads patent claims, charts freedom to operate, checks your own web pages for earlier disclosure, and drafts review-only patent application artifacts. It never files, signs, or submits anything.

The deployed project page is at https://bytesbybrandon.github.io/ip-search-mcp/.

Jump to: [Quick Start](#quick-start) · [Common Tasks](#common-tasks) · [Manual Install and Configuration](#manual-install-and-configuration) · [Reference](#reference)

---

### Quick Start

**Tell your agent:** use `npx -y ip-axi`

```bash
npx -y ip-axi
```

That prints which data sources are configured. No keys are required to start; papers, preprints, and code search work without any, and patent prior-art search needs the free USPTO Open Data Portal (ODP) key described under [Environment Setup](#environment-setup). Requires Node.js 24 or newer.

To give an MCP client the tools instead, add this entry to its server configuration:

```json
{
  "mcpServers": {
    "ip-search-mcp": {
      "command": "npx",
      "args": ["-y", "ip-search-mcp"]
    }
  }
}
```

---

### Common Tasks

The examples use `npx -y ip-axi`, which runs the published package. From a clone of this repository, replace it with `node dist/src/axi/index.js`.

#### Vet a new idea

Write each feature as a heading, a bullet, or its own paragraph, then run:

```bash
npx -y ip-axi vet @features.md --sites https://example.com/
```

For every feature you get the closest patents, papers, preprints, and open-source projects; a claim-by-claim chart of any in-force patent whose every claim element appears in your feature; the date your own pages first showed it, if they did; and a recommendation to file, publish defensively, or keep it secret, with the reasons. Pass `--signature "exact text one;exact text two"` (or `--signatures-file @signatures.txt`) with the exact strings that would show a feature, such as interface text or identifiers, so the page check looks for the right thing. Add `--provisional` for a draft section an attorney can start from, and `--fingerprints` for strings a pre-publication check can watch for. When a search source fails or a check cannot run, the output says so and the recommendation says its evidence is partial. It is a starting point for a patent attorney, not legal advice.

#### Other common tasks

```bash
# Search prior art from a description (patents, papers, preprints, code)
npx -y ip-axi prior-art search "A handheld optical sensor that recalibrates against a sealed reference surface" --fields why

# Read a patent: independent claims, owner, status, estimated expiry
npx -y ip-axi patents read 9765584

# Chart a feature against a patent's claim elements
npx -y ip-axi fto chart 9765584 --feature @feature.md

# Find when your own pages first showed a feature
npx -y ip-axi disclosure scan https://example.com/ --signature "Recalibrate now"

# Look up a trademark
npx -y ip-axi trademarks get 87454105

# Check drawings against 37 CFR 1.84
npx -y ip-axi drawings validate ip/drawings/fig-1.svg --description @ip/specification.md

# Search patents, and fetch an office action from a file wrapper
npx -y ip-axi patents search "optical sensor" --limit 5
npx -y ip-axi patents docs 19131214 --code CTNF

# Build the local search index
npx -y ip-axi index build --from <dir-of-bulk-xml>
```

---

### Manual Install and Configuration

#### Prerequisites

* Node.js 24 or newer.
* pnpm 10.

#### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/bytesbybrandon/ip-search-mcp.git
   cd ip-search-mcp
   ```
2. **Install dependencies:**
   ```bash
   pnpm install --frozen-lockfile
   ```
3. **Build:**
   ```bash
   pnpm build
   ```

Run `npm link` once in the repo to put `ip-axi` on PATH; afterwards the bare command works from any directory. `pnpm exec ip-axi` also works inside the repo.

#### Environment Setup

No keys are required to start. Without them, keyed tools return a `CREDENTIAL_MISSING` error with setup instructions, and unkeyed sources remain available. Patent prior-art search needs the free ODP key; papers, preprints, and code search work without keys.

Keys come from the process environment. On Windows and under WSL, a USPTO, EPO, or OpenAlex key missing from the process environment is also read once from the Windows user environment, so keys set there need no client restart; set `IP_WINDOWS_ENV=0` to turn that off. A local `.env` file is not loaded automatically; pass it explicitly with `node --env-file=.env dist/src/index.js`. `.env.example` lists every variable and holds no values.

See [docs/CREDENTIALS.md](docs/CREDENTIALS.md) for how to obtain each provider key and how keys are isolated.

Check what is configured without printing any value:

```bash
node dist/src/index.js status
```

The output lists each provider with `configured`, `required`, and `host`, plus `allowUnofficial` and the index state. It never prints a key.

#### Running the MCP Server from a Clone

Start the MCP server over stdio:

```bash
node dist/src/index.js
```

MCP clients normally spawn the server themselves. Register it in the client config:

```json
{
  "mcpServers": {
    "ip-search-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/ip-search-mcp/dist/src/index.js"],
      "env": {
        "USPTO_ODP_API_KEY": "",
        "USPTO_TSDR_API_KEY": ""
      }
    }
  }
}
```

Replace the path with your clone location. Empty values are treated as unset.

The same binary also exposes CLI commands:

```bash
node dist/src/index.js --help
node dist/src/index.js status
node dist/src/index.js rules
```

---

### Reference

#### Key Features

* **Prior-art search:** one description in, several generated queries out, across US patents (titles, CPC classes, and citations, then full text and claims), OpenAlex papers, arXiv preprints, and GitHub repositories, merged into one relevance-ranked list with the overlapping passage for each hit.
* **Top-hit reading:** independent claims, current owner, status, estimated expiry, and maintenance-fee state for any US patent.
* **Feature vetting:** one command per description, feature by feature: closest art, element-by-element freedom-to-operate charts of in-force patents, a dated public-disclosure check of web pages (Wayback, urlscan, archive.today, live), a recommendation (file, publish defensively, or keep secret), a provisional-ready draft section, and signature fingerprints.
* **Official provider search:** ODP file wrapper, TSDR status, and EPO OPS, with provenance on every hit.
* **Local index:** SQLite FTS5 index built over USPTO bulk XML.
* **Drawing compliance:** 37 CFR 1.84 SVG generation and validation with citations.
* **Drafting aids:** claim parsing and linting, specification assembly, disclosure-clock arithmetic with a cited foreign grace table, and concept assessment.
* **Attorney packet:** review packet assembly that reports gaps instead of inventing content.
* **Opt-in surfaces:** Patent Public Search and the Trademark Search backend behind `IP_ALLOW_UNOFFICIAL=1`, labeled `undocumented: true`.

The server searches official and bulk-derived sources, keeps provenance on every hit, screens concepts for patentability and registrability signals, and produces drawings, claims, specifications, and an attorney packet.

#### Tools and Commands

Every tool, its inputs, and whether it writes a file is documented in [docs/TOOLS.md](docs/TOOLS.md). Building a local search index is documented in [docs/LOCAL-INDEX.md](docs/LOCAL-INDEX.md).

`ip-axi` is an AXI-compliant CLI over the same tools, for shell use and scripted work. Output is TOON, every list prints totals, `--fields` adds columns, `--full` stops truncation, exit codes are 0 success / 1 error / 2 usage, errors carry a fixing command, and every result ends with a `next[]` block. Full command reference: [skills/ip-axi/SKILL.md](skills/ip-axi/SKILL.md).

#### Tech Stack

* **Runtime:** Node.js 24 or newer with TypeScript.
* **MCP:** `@modelcontextprotocol/sdk` over stdio, with `zod` input schemas.
* **Storage:** `node:sqlite` FTS5 database plus a file cache.
* **Tools:** pnpm, `tsc`, `node --test`, and GitHub Actions.
* **Site:** static HTML in `site/`, deployed by GitHub Pages.

#### Running Tests

```bash
pnpm build
pnpm test
```

`pnpm test` runs `node --test` against the compiled output, so build first.

The suite clears provider keys before it starts (`test/setup.ts`), so it asserts the missing-credential path and never calls a live provider, locally or in CI.

Type checking alone:

```bash
pnpm check
```

CI runs install, build, check, and test on Node 24.

The ip-axi command reference is checked with `pnpm skill:check`; it fails when a command is missing from `skills/ip-axi/SKILL.md`.

#### Project Structure

```text
src/
  index.ts        entry point: CLI or stdio server
  server.ts       tool registration, input schemas, output formatting
  cli.ts          status, rules, and index commands
  config.ts       environment parsing and credential state
  http.ts         fetch, retry, rate limit, cache, host check
  research.ts     prior-art search and top-hit reading (composes providers and domain)
  vet.ts          feature vetting: element charts, disclosure scan, verdict
  domain/         assessment, claims, disclosure, drawings, spec, relevance, term, fto, vet
  providers/      ODP, TSDR, EPO OPS, OpenAlex, arXiv, GitHub, web archives, PPUBS, tmsearch, local index
  axi/            ip-axi shell interface (TOON output, flags, exit codes)
  numbers.ts      patent and trademark identifier normalization
  errors.ts       typed errors
  types.ts        shared types
test/             node --test suites and XML fixtures
docs/             architecture, credentials, limits, tools, local index
skills/ip-axi/    AXI command reference
site/             static project page for GitHub Pages
.github/          community files, CI, and Pages
```

Component boundaries and data flow are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). What no tool can do, and which surfaces carry terms-of-use risk, is in [docs/LIMITS.md](docs/LIMITS.md).

#### Contributing

Contributions are welcome. Read [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md), then fork the repository, branch from `main`, make a focused change with tests, run the checks above, and open a pull request.

#### License

MIT. See [LICENSE](LICENSE).

Not legal advice. This server produces research and drafts for review by a licensed patent or trademark practitioner. No output is a filing, an opinion of patentability, a clearance opinion, or a freedom-to-operate analysis.
