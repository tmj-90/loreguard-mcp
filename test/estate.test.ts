import { describe, expect, it } from "vitest";

import { estateScaffoldFiles } from "../src/cli/estate.js";

describe("cli/estate — scaffold", () => {
  it("writes the workflow, repo list, and README", () => {
    const files = estateScaffoldFiles();
    const paths = files.map((f) => f.path);
    expect(paths).toContain(".github/workflows/loreguard-estate.yml");
    expect(paths).toContain("loreguard-estate.repos.txt");
    expect(paths).toContain("README.md");
  });

  it("renders GitHub Actions expressions without escaping artifacts", () => {
    const wf = estateScaffoldFiles().find((f) => f.path.endsWith(".yml"))!.content;
    // The secret interpolation must be literal ${{ ... }}, not escaped.
    expect(wf).toContain("${{ secrets.ESTATE_READ_TOKEN }}");
    expect(wf).toContain("loreguard estate ./repos --out-dir ./site");
    expect(wf).toContain("upload-pages-artifact");
    expect(wf).toContain("deploy-pages");
    // No stray backslash-dollar from template escaping leaked through.
    expect(wf).not.toContain("\\${{");
    // No literal tabs (YAML must be spaces).
    expect(wf).not.toMatch(/\t/);
  });

  it("repo-list template is comment-only so an empty estate is a no-op", () => {
    const repos = estateScaffoldFiles().find((f) =>
      f.path.endsWith("repos.txt"),
    )!.content;
    const active = repos
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("#"));
    expect(active).toEqual([]);
  });
});
