import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";
const grammars: Record<string, () => Promise<{ default: LanguageFn }>> = {
  xml: () => import("highlight.js/lib/languages/xml"),
  json: () => import("highlight.js/lib/languages/json"),
  bash: () => import("highlight.js/lib/languages/bash"),
  python: () => import("highlight.js/lib/languages/python"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  css: () => import("highlight.js/lib/languages/css"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  ini: () => import("highlight.js/lib/languages/ini"),
  sql: () => import("highlight.js/lib/languages/sql"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  go: () => import("highlight.js/lib/languages/go"),
  rust: () => import("highlight.js/lib/languages/rust"),
  java: () => import("highlight.js/lib/languages/java"),
  cmake: () => import("highlight.js/lib/languages/cmake"),
};
export async function highlightCode(text: string, language: string) {
  if (language === "log" && !hljs.getLanguage("log"))
    hljs.registerLanguage("log", () => ({
      case_insensitive: true,
      contains: [
        { scope: "error", begin: /\b(?:ERROR|FATAL|CRITICAL)\b/ },
        { scope: "warning", begin: /\bWARN(?:ING)?\b/ },
        { scope: "keyword", begin: /\b(?:INFO|DEBUG|TRACE)\b/ },
        {
          scope: "number",
          begin: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?/,
        },
        { scope: "string", begin: /"/, end: /"/ },
      ],
    }));
  if (!hljs.getLanguage(language)) {
    if (!grammars[language]) throw Error("Unsupported language");
    hljs.registerLanguage(language, (await grammars[language]()).default);
  }
  return hljs.highlight(text, { language, ignoreIllegals: true }).value;
}
