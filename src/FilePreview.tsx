import { useEffect, useRef, useState } from "react";
import { Copy, FileText, LoaderCircle, X } from "lucide-react";
import { api, type FilePreview as PreviewResult } from "./types";
import HighlightedText from "./HighlightedText";
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
    [copyState, setCopyState] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const requestId = crypto.randomUUID();
    let active = true;
    setResult(null);
    setError("");
    setCopyState("");
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
  return (
    <div className="overlay preview-overlay">
      <div
        ref={panel}
        tabIndex={-1}
        className="file-preview"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
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
        <div className="preview-heading">
          <FileText size={22} />
          <div>
            <h2 id="preview-title">
              {file.path.split("/").at(-1)} <span>只读预览</span>
            </h2>
            <p title={file.path}>
              {file.source} · {file.path}
            </p>
          </div>
          <button
            disabled={!result}
            onClick={() => {
              void navigator.clipboard
                .writeText(result!.text)
                .then(() => setCopyState("已复制"))
                .catch(() => setCopyState("复制失败，请选择文本后复制"));
            }}
          >
            <Copy size={15} />
            {copyState === "已复制" ? "已复制" : "复制全部"}
          </button>
          <button title="关闭预览" onClick={onClose}>
            <X size={19} />
          </button>
        </div>
        {result?.truncated && (
          <div className="preview-notice">
            文件较大，仅显示文件开头（最多 1 MiB）；复制仅包含当前显示的内容。
          </div>
        )}
        {error ? (
          <div className="preview-message" role="alert">
            读取失败：{error}
          </div>
        ) : result ? (
          <div className="preview-scroll">
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
            UTF-8 · 只读
            {result
              ? ` · 已读取 ${result.bytesRead.toLocaleString()} 字节`
              : ""}
          </span>
          <span role="status">{copyState || "Esc 关闭"}</span>
        </div>
      </div>
    </div>
  );
}
