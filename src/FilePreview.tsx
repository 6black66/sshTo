import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Maximize2,
  Minimize2,
  Copy,
  FileText,
  LoaderCircle,
  Pencil,
  Save,
  X,
} from "lucide-react";
import { api, type FilePreview as PreviewResult } from "./types";
import HighlightedText from "./HighlightedText";
import { HIGHLIGHT_LIMIT, languageFor } from "./syntax";
const SIZE_KEY = "preview-size";
const MIN_W = 480,
  MIN_H = 320;
const clampSize = (w: number, h: number) => ({
  w: Math.max(MIN_W, Math.min(Math.round(w), window.innerWidth - 48)),
  h: Math.max(MIN_H, Math.min(Math.round(h), window.innerHeight - 48)),
});
const savedSize = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(SIZE_KEY) || "");
    if (typeof saved?.w === "number" && typeof saved?.h === "number")
      return clampSize(saved.w, saved.h);
  } catch {}
  return null;
};
export interface PreviewSource {
  sessionId: string | null;
  path: string;
  source: string;
}
export default function FilePreview({
  file,
  onClose,
}: {
  file: PreviewSource;
  onClose: () => void;
}) {
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState(""),
    [copyState, setCopyState] = useState(""),
    [editing, setEditing] = useState(false),
    [text, setText] = useState(""),
    [saving, setSaving] = useState(false),
    [status, setStatus] = useState(""),
    [overwriteAsk, setOverwriteAsk] = useState(false),
    [closeAsk, setCloseAsk] = useState(false);
  const [maximized, setMaximized] = useState(false),
    [size, setSize] = useState<{ w: number; h: number } | null>(savedSize);
  const [editHtml, setEditHtml] = useState<string | null>(null),
    [composing, setComposing] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const editorHl = useRef<HTMLPreElement>(null);
  const editorLineNumbers = useRef<HTMLPreElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const previewScroll = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(0);
  const scrollLeft = useRef(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const highlighter = useRef<Worker | undefined>(undefined);
  const dirty = editing && !!result && text !== result.text;
  const syncEditorScroll = (top: number, left: number) => {
    if (editorHl.current) {
      editorHl.current.scrollTop = top;
      editorHl.current.scrollLeft = left;
    }
    if (editorLineNumbers.current) editorLineNumbers.current.scrollTop = top;
  };
  // A textarea is mounted only after switching modes. Restore its position after
  // layout, when its scroll height is available, rather than relying on a click
  // handler racing React's render.
  useLayoutEffect(() => {
    if (!editing || !editor.current) return;
    editor.current.scrollTop = scrollTop.current;
    editor.current.scrollLeft = scrollLeft.current;
    syncEditorScroll(scrollTop.current, scrollLeft.current);
  }, [editing]);
  useEffect(() => () => highlighter.current?.terminate(), []);
  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);
  useEffect(() => {
    if (!editing || !result) {
      setEditHtml(null);
      highlighter.current?.terminate();
      highlighter.current = undefined;
      return;
    }
    const language = languageFor(file.path, result.text);
    if (!language || new TextEncoder().encode(text).length > HIGHLIGHT_LIMIT) {
      setEditHtml(null);
      return;
    }
    let worker = highlighter.current;
    if (!worker) {
      worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event) =>
        setEditHtml(
          typeof event.data?.html === "string" ? event.data.html : null,
        );
      worker.onerror = () => setEditHtml(null);
      highlighter.current = worker;
    }
    const timer = setTimeout(
      () => worker!.postMessage({ text, language }),
      150,
    );
    return () => clearTimeout(timer);
  }, [editing, result, text, file.path]);
  useEffect(() => {
    const requestId = crypto.randomUUID();
    let active = true;
    setResult(null);
    setError("");
    setCopyState("");
    setEditing(false);
    setText("");
    setSaving(false);
    setStatus("");
    setOverwriteAsk(false);
    setCloseAsk(false);
    void api<PreviewResult>(
      "files:preview",
      requestId,
      file.sessionId,
      file.path,
    )
      .then((value) => {
        if (active) setResult(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    panel.current?.focus();
    return () => {
      active = false;
      void api("files:preview-cancel", requestId).catch(() => {});
    };
  }, [file]);
  const save = async (force: boolean) => {
    if (!result || saving) return;
    setSaving(true);
    setStatus("");
    try {
      const r = await api<{ mtime: number | null }>(
        "files:save",
        file.sessionId,
        file.path,
        text,
        result.mtime ?? null,
        force,
      );
      setResult({
        ...result,
        text,
        mtime: r.mtime,
        bytesRead: new TextEncoder().encode(text).length,
      });
      setOverwriteAsk(false);
      setStatus("已保存");
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes("已被外部修改")) {
        setOverwriteAsk(true);
        setStatus("");
      } else {
        setOverwriteAsk(false);
        setStatus("保存失败：" + message);
      }
    } finally {
      setSaving(false);
    }
  };
  const requestClose = () => {
    if (dirty) setCloseAsk(true);
    else onClose();
  };
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (maximized || !panel.current) return;
    e.preventDefault();
    const startW = panel.current.offsetWidth,
      startH = panel.current.offsetHeight,
      startX = e.clientX,
      startY = e.clientY;
    const move = (ev: PointerEvent) => {
      const next = clampSize(
        startW + ev.clientX - startX,
        startH + ev.clientY - startY,
      );
      setSize(next);
      localStorage.setItem(SIZE_KEY, JSON.stringify(next));
    };
    const up = () => {
      document.body.classList.remove("resizing-preview");
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.body.classList.add("resizing-preview");
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up, { once: true });
  };
  return (
    <div
      className={
        "overlay preview-overlay" + (maximized ? " preview-overlay-max" : "")
      }
    >
      <div
        ref={panel}
        tabIndex={-1}
        className={maximized ? "file-preview maximized" : "file-preview"}
        style={
          maximized || !size ? undefined : { width: size.w, height: size.h }
        }
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            if (searchOpen) setSearchOpen(false);
            else if (closeAsk) setCloseAsk(false);
            else requestClose();
          }
          if (!editing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
            e.preventDefault();
            setSearchOpen(true);
          }
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            if (editing && dirty && !saving && !overwriteAsk) void save(false);
          }
          if (e.key === "Tab") {
            const buttons = panel.current!.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            );
            const first = buttons[0],
              last = buttons[buttons.length - 1];
            if (
              e.shiftKey &&
              (document.activeElement === first ||
                document.activeElement === panel.current)
            ) {
              e.preventDefault();
              last.focus();
            } else if (
              !e.shiftKey &&
              (document.activeElement === last ||
                document.activeElement === panel.current)
            ) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div
          className="preview-heading"
          onDoubleClick={(e) => {
            if (!(e.target as HTMLElement).closest("button"))
              setMaximized((m) => !m);
          }}
        >
          <FileText size={22} />
          <div>
            <h2 id="preview-title">
              {file.path.split("/").at(-1)}{" "}
              <span>{editing ? "编辑模式" : "只读预览"}</span>
            </h2>
            <p title={file.path}>
              {file.source} · {file.path}
            </p>
          </div>
          {editing ? (
            <button
              title={dirty ? "保存修改（Ctrl+S）" : "没有需要保存的修改"}
              disabled={!dirty || saving || overwriteAsk}
              onClick={() => void save(false)}
            >
              {saving ? (
                <LoaderCircle size={15} className="preview-spinner" />
              ) : (
                <Save size={15} />
              )}
              {saving ? "保存中…" : "保存"}
            </button>
          ) : (
            <button
              title={
                result?.truncated
                  ? "文件较大（超过 1 MiB），暂不支持编辑保存"
                  : "编辑文件内容"
              }
              disabled={!result || result.truncated}
              onClick={() => {
                if (!result) return;
                setText(result.text);
                setStatus("");
                scrollTop.current = previewScroll.current?.scrollTop || 0;
                scrollLeft.current = previewScroll.current?.scrollLeft || 0;
                setEditing(true);
              }}
            >
              <Pencil size={15} />
              编辑
            </button>
          )}
          <button
            disabled={!result}
            onClick={() => {
              void navigator.clipboard
                .writeText(editing ? text : result!.text)
                .then(() => setCopyState("已复制"))
                .catch(() => setCopyState("复制失败，请选择文本后复制"));
            }}
          >
            <Copy size={15} />
            {copyState === "已复制" ? "已复制" : "复制全部"}
          </button>
          <button
            title={
              maximized
                ? "还原窗口（双击标题栏同样生效）"
                : "最大化窗口（双击标题栏同样生效）"
            }
            onClick={() => setMaximized((m) => !m)}
          >
            {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button title="关闭预览" onClick={requestClose}>
            <X size={19} />
          </button>
        </div>
        {result?.truncated && (
          <div className="preview-notice">
            文件较大，仅显示文件开头（最多 1
            MiB）；编辑已禁用，复制仅包含当前显示的内容。
          </div>
        )}
        {overwriteAsk && (
          <div className="preview-notice preview-confirm">
            文件在打开后已被外部修改。覆盖保存将丢弃外部修改。
            <button onClick={() => setOverwriteAsk(false)}>取消</button>
            <button onClick={() => void save(true)}>覆盖保存</button>
          </div>
        )}
        {searchOpen && !editing && (
          <div className="preview-search">
            <input ref={searchInput} aria-label="搜索文件内容" placeholder="搜索…" value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const value = search.trim();
                  if (!value || !result) return;
                  const at = result.text.toLowerCase().indexOf(value.toLowerCase());
                  if (at >= 0 && previewScroll.current) {
                    const line = result.text.slice(0, at).split("\n").length - 1;
                    previewScroll.current.scrollTop = line * 22.1 + 20;
                  }
                }
              }} />
            <button onClick={() => setSearchOpen(false)} title="关闭搜索">Esc</button>
          </div>
        )}
        {closeAsk && (
          <div className="preview-notice preview-confirm">
            有未保存的修改，确定关闭？
            <button onClick={() => setCloseAsk(false)}>继续编辑</button>
            <button onClick={onClose}>放弃修改并关闭</button>
          </div>
        )}
        {error ? (
          <div className="preview-message" role="alert">
            读取失败：{error}
          </div>
        ) : result && editing ? (
          <div className="preview-editor-stack">
            <pre ref={editorLineNumbers} className="preview-line-numbers" aria-hidden="true">{text.split("\n").map((_, i) => i + 1).join("\n")}</pre>
            {editHtml !== null && (
              <pre
                ref={editorHl}
                className="preview-editor-hl"
                aria-hidden="true"
                style={composing ? { visibility: "hidden" } : undefined}
                dangerouslySetInnerHTML={{ __html: editHtml + "\n" }}
              />
            )}
            <textarea
              ref={editor}
              className={
                "preview-editor" +
                (editHtml !== null ? " preview-editor-over" : "") +
                (composing ? " preview-editor-composing" : "")
              }
              aria-label="文件内容编辑区"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onScroll={(e) => {
                scrollTop.current = e.currentTarget.scrollTop;
                scrollLeft.current = e.currentTarget.scrollLeft;
                syncEditorScroll(scrollTop.current, scrollLeft.current);
              }}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              spellCheck={false}
            />
          </div>
        ) : result ? (
          <div className="preview-scroll" ref={previewScroll} onScroll={(e) => {
            scrollTop.current = e.currentTarget.scrollTop;
            scrollLeft.current = e.currentTarget.scrollLeft;
          }}>
            <pre className="preview-readonly-line-numbers" aria-hidden="true">{result.text.split("\n").map((_, i) => i + 1).join("\n")}</pre>
            <HighlightedText text={result.text} path={file.path} />
            {!result.text && <div className="preview-message">此文件为空</div>}
          </div>
        ) : (
          <div className="preview-message">
            <LoaderCircle size={20} className="preview-spinner" />
            正在读取文件…
          </div>
        )}
        <div className="preview-footer">
          <span>
            UTF-8 · {editing ? "可编辑" : "只读"}
            {result
              ? ` · 已读取 ${result.bytesRead.toLocaleString()} 字节`
              : ""}
          </span>
          <span role="status">
            {status ||
              (dirty
                ? "有未保存的修改 · Ctrl+S 保存"
                : copyState || "Esc 关闭")}
          </span>
        </div>
        {!maximized && (
          <div className="preview-resize-handle" onPointerDown={startResize}>
            <span />
          </div>
        )}
      </div>
    </div>
  );
}
