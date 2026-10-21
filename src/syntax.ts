export const HIGHLIGHT_LIMIT = 200 * 1024;
export const languageNames: Record<string, string> = {
  xml: "XML / HTML",
  json: "JSON",
  bash: "Shell",
  python: "Python",
  javascript: "JavaScript",
  typescript: "TypeScript",
  cpp: "C / C++",
  css: "CSS",
  yaml: "YAML",
  ini: "INI / TOML",
  sql: "SQL",
  markdown: "Markdown",
  go: "Go",
  rust: "Rust",
  java: "Java",
  cmake: "CMake",
  log: "日志",
};
const extensions: Record<string, string> = {
  xml: "xml",
  html: "xml",
  htm: "xml",
  svg: "xml",
  xsd: "xml",
  json: "json",
  jsonc: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cxx: "cpp",
  css: "css",
  yaml: "yaml",
  yml: "yaml",
  ini: "ini",
  conf: "ini",
  cfg: "ini",
  toml: "ini",
  sql: "sql",
  md: "markdown",
  markdown: "markdown",
  go: "go",
  rs: "rust",
  java: "java",
  cmake: "cmake",
  log: "log",
};
export function languageFor(filePath: string, text: string) {
  const name = filePath.split("/").at(-1)?.toLowerCase() || "";
  if (name === "cmakelists.txt") return "cmake";
  const extension = name.includes(".") ? name.split(".").at(-1)! : "";
  if (extensions[extension]) return extensions[extension];
  if (/^#![^\n]*\b(?:ba|z|da|k)?sh\b/.test(text)) return "bash";
  if (/^#![^\n]*\bpython(?:\d(?:\.\d+)*)?\b/.test(text)) return "python";
  return null;
}
