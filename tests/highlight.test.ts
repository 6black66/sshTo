import { describe, it, expect } from "vitest";
import { languageFor } from "../src/syntax";
import { highlightCode } from "../src/highlight-code";
describe("preview syntax colors", () => {
  it("chooses a language from filenames or script shebangs", () => {
    expect(languageFor("/config.XML", "")).toBe("xml");
    expect(languageFor("/config.json", "")).toBe("json");
    expect(languageFor("/CMakeLists.txt", "")).toBe("cmake");
    expect(languageFor("/run", "#!/usr/bin/env python3\nprint(1)")).toBe(
      "python",
    );
    expect(languageFor("/run", "#!/bin/bash\necho hi")).toBe("bash");
    expect(languageFor("/notes.txt", "plain text")).toBeNull();
  });
  it("escapes file markup and marks XML names, attributes and strings", async () => {
    const html = await highlightCode(
      '<config mode="test"><script>alert(1)</script><img src=x onerror="alert(2)"/></config>',
      "xml",
    );
    expect(html).toContain("hljs-name");
    expect(html).toContain("hljs-attr");
    expect(html).toContain("hljs-string");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;");
  });
  it("colors JSON values and distinct log severity levels", async () => {
    const json = await highlightCode(
      '{"enabled":true,"port":22,"name":"中文"}',
      "json",
    );
    expect(json).toContain("hljs-attr");
    expect(json).toContain("hljs-literal");
    expect(json).toContain("hljs-number");
    const log = await highlightCode(
      "2026-10-21 15:30:00 ERROR failed\nWARN retry\nINFO ready",
      "log",
    );
    expect(log).toContain("hljs-error");
    expect(log).toContain("hljs-warning");
    expect(log).toContain("hljs-keyword");
  });
});
