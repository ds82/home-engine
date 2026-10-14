# docs-site Specification

## Purpose

Provides the project's documentation as a static website, the documentation site: the guides for writing rules and running the engine, together with a complete reference of the `@home-engine/sdk` API, built from the repository and hostable on any static web server.

## Requirements

### Requirement: Static site build
The repository SHALL build the documentation site into a self-contained static site with one command (`npm run docs:build`). The output SHALL need no server-side code. The base path SHALL be configurable at build time, so the documentation site works at a domain root or under a sub-path.

#### Scenario: Build at the domain root
- **WHEN** a developer runs `npm run docs:build` after `npm ci`
- **THEN** the command succeeds and writes HTML, CSS, JavaScript and assets into one output directory that a static file server can serve as is

#### Scenario: Build for a sub-path
- **WHEN** the documentation site is built with the base path `/home-engine/`
- **THEN** every page, asset and internal link in the output resolves under `/home-engine/`

#### Scenario: Local preview
- **WHEN** a developer runs `npm run docs:dev`
- **THEN** the documentation site is served locally and reflects edits to guide pages without a restart

### Requirement: Guides
The documentation site SHALL contain every guide in `docs/`: the rule guides, the configuration and status guides, the migration guides and the performance notes. It SHALL have a home page with a short introduction that links to a getting-started page containing the README's quick start, and navigation that groups the guides. The guide files SHALL stay plain Markdown whose relative links also work when browsing the repository. The quick start SHALL be written once, in the README.

#### Scenario: Every guide reachable
- **WHEN** the documentation site is built
- **THEN** each Markdown file under `docs/` (except generated files) is a page reachable from the navigation or sidebar

#### Scenario: Links work in both places
- **WHEN** `docs/rules/scheduling.md` links to `triggers.md`
- **THEN** the link opens the triggers page on the documentation site and the triggers file in the repository browser

#### Scenario: Quick start from the README
- **WHEN** a reader opens the getting-started page
- **THEN** it shows the README's quick start, and an edit to the quick start in the README appears there on the next build

### Requirement: Links to the repository
Links whose target lies outside `docs/` SHALL point to that file in the canonical repository, whose URL is configured in one place. Relative links SHALL be resolved against the file they are written in, also when that text is included from another file.

#### Scenario: Example linked from the quick start
- **WHEN** the README's quick start links to `examples/docker-compose.yml`
- **THEN** on the getting-started page the link opens that file in the canonical repository, and in the README it stays a relative link

#### Scenario: Guide linked from the quick start
- **WHEN** the README's quick start links to `docs/rules/typings.md`
- **THEN** on the getting-started page the link opens the typings page of the documentation site

### Requirement: SDK API reference
The documentation site SHALL contain an API reference generated from the TSDoc comments of `@home-engine/sdk`. It SHALL list every public export (functions, types and interfaces) with its signature, its properties and methods, and its documentation, grouped by topic, and SHALL be regenerated on every build so it cannot drift from the code. Source links SHALL point to the canonical repository.

#### Scenario: Function documented
- **WHEN** a reader opens the reference entry for `onChange`
- **THEN** it shows its signature with parameter and return types, the description from the doc comment, and links to the referenced types such as `StateEvent`

#### Scenario: Export without a doc comment
- **WHEN** a public export of the SDK has no documentation comment
- **THEN** the documentation build fails and names the export

#### Scenario: Property without a doc comment
- **WHEN** a property of an exported interface, such as a field of `StateEvent`, has no documentation comment
- **THEN** the documentation build fails and names the property

### Requirement: Link checking
The documentation build SHALL fail when a page links to a page or heading anchor that does not exist on the documentation site.

#### Scenario: Broken guide link
- **WHEN** a guide links to `docs/rules/missing.md`
- **THEN** the build fails and names the page with the broken link

#### Scenario: Broken anchor
- **WHEN** a guide links to `triggers.md#missing-heading`
- **THEN** the build fails and names the source page and the anchor

### Requirement: Search
The documentation site SHALL offer full-text search across guides and the API reference that runs in the browser, without an external search service.

#### Scenario: Search a function
- **WHEN** a reader searches for `averageSince`
- **THEN** the results include the history guide and the reference entry for `averageSince`

### Requirement: Build in CI
CI SHALL build the documentation site on every push, run the link and documentation checks, and keep the built site as a downloadable artifact of the run.

#### Scenario: Broken link pushed
- **WHEN** a commit introduces a broken link in a guide
- **THEN** the documentation job of that commit's CI run fails

#### Scenario: Documentation site available from CI
- **WHEN** the documentation job succeeds
- **THEN** the run offers the built site as an artifact that can be downloaded and served unchanged
