import { useEffect, useState } from "react";
import { HIGHLIGHT_LIMIT, languageFor, languageNames } from "./syntax";
export default function HighlightedText({
  text,
  path,
}: {
  text: string;
  path: string;
}) {
  const [highlight, setHighlight] = useState<{
    html: string | null;
    label: string;
  }>({ html: null, label: "纯文本" });
  useEffect(() => {
    const language = languageFor(path, text);
    if (!language || !text) {
      setHighlight({ html: null, label: "纯文本" });
      return;
    }
    if (new TextEncoder().encode(text).length > HIGHLIGHT_LIMIT) {
      setHighlight({ html: null, label: "内容较大，使用纯文本显示" });
      return;
    }
    setHighlight({
      html: null,
      label: `${languageNames[language]} · 正在配色…`,
    });
    let worker: Worker | undefined,
      finished = false;
    const fallback = () => {
      if (finished) return;
      finished = true;
      worker?.terminate();
      setHighlight({ html: null, label: "纯文本（语法高亮不可用）" });
    };
    const timer = setTimeout(fallback, 2000);
    try {
      worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event) => {
        if (finished) return;
        if (typeof event.data.html !== "string") {
          fallback();
          clearTimeout(timer);
          return;
        }
        finished = true;
        clearTimeout(timer);
        worker?.terminate();
        setHighlight({
          html: event.data.html,
          label: `${languageNames[language]} · 语法高亮`,
        });
      };
      worker.onerror = () => {
        clearTimeout(timer);
        fallback();
      };
      worker.postMessage({ text, language });
    } catch {
      clearTimeout(timer);
      fallback();
    }
    return () => {
      finished = true;
      clearTimeout(timer);
      worker?.terminate();
    };
  }, [text, path]);
  return (
    <>
      {text && <div className="preview-highlight-info">{highlight.label}</div>}
      {highlight.html !== null ? (
        <pre
          aria-label="文件内容"
          dangerouslySetInnerHTML={{ __html: highlight.html }}
        />
      ) : (
        <pre aria-label="文件内容">{text}</pre>
      )}
    </>
  );
}
