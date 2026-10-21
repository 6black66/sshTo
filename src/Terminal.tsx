import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "./types";
// Buffer output outside mounted panes so hidden tabs never lose terminal history.
const terminals = new Map<
  string,
  { term: XTerm; fit: FitAddon; unsub: () => void; resize: () => void }
>();
export function disposeTerminal(id: string) {
  const t = terminals.get(id);
  if (t) {
    t.unsub();
    t.term.dispose();
    terminals.delete(id);
  }
}
export default function Terminal({
  id,
  active,
}: {
  id: string;
  active: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let item = terminals.get(id);
    if (!item) {
      const term = new XTerm({
        fontSize: 14,
        fontFamily: '"DejaVu Sans Mono", monospace',
        cursorBlink: true,
        scrollback: 10000,
        theme: {
          background: "#10131a",
          foreground: "#d9dfec",
          cursor: "#9dacef",
          selectionBackground: "#343d63",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(ref.current!);
      const resize = () => {
        try {
          fit.fit();
          void api("sessions:resize", id, term.cols, term.rows).catch(() => {});
        } catch {}
      };
      term.onData(
        (data) => void api("sessions:input", id, data).catch(() => {}),
      );
      const unsub = window.sshTo.subscribe((e) => {
        if (e.id === id && e.type === "data" && e.data) {
          const bytes = Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0));
          term.write(bytes);
        }
        if (e.id === id && e.type === "status" && e.status === "connected")
          resize();
      });
      item = { term, fit, unsub, resize };
      terminals.set(id, item);
    } else if (item.term.element) ref.current!.appendChild(item.term.element);
    const observer = new ResizeObserver(item.resize);
    observer.observe(ref.current!);
    requestAnimationFrame(item.resize);
    return () => observer.disconnect();
  }, [id]);
  useEffect(() => {
    if (active) terminals.get(id)?.term.focus();
  }, [id, active]);
  return <div className="terminal" ref={ref} />;
}
