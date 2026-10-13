// Checks how relative links are resolved for pages that include files from outside docs/.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMarkdownRenderer } from "vitepress";
import { repoLinks, resolveRepoLink, type RepoLinkOptions } from "../.vitepress/repo-links.js";

const repository = "https://github.com/example/home-engine";

describe("repository links", () => {
  let root: string;
  let options: RepoLinkOptions;

  function write(path: string, content = ""): string {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "he-repo-links-"));
    options = { repoRoot: root, docsDir: join(root, "docs"), repository };
    write("README.md", "[compose](examples/docker-compose.yml)");
    write("examples/docker-compose.yml");
    write("examples/rules/hello.ts");
    write("docs/rules/typings.md", "# Typings");
    write("docs/rules/triggers.md", "# Triggers");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps links that resolve against the page itself", () => {
    const page = write("docs/rules/scheduling.md", "[triggers](triggers.md)");
    expect(resolveRepoLink("triggers.md#holds", page, options)).toBeUndefined();
  });

  it("resolves links of included text against the included file", () => {
    const page = write("docs/getting-started.md", "<!--@include: ../README.md#quick-start-->");
    expect(resolveRepoLink("examples/docker-compose.yml", page, options)).toBe(
      `${repository}/blob/main/examples/docker-compose.yml`,
    );
    expect(resolveRepoLink("examples/rules", page, options)).toBe(
      `${repository}/tree/main/examples/rules`,
    );
    expect(resolveRepoLink("docs/rules/typings.md#setup", page, options)).toBe(
      "./rules/typings.md#setup",
    );
  });

  it("sends links that leave docs/ to the repository", () => {
    const page = write("docs/rules/files.md");
    expect(resolveRepoLink("../../examples/rules/hello.ts", page, options)).toBe(
      `${repository}/blob/main/examples/rules/hello.ts`,
    );
  });

  it("leaves external, absolute, anchor-only and unresolvable links alone", () => {
    const page = write("docs/getting-started.md", "<!--@include: ../README.md-->");
    for (const href of ["https://example.com", "/rules/files", "#top", "missing.md"]) {
      expect(resolveRepoLink(href, page, options), href).toBeUndefined();
    }
  });

  it("rewrites hrefs while rendering", async () => {
    const page = write("docs/getting-started.md", "<!--@include: ../README.md-->");
    const md = await createMarkdownRenderer(options.docsDir);
    repoLinks(md, options);
    const html = md.render("[compose](examples/docker-compose.yml)", { path: page });
    expect(html).toContain(`href="${repository}/blob/main/examples/docker-compose.yml"`);
  });
});
