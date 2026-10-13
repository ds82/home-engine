# Spec Delta

## Purpose

Provides the project's documentation as a static website: the guides for writing rules together with a complete reference of the `@home-engine/sdk` API, built from the repository and hostable on any static web server.

## ADDED Requirements

### Requirement: Static site build
The repository SHALL build the documentation into a self-contained static site with one command (`npm run docs:build`). The output SHALL need no server-side code. The base path SHALL be configurable at build time, so the site works at a domain root or under a sub-path.

#### Scenario: Build at the domain root
- **WHEN** a developer runs `npm run docs:build` after `npm ci`
- **THEN** the command succeeds and writes HTML, CSS, JavaScript and assets into one output directory that a static file server can serve as is

#### Scenario: Build for a sub-path
- **WHEN** the site is built with the base path `/home-engine/`
- **THEN** every page, asset and internal link in the output resolves under `/home-engine/`

#### Scenario: Local preview
- **WHEN** a developer runs `npm run docs:dev`
- **THEN** the site is served locally and reflects edits to guide pages without a restart

### Requirement: Guides
The site SHALL contain every guide in `docs/`: the rule guides, the migration guides and the performance notes. It SHALL have a home page with a short introduction and a quick start, and navigation that groups the guides. The guide files SHALL stay plain Markdown whose relative links also work when browsing the repository.

#### Scenario: Every guide reachable
- **WHEN** the site is built
- **THEN** each Markdown file under `docs/` (except generated files) is a page reachable from the navigation or sidebar

#### Scenario: Links work in both places
- **WHEN** `docs/rules/scheduling.md` links to `triggers.md`
- **THEN** the link opens the triggers page on the site and the triggers file in the repository browser

### Requirement: SDK API reference
The site SHALL contain an API reference generated from the TSDoc comments of `@home-engine/sdk`. It SHALL list every public export (functions, types and interfaces) with its signature and documentation, and SHALL be regenerated on every build so it cannot drift from the code.

#### Scenario: Function documented
- **WHEN** a reader opens the reference entry for `onChange`
- **THEN** it shows the overloads with their parameter and return types, the description from the doc comment, and links to the referenced types such as `StateEvent`

#### Scenario: Export without a doc comment
- **WHEN** a public export of the SDK has no documentation comment
- **THEN** the documentation build fails and names the export

### Requirement: Link checking
The documentation build SHALL fail when a page links to a page or heading anchor that does not exist on the site.

#### Scenario: Broken guide link
- **WHEN** a guide links to `docs/rules/missing.md`
- **THEN** the build fails and names the page with the broken link

### Requirement: Search
The site SHALL offer full-text search across guides and the API reference that runs in the browser, without an external search service.

#### Scenario: Search a function
- **WHEN** a reader searches for `averageSince`
- **THEN** the results include the history guide and the reference entry for `averageSince`

### Requirement: Build in CI
CI SHALL build the documentation on every push, run the link and documentation checks, and keep the built site as a downloadable artifact of the run.

#### Scenario: Broken link pushed
- **WHEN** a commit introduces a broken link in a guide
- **THEN** the documentation job of that commit's CI run fails

#### Scenario: Site available from CI
- **WHEN** the documentation job succeeds
- **THEN** the run offers the built site as an artifact that can be downloaded and served unchanged
