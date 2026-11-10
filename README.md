# ip-search-mcp

[![CI](https://github.com/bytesbybrandon/ip-search-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/bytesbybrandon/ip-search-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

MCP server for patent and trademark research plus review-only drafting of patent application artifacts. It searches official and bulk-derived sources, keeps provenance on every hit, screens concepts for patentability and registrability signals, and produces drawings, claims, specifications, and an attorney packet. It never files, signs, or submits anything.

---

### Key Features

* **Official provider search:** ODP file wrapper, TSDR status, and EPO OPS, with provenance on every hit.
* **Local index:** SQLite FTS5 index built over USPTO bulk XML.
* **Drawing compliance:** 37 CFR 1.84 SVG generation and validation with citations.
* **Drafting aids:** claim parsing and linting, specification assembly, disclosure-clock arithmetic, and concept assessment.
* **Attorney packet:** review packet assembly that reports gaps instead of inventing content.
* **Opt-in surfaces:** Patent Public Search and the Trademark Search backend behind `IP_ALLOW_UNOFFICIAL=1`, labeled `undocumented: true`.

The full tool list is in [docs/TOOLS.md](docs/TOOLS.md).

### Tech Stack

* **Runtime:** Node.js 24 or newer with TypeScript.
* **MCP:** `@modelcontextprotocol/sdk` over stdio, with `zod` input schemas.
* **Storage:** `node:sqlite` FTS5 database plus a file cache.
* **Tools:** pnpm, `tsc`, `node --test`, and GitHub Actions.

### Table of Contents

1. [Getting Started](#getting-started)
2. [Usage](#usage)
3. [Running Tests](#running-tests)
4. [Project Structure](#project-structure)
5. [Contributing](#contributing)
6. [License](#license)

---

### Getting Started

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

#### Environment Setup

No keys are required to start. Without them, keyed tools return a `CREDENTIAL_MISSING` error with setup instructions, and unkeyed sources remain available.

Keys come from the process environment. A local `.env` file is not loaded automatically; pass it explicitly with `node --env-file=.env dist/src/index.js`. `.env.example` lists every variable and holds no values.

See [docs/CREDENTIALS.md](docs/CREDENTIALS.md) for how to obtain each provider key and how keys are isolated.

Check what is configured without printing any value:

```bash
node dist/src/index.js status
```

---

### Usage

#### Running Locally

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

#### Code Example / API Reference

`status` reports provider configuration and index state, and never prints a key:

```bash
node dist/src/index.js status
```

The output lists each provider with `configured`, `required`, and `host`, plus `allowUnofficial` and the index state.

Every tool, its inputs, and whether it writes a file is documented in [docs/TOOLS.md](docs/TOOLS.md). Building a local search index is documented in [docs/LOCAL-INDEX.md](docs/LOCAL-INDEX.md).

---

### Running Tests

```bash
pnpm build
pnpm test
```

`pnpm test` runs `node --test` against the compiled output, so build first.

Run the suite with provider keys unset; the server tests assert the missing-credential path, and CI runs without keys.

Type checking alone:

```bash
pnpm check
```

CI runs install, build, check, and test on Node 24.

---

### Project Structure

```text
src/
  index.ts        entry point: CLI or stdio server
  server.ts       tool registration, input schemas, output formatting
  cli.ts          status, rules, and index commands
  config.ts       environment parsing and credential state
  http.ts         fetch, retry, rate limit, cache, host check
  domain/         assessment, claims, disclosure, drawings, spec
  providers/      ODP, TSDR, EPO OPS, PPUBS, tmsearch, local index
  numbers.ts      patent and trademark identifier normalization
  errors.ts       typed errors
  types.ts        shared types
test/             node --test suites and XML fixtures
docs/             architecture, credentials, limits, tools, local index
.github/          community files and CI
```

Component boundaries and data flow are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). What no tool can do, and which surfaces carry terms-of-use risk, is in [docs/LIMITS.md](docs/LIMITS.md).

---

### Contributing

Contributions are welcome. Read [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md), then fork the repository, branch from `main`, make a focused change with tests, run the checks above, and open a pull request.

---

### License

MIT. See [LICENSE](LICENSE).

Not legal advice. This server produces research and drafts for review by a licensed patent or trademark practitioner. No output is a filing, an opinion of patentability, a clearance opinion, or a freedom-to-operate analysis.
