import { Fragment, useEffect, useRef, useState } from "react";
import {
  Plus,
  TerminalSquare,
  Server,
  Settings2,
  Search,
  ChevronRight,
  ChevronUp,
  Folder,
  File,
  Upload,
  Download,
  RefreshCw,
  X,
  Columns2,
  Rows2,
  Unplug,
  KeyRound,
  ArrowRight,
  ArrowUpDown,
  Check,
  ShieldCheck,
  Monitor,
  Trash2,
  Copy,
  Scissors,
  Pencil,
  Info,
} from "lucide-react";
import Terminal, { disposeTerminal } from "./Terminal";
import { installClipboardSupport } from "./clipboard";
import FilePreview, { type PreviewSource } from "./FilePreview";
import {
  api,
  type Device,
  type Session,
  type Task,
  type Listing,
  type Entry,
  type FileStat,
} from "./types";
const blank = (): Device => ({
  id: "",
  name: "",
  host: "",
  port: 22,
  username: "root",
  auth: "password",
  keyPath: "",
  jumps: [],
});
const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
const fileTime = (timestamp: number | null) => {
  if (timestamp === null || !Number.isFinite(timestamp)) return "—";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};
const join = (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`;
const label = (status: string) =>
  ({
    connecting: "连接中",
    connected: "已连接",
    error: "连接失败",
    disconnected: "已断开",
    queued: "排队中",
    running: "传输中",
    done: "已完成",
    cancelled: "已取消",
  })[status] || status;
const perms = (mode: number) => {
  if (!Number.isFinite(mode)) return "—";
  const bit = (n: number) =>
    `${n & 4 ? "r" : "-"}${n & 2 ? "w" : "-"}${n & 1 ? "x" : "-"}`;
  return `${bit((mode >> 6) & 7)}${bit((mode >> 3) & 7)}${bit(mode & 7)}`;
};
const uniqueName = (entries: Entry[], name: string) => {
  if (!entries.some((e) => e.name === name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name,
    ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!entries.some((e) => e.name === candidate)) return candidate;
  }
};
type DialogAction = { label: string; value: string; danger?: boolean };
type UndoOp = {
  side: "local" | "remote";
  sessionId: string;
  kind: "rename" | "move" | "copy" | "create";
  from?: string;
  to?: string;
  pairs?: { from: string; to: string }[];
  paths?: string[];
};
type DialogState =
  | {
      kind: "text";
      title: string;
      detail?: string;
      initial: string;
      selectBase?: boolean;
      side: "local" | "remote";
      resolve: (v: string | null) => void;
    }
  | {
      kind: "choice";
      title: string;
      detail: string;
      actions: DialogAction[];
      side: "local" | "remote";
      resolve: (v: string) => void;
    }
  | {
      kind: "stat";
      title: string;
      name: string;
      path: string;
      stat: FileStat;
    };
export default function App() {
  const [preview, setPreview] = useState<PreviewSource | null>(null);
  const previewTrigger = useRef<HTMLElement | null>(null);
  const selectionAnchor = useRef<{
    side: "local" | "remote";
    name: string;
  } | null>(null);
  const [devices, setDevices] = useState<Device[]>([]),
    [sessions, setSessions] = useState<Session[]>([]),
    [active, setActive] = useState(""),
    [split, setSplit] = useState<"none" | "horizontal" | "vertical">("none"),
    [panes, setPanes] = useState<string[]>([]),
    [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Device | null>(null),
    [secret, setSecret] = useState(""),
    [remember, setRemember] = useState(false),
    [vault, setVault] = useState(false),
    [error, setError] = useState(""),
    [files, setFiles] = useState(true),
    [tasks, setTasks] = useState<Task[]>([]),
    [credentials, setCredentials] = useState<{
      target: Device;
      route: Device[];
    } | null>(null),
    [passwords, setPasswords] = useState<Record<string, string>>({});
  const [local, setLocal] = useState<Listing>({ path: "", entries: [] }),
    [remote, setRemote] = useState<Listing>({ path: "", entries: [] }),
    [localSelection, setLocalSelection] = useState<string[]>([]),
    [remoteSelection, setRemoteSelection] = useState<string[]>([]),
    [fileError, setFileError] = useState(""),
    [remoteLoading, setRemoteLoading] = useState(false),
    [showQueue, setShowQueue] = useState(false),
    [busy, setBusy] = useState(false),
    [fileClip, setFileClip] = useState<{
      side: "local" | "remote";
      op: "copy" | "move";
      sessionId: string;
      paths: string[];
    } | null>(null),
    [dialog, setDialog] = useState<DialogState | null>(null),
    [undoStack, setUndoStack] = useState<UndoOp[]>([]);
  const pushUndo = (op: UndoOp) => setUndoStack((s) => [...s.slice(-19), op]);
  const dialogInputRef = useRef<HTMLInputElement | null>(null);
  const undoBusy = useRef(false);
  const entriesRef = useRef<
    Partial<Record<"local" | "remote", HTMLDivElement | null>>
  >({});
  const focusEntries = (side: "local" | "remote") =>
    requestAnimationFrame(() => entriesRef.current[side]?.focus());
  // Modal dialogs without their own input (choice/stat) must trap focus:
  // autofocus on open, Enter activates the last (primary) action only when no
  // button is focused, Escape closes, Tab wraps inside. Without this, Enter
  // leaks to the focused entry underneath and opens the file instead.
  const modalKeyDown = (
    e: React.KeyboardEvent<HTMLDivElement>,
    onEnter: (() => void) | null,
    onClose: () => void,
  ) => {
    if (e.key === "Enter" && onEnter) {
      if ((document.activeElement as HTMLElement)?.tagName === "BUTTON") return;
      e.preventDefault();
      e.stopPropagation();
      onEnter();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Tab") {
      const buttons = [
        ...e.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
      ].filter((b) => !b.disabled);
      if (!buttons.length) return;
      const first = buttons[0],
        last = buttons[buttons.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === e.currentTarget)
      ) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  const refocusIfLost = (side: "local" | "remote") =>
    requestAnimationFrame(() => {
      if (document.activeElement === document.body)
        entriesRef.current[side]?.focus();
    });
  const askText = (
    title: string,
    initial: string,
    detail?: string,
    selectBase = false,
    side: "local" | "remote" = "local",
  ) =>
    new Promise<string | null>((resolve) =>
      setDialog({
        kind: "text",
        title,
        detail,
        initial,
        selectBase,
        side,
        resolve,
      }),
    );
  const askChoice = (
    title: string,
    detail: string,
    actions: DialogAction[],
    side: "local" | "remote" = "local",
  ) =>
    new Promise<string | null>((resolve) =>
      setDialog({ kind: "choice", title, detail, actions, side, resolve }),
    );
  const workspaceRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (dialog?.kind === "choice" || dialog?.kind === "stat")
      modalRef.current?.focus();
  }, [dialog]);
  const fileDrag = useRef<{
    startY: number;
    ratio: number;
    height: number;
  } | null>(null);
  const [fileRatio, setFileRatio] = useState(0.5);
  const [resizingFiles, setResizingFiles] = useState(false);
  const clampFileRatio = (ratio: number, height: number) => {
    const minimum = Math.min(180 / Math.max(1, height), 0.5);
    return Math.max(minimum, Math.min(1 - minimum, ratio));
  };
  const current = sessions.find((s) => s.id === active);
  const activeRef = useRef(active);
  activeRef.current = active;
  const remotePathMemo = useRef<Record<string, string>>({});
  const localPathMemo = useRef<Record<string, string>>({});
  const fileMenuRef = useRef<
    (side: "local" | "remote", action: string) => void
  >(() => {});
  const [weights, setWeights] = useState<Record<string, number>>({});
  const resizePanes = (
    e: React.PointerEvent<HTMLDivElement>,
    left: string,
    right: string,
  ) => {
    e.preventDefault();
    const before = e.currentTarget.previousElementSibling as HTMLElement,
      after = e.currentTarget.nextElementSibling as HTMLElement;
    const horizontal = split === "horizontal";
    const first = horizontal ? before.offsetWidth : before.offsetHeight,
      second = horizontal ? after.offsetWidth : after.offsetHeight;
    const start = horizontal ? e.clientX : e.clientY;
    const sum = (weights[left] || 1) + (weights[right] || 1);
    const move = (event: PointerEvent) => {
      const delta = (horizontal ? event.clientX : event.clientY) - start;
      const ratio = Math.max(
        0.15,
        Math.min(0.85, (first + delta) / (first + second)),
      );
      setWeights((w) => ({
        ...w,
        [left]: sum * ratio,
        [right]: sum * (1 - ratio),
      }));
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up, { once: true });
  };
  const notify = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));
  useEffect(() => installClipboardSupport(notify), []);
  const refreshDevices = () =>
    api<Device[]>("devices:list").then(setDevices).catch(notify);
  useEffect(() => {
    void refreshDevices();
    void api<boolean>("vault:available").then(setVault).catch(notify);
    return window.sshTo.subscribe((e) => {
      if (e.type === "clipboard-error") setError(e.message || "剪贴板操作失败");
      if (e.type === "file-menu" && e.side && e.action)
        fileMenuRef.current(e.side, e.action);
      if (e.type === "status")
        setSessions((all) =>
          all.map((s) =>
            s.id === e.id
              ? { ...s, status: e.status!, hop: e.hop, message: e.message }
              : s,
          ),
        );
      if (e.type === "hop")
        setSessions((all) =>
          all.map((s) => (s.id === e.id ? { ...s, hop: e.hop } : s)),
        );
      if (e.type === "sftp")
        setSessions((all) =>
          all.map((s) =>
            s.id === e.id
              ? { ...s, sftp: e.available, sftpMessage: e.message }
              : s,
          ),
        );
      if (e.type === "transfer" && e.task) {
        setTasks((all) => [...all.filter((t) => t.id !== e.task!.id), e.task!]);
        if (e.task.status === "done" && e.task.undo)
          pushUndo({
            side: "remote",
            sessionId: e.task.sessionId,
            kind: e.task.undo.kind,
            pairs: e.task.undo.pairs,
            paths: e.task.undo.paths,
          });
      }
    });
  }, []);
  useEffect(() => {
    let cancelled = false;
    setRemote({ path: "", entries: [] });
    setRemoteSelection([]);
    setFileError("");
    setRemoteLoading(false);
    if (current?.sftp) {
      setRemoteLoading(true);
      void api<Listing>(
        "files:list",
        current.id,
        remotePathMemo.current[active] || ".",
      )
        .then((r) => {
          if (!cancelled) {
            setRemote(r);
            remotePathMemo.current[active] = r.path;
          }
        })
        .catch((e) => {
          if (!cancelled) setFileError(e.message);
        })
        .finally(() => {
          if (!cancelled) setRemoteLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [active, current?.sftp]);
  useEffect(() => {
    let cancelled = false;
    const key = active;
    const dir = localPathMemo.current[key] ?? "";
    void api<Listing>("files:list", null, dir)
      .then((r) => {
        if (!cancelled && key === activeRef.current) {
          setLocal(r);
          setLocalSelection([]);
          localPathMemo.current[key] = r.path;
        }
      })
      .catch((e) => {
        if (!cancelled && key === activeRef.current) setFileError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);
  const openEditor = (d: Device) => {
    setEditing({ ...d, jumps: [...d.jumps] });
    setSecret("");
    setRemember(!!d.savedSecret && vault);
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    try {
      await api("devices:save", editing, secret || undefined, remember);
      await refreshDevices();
      setEditing(null);
    } catch (e) {
      notify(e);
    } finally {
      setBusy(false);
    }
  };
  const start = async (d: Device, values: Record<string, string> = {}) => {
    try {
      const s = await api<Session>("sessions:connect", d.id, values);
      setSessions((all) => [...all, s]);
      setActive(s.id);
      setPanes((prev) =>
        split === "none"
          ? [s.id]
          : [...prev.filter((id) => sessions.some((x) => x.id === id)), s.id],
      );
      setCredentials(null);
    } catch (e) {
      notify(e);
    }
  };
  const connect = (d: Device) => {
    const route = [
      ...d.jumps.map((id) => devices.find((x) => x.id === id)!),
      d,
    ];
    if (route.some((x) => !x)) {
      notify(Error("跳板设备不存在"));
      return;
    }
    const missing = route.filter((x) => !x.hasSecret);
    if (missing.length) {
      setCredentials({ target: d, route: missing });
      setPasswords({});
    } else void start(d);
  };
  const close = async (id: string) => {
    await api("sessions:close", id).catch(notify);
    disposeTerminal(id);
    delete remotePathMemo.current[id];
    delete localPathMemo.current[id];
    const remaining = sessions.filter((s) => s.id !== id);
    setSessions(remaining);
    setPanes((p) => p.filter((x) => x !== id));
    if (active === id) setActive(remaining.at(-1)?.id || "");
  };
  const reconnect = async (s: Session) => {
    const d = devices.find((d) => d.id === s.deviceId);
    if (d) {
      await close(s.id);
      connect(d);
    }
  };
  const activate = (id: string) => {
    setActive(id);
    if (split === "none") setPanes([id]);
    else setPanes((p) => (p.includes(id) ? p : [...p, id]));
  };
  const layout = (mode: typeof split) => {
    setSplit(mode);
    setPanes(mode === "none" ? [active] : sessions.map((s) => s.id));
  };
  const refreshLocal = async (dir = local.path) => {
    const key = activeRef.current;
    try {
      const r = await api<Listing>("files:list", null, dir);
      localPathMemo.current[key] = r.path;
      localPathMemo.current[""] = r.path;
      if (key === activeRef.current) {
        setLocal(r);
        setLocalSelection([]);
        refocusIfLost("local");
      }
    } catch (e) {
      setFileError((e as Error).message);
    }
  };
  const refreshRemote = async (dir = remote.path) => {
    const id = active;
    if (!current?.sftp) return;
    setRemoteLoading(true);
    try {
      const r = await api<Listing>("files:list", id, dir);
      remotePathMemo.current[id] = r.path;
      if (id === activeRef.current) {
        setRemote(r);
        setRemoteSelection([]);
        refocusIfLost("remote");
      }
    } catch (e) {
      setFileError((e as Error).message);
    } finally {
      setRemoteLoading(false);
    }
  };
  useEffect(() => {
    if (tasks.some((t) => t.status === "done")) {
      void refreshLocal();
      if (current?.sftp) void refreshRemote();
    }
  }, [tasks.filter((t) => t.status === "done").length]);
  const transfer = async (
    direction: "upload" | "download",
    sources: string[],
  ) => {
    if (!sources.length || !current?.sftp || !remote.path) {
      setFileError("请先连接设备并等待远程目录就绪");
      return;
    }
    try {
      await api(
        "files:transfer",
        active,
        direction,
        sources,
        direction === "upload" ? remote.path : local.path,
      );
      setShowQueue(true);
    } catch (e) {
      setFileError((e as Error).message);
    }
  };
  // Browser display order: directories first, then names in natural order
  // ("2" before "10"), shared by rendering and shift-range selection.
  const sortedEntries = (listing: Listing) =>
    [...listing.entries].sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
  const selected = (
    side: "local" | "remote",
    listing: Listing,
    entry: Entry,
    e: React.MouseEvent,
  ) => {
    const update = side === "local" ? setLocalSelection : setRemoteSelection;
    // Range selection follows the order the browser renders (dirs first, then
    // natural-sorted names) so shift ranges match what the user sees.
    const order = sortedEntries(listing).map((x) => x.name);
    const index = order.indexOf(entry.name);
    const anchor = selectionAnchor.current;
    if (e.shiftKey && index >= 0) {
      if (anchor && anchor.side === side) {
        const anchorIndex = order.indexOf(anchor.name);
        const from = anchorIndex >= 0 ? anchorIndex : index;
        const [a, b] = [from, index].sort((x, y) => x - y);
        update(order.slice(a, b + 1));
      } else update([entry.name]);
      return;
    }
    selectionAnchor.current = { side, name: entry.name };
    update((prev) =>
      e.ctrlKey || e.metaKey
        ? prev.includes(entry.name)
          ? prev.filter((n) => n !== entry.name)
          : [...prev, entry.name]
        : [entry.name],
    );
  };
  const openFile = (
    side: "local" | "remote",
    listing: Listing,
    entry: Entry,
  ) => {
    previewTrigger.current = document.activeElement as HTMLElement;
    setPreview({
      sessionId: side === "local" ? null : active,
      path: join(listing.path, entry.name),
      source:
        side === "local" ? "本机" : current?.route.at(-1)?.name || "远程设备",
    });
  };
  const sessionOf = (side: "local" | "remote") =>
    side === "remote" ? active : null;
  const refreshSide = (side: "local" | "remote", dir: string) => {
    focusEntries(side);
    void (side === "local" ? refreshLocal(dir) : refreshRemote(dir));
  };
  const doRename = async (
    side: "local" | "remote",
    listing: Listing,
    entry: Entry,
  ) => {
    if (side === "remote" && !current?.sftp) return;
    const name = await askText(
      "重命名",
      entry.name,
      `将 "${entry.name}" 重命名为：`,
      true,
      side,
    );
    if (!name || name === entry.name) return;
    let target = name,
      overwrite = false;
    if (listing.entries.some((e) => e.name === name)) {
      const c = await askChoice(
        "目标已存在",
        `"${name}" 已存在于当前目录，选择覆盖或自动改名。`,
        [
          { label: "取消", value: "" },
          { label: "覆盖", value: "overwrite" },
          { label: "自动改名", value: "auto" },
        ],
        side,
      );
      if (!c) return;
      if (c === "overwrite") overwrite = true;
      else target = uniqueName(listing.entries, name);
    }
    try {
      await api(
        "files:rename",
        sessionOf(side),
        join(listing.path, entry.name),
        join(listing.path, target),
        overwrite,
      );
      if (!overwrite)
        pushUndo({
          side,
          sessionId: side === "remote" ? active : "",
          kind: "rename",
          from: join(listing.path, entry.name),
          to: join(listing.path, target),
        });
      refreshSide(side, listing.path);
    } catch (e) {
      setFileError((e as Error).message);
    }
  };
  const doDelete = async (
    side: "local" | "remote",
    listing: Listing,
    names: string[],
  ) => {
    if (!names.length) return;
    const detail =
      names.length > 1
        ? `将永久删除 ${names.length} 项（目录会递归删除），此操作不可恢复。`
        : `将永久删除 "${names[0]}"（目录会递归删除），此操作不可恢复。`;
    const c = await askChoice(
      "确认删除",
      detail,
      [
        { label: "取消", value: "" },
        { label: "删除", value: "ok", danger: true },
      ],
      side,
    );
    if (!c) return;
    (side === "local" ? setLocalSelection : setRemoteSelection)([]);
    if (fileClip && fileClip.side === side) {
      const deleted = new Set(names.map((n) => join(listing.path, n)));
      const rest = fileClip.paths.filter((p) => !deleted.has(p));
      setFileClip(rest.length ? { ...fileClip, paths: rest } : null);
    }
    try {
      await api(
        "files:delete",
        sessionOf(side),
        names.map((n) => join(listing.path, n)),
      );
      if (side === "local") refreshSide(side, listing.path);
    } catch (e) {
      setFileError((e as Error).message);
    }
  };
  const doClip = (
    side: "local" | "remote",
    listing: Listing,
    names: string[],
    op: "copy" | "move",
  ) => {
    if (!names.length) return;
    setFileClip({
      side,
      op,
      sessionId: side === "remote" ? active : "",
      paths: names.map((n) => join(listing.path, n)),
    });
  };
  const doPaste = async (side: "local" | "remote", listing: Listing) => {
    if (!fileClip || fileClip.side !== side) {
      setFileError("剪贴板是空的，或内容来自另一侧");
      return;
    }
    if (side === "remote" && fileClip.sessionId !== active) {
      setFileError("剪贴板内容来自其他设备的会话");
      return;
    }
    if (
      fileClip.op === "move" &&
      fileClip.paths.some(
        (p) =>
          p === listing.path || listing.path.startsWith(p.replace(/\/?$/, "/")),
      )
    ) {
      setFileError("不能移动到自身或其子目录");
      return;
    }
    try {
      const r = await api<{
        moved?: { from: string; to: string }[];
        copied?: string[];
        skipped?: number;
        overwritten?: number;
      }>(
        "files:paste",
        sessionOf(side),
        fileClip.op,
        fileClip.paths,
        listing.path,
      );
      if (fileClip.op === "move") setFileClip(null);
      if (side === "local") {
        refreshSide(side, listing.path);
        if (!r.overwritten) {
          if (fileClip.op === "move" && r.moved?.length)
            pushUndo({
              side,
              sessionId: "",
              kind: "move",
              pairs: r.moved,
            });
          else if (fileClip.op === "copy" && r.copied?.length)
            pushUndo({ side, sessionId: "", kind: "copy", paths: r.copied });
        }
      } else setShowQueue(true);
    } catch (e) {
      setFileError((e as Error).message);
    }
  };
  const doNew = async (
    side: "local" | "remote",
    listing: Listing,
    type: "dir" | "file",
  ) => {
    if (side === "remote" && !current?.sftp) return;
    const name = await askText(
      type === "dir" ? "新建文件夹" : "新建文件",
      type === "dir" ? "新建文件夹" : "新建文件.txt",
      undefined,
      false,
      side,
    );
    if (!name) return;
    try {
      const target = await api<string>(
        type === "dir" ? "files:mkdir" : "files:touch",
        sessionOf(side),
        listing.path,
        name,
      );
      pushUndo({
        side,
        sessionId: side === "remote" ? active : "",
        kind: "create",
        paths: [target],
      });
      refreshSide(side, listing.path);
    } catch (e) {
      setFileError((e as Error).message);
    }
  };
  const doUndo = async (side: "local" | "remote") => {
    if (undoBusy.current) return;
    let idx = -1;
    for (let i = undoStack.length - 1; i >= 0; i--) {
      const u = undoStack[i];
      if (u.side === side && (side === "local" || u.sessionId === active)) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return;
    const op = undoStack[idx];
    setUndoStack((s) => s.filter((_, i) => i !== idx));
    undoBusy.current = true;
    const sid = side === "remote" ? op.sessionId : null;
    try {
      if (op.kind === "rename" && op.from && op.to) {
        await api("files:rename", sid, op.to, op.from, false);
      } else if (op.kind === "move" && op.pairs?.length) {
        const groups = new Map<string, string[]>();
        for (const p of op.pairs) {
          const dest =
            p.from.slice(0, Math.max(p.from.lastIndexOf("/"), 0)) || "/";
          const list = groups.get(dest) || [];
          list.push(p.to);
          groups.set(dest, list);
        }
        for (const [dest, tos] of groups)
          await api("files:paste", sid, "move", tos, dest, false);
      } else if (
        (op.kind === "copy" || op.kind === "create") &&
        op.paths?.length
      ) {
        await api("files:delete", sid, op.paths);
      } else return;
      refreshSide(side, side === "local" ? local.path : remote.path);
    } catch (e) {
      setFileError((e as Error).message);
    } finally {
      undoBusy.current = false;
    }
  };
  const doStat = async (
    side: "local" | "remote",
    listing: Listing,
    entry: Entry,
  ) => {
    try {
      const st = await api<FileStat>(
        "files:stat",
        sessionOf(side),
        join(listing.path, entry.name),
      );
      setDialog({
        kind: "stat",
        title: "属性",
        name: entry.name,
        path: join(listing.path, entry.name),
        stat: st,
      });
    } catch (e) {
      setFileError((e as Error).message);
    }
  };
  const showFileMenu = (
    side: "local" | "remote",
    listing: Listing,
    entry?: Entry,
  ) => {
    if (side === "remote" && !current?.sftp) return;
    const sel = side === "local" ? localSelection : remoteSelection;
    if (entry && !sel.includes(entry.name))
      (side === "local" ? setLocalSelection : setRemoteSelection)([entry.name]);
    const names = entry ? (sel.includes(entry.name) ? sel : [entry.name]) : sel;
    void api("files:menu", {
      side,
      hasSelection: names.length > 0,
      selectionCount: names.length,
      entryCount: listing.entries.length,
      isFile:
        names.length === 1
          ? !listing.entries.find((e) => e.name === names[0])?.directory
          : false,
      canPaste:
        !!fileClip &&
        fileClip.side === side &&
        (side === "local" || fileClip.sessionId === active),
      canUndo: undoStack.some(
        (u) => u.side === side && (side === "local" || u.sessionId === active),
      ),
    }).catch(notify);
  };
  fileMenuRef.current = (side, action) => {
    const listing = side === "local" ? local : remote;
    const sel = (side === "local" ? localSelection : remoteSelection).filter(
      (n) => listing.entries.some((e) => e.name === n),
    );
    const single =
      sel.length === 1 ? listing.entries.find((e) => e.name === sel[0]) : null;
    if (action === "newDir") void doNew(side, listing, "dir");
    else if (action === "newFile") void doNew(side, listing, "file");
    else if (action === "cut") doClip(side, listing, sel, "move");
    else if (action === "copy") doClip(side, listing, sel, "copy");
    else if (action === "paste") void doPaste(side, listing);
    else if (action === "undo") void doUndo(side);
    else if (action === "selectAll")
      (side === "local" ? setLocalSelection : setRemoteSelection)(
        listing.entries.map((e) => e.name),
      );
    else if (action === "rename") {
      if (single) void doRename(side, listing, single);
    } else if (action === "delete") void doDelete(side, listing, sel);
    else if (action === "preview") {
      if (single && !single.directory) openFile(side, listing, single);
    } else if (action === "stat") {
      if (single) void doStat(side, listing, single);
    }
  };
  const handleFileKeys = (
    side: "local" | "remote",
    listing: Listing,
    e: React.KeyboardEvent,
  ) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    const sel = (side === "local" ? localSelection : remoteSelection).filter(
      (n) => listing.entries.some((en) => en.name === n),
    );
    const key = e.key.toLowerCase();
    if (e.key === "F5") {
      e.preventDefault();
      refreshSide(side, listing.path);
    } else if (e.key === "F2" && sel.length === 1) {
      e.preventDefault();
      const entry = listing.entries.find((x) => x.name === sel[0]);
      if (entry) void doRename(side, listing, entry);
    } else if (e.key === "Delete" && sel.length) {
      e.preventDefault();
      void doDelete(side, listing, sel);
    } else if ((e.ctrlKey || e.metaKey) && key === "x" && sel.length) {
      e.preventDefault();
      doClip(side, listing, sel, "move");
    } else if ((e.ctrlKey || e.metaKey) && key === "c" && sel.length) {
      e.preventDefault();
      doClip(side, listing, sel, "copy");
    } else if ((e.ctrlKey || e.metaKey) && key === "v") {
      e.preventDefault();
      void doPaste(side, listing);
    } else if ((e.ctrlKey || e.metaKey) && key === "z") {
      e.preventDefault();
      void doUndo(side);
    } else if ((e.ctrlKey || e.metaKey) && key === "a") {
      e.preventDefault();
      (side === "local" ? setLocalSelection : setRemoteSelection)(
        listing.entries.map((en) => en.name),
      );
    }
  };
  const renderBrowser = (side: "local" | "remote") => {
    const listing = side === "local" ? local : remote,
      selection = side === "local" ? localSelection : remoteSelection,
      refresh = side === "local" ? refreshLocal : refreshRemote;
    const ready = side === "local" || current?.sftp;
    const clipNames =
      fileClip &&
      fileClip.side === side &&
      (side === "local" || fileClip.sessionId === active)
        ? new Set(
            fileClip.paths.map(
              (p) => p.split(/[\\/]/).filter(Boolean).pop() || "",
            ),
          )
        : null;
    return (
      <section
        className="browser"
        onKeyDown={(e) => handleFileKeys(side, listing, e)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("application/x-sshto"))
            e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          try {
            const payload = JSON.parse(
              e.dataTransfer.getData("application/x-sshto"),
            );
            if (payload.side !== side && Array.isArray(payload.sources))
              void transfer(
                side === "remote" ? "upload" : "download",
                payload.sources,
              );
          } catch {
            setFileError("请从应用内另一侧文件列表拖入文件");
          }
        }}
      >
        <div className="browser-title">
          {side === "local" ? <Monitor size={15} /> : <Server size={15} />}
          <strong>
            {side === "local"
              ? "本地文件"
              : current?.route.at(-1)?.name || "远程文件"}
          </strong>
          <span>{listing.entries.length} 项</span>
          <button
            title="刷新目录"
            onClick={() => void refresh()}
            disabled={!ready}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <div className="path">
          <button
            title="上级目录"
            disabled={!ready || !listing.path}
            onClick={() => void refresh(join(listing.path, ".."))}
          >
            <ChevronUp size={16} />
          </button>
          <input
            aria-label={side === "local" ? "本地路径" : "远程路径"}
            key={`${side}-${listing.path}`}
            defaultValue={listing.path}
            disabled={!ready}
            placeholder="连接后浏览远程目录"
            onKeyDown={(e) => {
              if (e.key === "Enter") void refresh(e.currentTarget.value);
            }}
          />
        </div>
        <div className="file-head">
          <span>名称</span>
          <span className="file-size">大小</span>
          <span className="file-mtime" title="按本机时区显示">
            修改时间
          </span>
        </div>
        <div
          className="entries"
          tabIndex={0}
          ref={(el) => {
            entriesRef.current[side] = el;
          }}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest(".entry")) return;
            (side === "local" ? setLocalSelection : setRemoteSelection)([]);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            entriesRef.current[side]?.focus();
            showFileMenu(side, listing);
          }}
        >
          {!ready ? (
            <div className="file-empty">
              {current?.sftpMessage || "连接设备后，即可拖拽传输文件"}
            </div>
          ) : remoteLoading && side === "remote" ? (
            <div className="file-empty">正在读取目录…</div>
          ) : listing.entries.length === 0 ? (
            <div className="file-empty">此目录为空</div>
          ) : (
            sortedEntries(listing).map((entry: Entry) => (
              <div
                key={entry.name}
                tabIndex={0}
                role="button"
                aria-label={entry.name}
                className={`entry ${selection.includes(entry.name) ? "selected" : ""} ${
                  clipNames?.has(entry.name)
                    ? fileClip!.op === "move"
                      ? "clip-cut"
                      : "clip-copy"
                    : ""
                }`}
                onClick={(e) => selected(side, listing, entry, e)}
                title={
                  entry.linkError ||
                  (entry.symlink
                    ? entry.directory
                      ? "软链接目录，双击进入"
                      : "软链接文件"
                    : undefined)
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    if (entry.linkError) setFileError(entry.linkError);
                    else if (entry.directory)
                      void refresh(join(listing.path, entry.name));
                    else openFile(side, listing, entry);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  showFileMenu(side, listing, entry);
                }}
                onDoubleClick={() => {
                  if (entry.linkError) setFileError(entry.linkError);
                  else if (entry.directory)
                    void refresh(join(listing.path, entry.name));
                  else if (side === "local")
                    void api(
                      "files:open",
                      join(listing.path, entry.name),
                    ).catch((e) => setFileError(e.message));
                  else openFile(side, listing, entry);
                }}
                draggable={!entry.symlink}
                onDragStart={(e) => {
                  const names = selection.includes(entry.name)
                    ? selection
                    : [entry.name];
                  e.dataTransfer.setData(
                    "application/x-sshto",
                    JSON.stringify({
                      side,
                      sources: names.map((n) => join(listing.path, n)),
                    }),
                  );
                  e.dataTransfer.effectAllowed = "copy";
                }}
              >
                {entry.directory ? (
                  <Folder size={15} className="folder" />
                ) : (
                  <File size={15} />
                )}
                <span>
                  {entry.name}
                  {entry.symlink ? " ↗" : ""}
                </span>
                <small className="file-size">
                  {entry.directory ? "—" : size(entry.size)}
                </small>
                <small className="file-mtime" title="按本机时区显示">
                  {fileTime(entry.mtime)}
                </small>
              </div>
            ))
          )}
        </div>
      </section>
    );
  };
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <TerminalSquare size={22} />
          </div>
          <b>
            ssh<span>To</span>
          </b>
          <small>DESKTOP</small>
        </div>
        <div className="workspace-label">
          工作空间 <span>本地</span>
        </div>
        <div className="search">
          <Search size={15} />
          <input
            aria-label="搜索设备"
            placeholder="搜索设备…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>⌕</kbd>
        </div>
        <div className="section-label">
          我的设备 <span>{devices.length}</span>
          <button title="添加设备" onClick={() => openEditor(blank())}>
            <Plus size={17} />
          </button>
        </div>
        <div className="devices">
          {devices
            .filter((d) =>
              `${d.name} ${d.host}`.toLowerCase().includes(query.toLowerCase()),
            )
            .map((d) => (
              <div className="device" key={d.id}>
                <button
                  className="device-connect"
                  onClick={() => connect(d)}
                  title="连接设备"
                >
                  <span
                    className={`device-icon ${sessions.some((s) => s.deviceId === d.id && s.status === "connected") ? "online" : ""}`}
                  >
                    <Server size={18} />
                  </span>
                  <span>
                    <strong>{d.name}</strong>
                    <small>
                      {d.username}@{d.host}
                    </small>
                  </span>
                </button>
                <button
                  className="edit-device"
                  title={`编辑 ${d.name}`}
                  onClick={() => openEditor(d)}
                >
                  <Settings2 size={14} />
                </button>
              </div>
            ))}
          {devices.length === 0 && (
            <div className="sidebar-empty">
              添加第一台设备，
              <br />
              开启你的远程工作空间。
            </div>
          )}
          <button className="add-device" onClick={() => openEditor(blank())}>
            <Plus size={16} />
            添加设备
          </button>
        </div>
        <div className="sidebar-footer">
          <ShieldCheck size={16} />
          <div>
            凭据保存在本机
            <small>
              {vault ? "系统凭据库已就绪" : "密码仅在本次运行中保留"}
            </small>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <span className="muted">工作空间</span>
            <ChevronRight size={14} />
            <strong>SSH 控制台</strong>
          </div>
          <div className="top-actions">
            <span className="connection-count">
              <i />
              {sessions.filter((s) => s.status === "connected").length} 个连接
            </span>
            <button
              className={split === "horizontal" ? "on" : ""}
              title="左右分屏"
              onClick={() =>
                layout(split === "horizontal" ? "none" : "horizontal")
              }
            >
              <Columns2 size={17} />
            </button>
            <button
              className={split === "vertical" ? "on" : ""}
              title="上下分屏"
              onClick={() => layout(split === "vertical" ? "none" : "vertical")}
            >
              <Rows2 size={17} />
            </button>
            <button
              className={files ? "on" : ""}
              title="文件面板"
              onClick={() => setFiles(!files)}
            >
              <Folder size={17} />
            </button>
          </div>
        </header>
        <div className="tabs">
          {sessions.map((s) => (
            <div
              role="tab"
              aria-selected={active === s.id}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter") activate(s.id);
              }}
              className={`tab ${active === s.id ? "active" : ""}`}
              key={s.id}
              onClick={() => activate(s.id)}
            >
              <span className={`dot ${s.status}`} />
              <TerminalSquare size={14} />
              <span>{s.route.at(-1)?.name}</span>
              <button
                title="关闭终端"
                onClick={(e) => {
                  e.stopPropagation();
                  void close(s.id);
                }}
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <button
            className="new-tab"
            title="新建设备"
            onClick={() => openEditor(blank())}
          >
            <Plus size={17} />
          </button>
        </div>
        <div
          className={`workspace-content ${resizingFiles ? "resizing-files" : ""}`}
          ref={workspaceRef}
        >
          <div
            className={`terminals ${split}`}
            style={{ flex: files ? `${1 - fileRatio} 1 0px` : "1 1 0px" }}
          >
            {sessions.length === 0 ? (
              <div className="welcome">
                <div className="welcome-icon">
                  <TerminalSquare size={40} />
                </div>
                <span className="eyebrow">
                  YOUR NEXT CONNECTION STARTS HERE
                </span>
                <h1>连接设备，打开可能。</h1>
                <p>终端、跳板连接和文件传输，汇聚在一个工作空间。</p>
                <button className="primary" onClick={() => openEditor(blank())}>
                  <Plus size={17} />
                  添加 SSH 设备
                </button>
                <div className="welcome-features">
                  <span>
                    <Columns2 size={17} />
                    多会话分屏
                  </span>
                  <span>
                    <ArrowRight size={17} />
                    多级跳板
                  </span>
                  <span>
                    <ArrowUpDown size={17} />
                    SFTP 互传
                  </span>
                </div>
              </div>
            ) : (
              sessions.map((s) => {
                const visible =
                  split === "none" ? s.id === active : panes.includes(s.id);
                const next = sessions
                  .slice(sessions.indexOf(s) + 1)
                  .find((x) => panes.includes(x.id));
                return (
                  <Fragment key={s.id}>
                    <section
                      className={`terminal-pane ${s.id === active ? "focused" : ""}`}
                      style={{
                        display: visible ? "flex" : "none",
                        flex: weights[s.id] || 1,
                      }}
                      key={s.id}
                      onMouseDown={() => setActive(s.id)}
                    >
                      <div className="route">
                        <span className="route-label">连接路径</span>
                        <span className="route-node">
                          <Monitor size={13} />
                          本机
                        </span>
                        {s.route.map((d, i) => (
                          <span
                            className={`route-node ${s.status === "connected" || (s.hop !== undefined && i < s.hop) ? "reached" : ""}`}
                            key={i}
                          >
                            <ChevronRight size={13} />
                            <Server size={12} />
                            {d.name}
                          </span>
                        ))}
                        <span className={`session-state ${s.status}`}>
                          {label(s.status)}
                        </span>
                        <button
                          title="重新连接"
                          onClick={() => void reconnect(s)}
                        >
                          <RefreshCw size={13} />
                        </button>
                        <button
                          title="断开连接"
                          onClick={() =>
                            void api("sessions:close", s.id).catch(notify)
                          }
                        >
                          <Unplug size={13} />
                        </button>
                      </div>
                      {s.message && s.status !== "connected" && (
                        <div className={`session-message ${s.status}`}>
                          {s.message}
                        </div>
                      )}
                      <Terminal
                        id={s.id}
                        active={active === s.id && visible}
                        onError={notify}
                      />
                    </section>
                    {visible && next && split !== "none" && (
                      <div
                        className="pane-resizer"
                        role="separator"
                        aria-label="调整分屏大小"
                        onPointerDown={(e) => resizePanes(e, s.id, next.id)}
                      />
                    )}
                  </Fragment>
                );
              })
            )}
          </div>
          {files && (
            <>
              <div
                className="file-panel-resizer"
                role="separator"
                aria-label="调整文件管理高度"
                aria-orientation="horizontal"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(fileRatio * 100)}
                tabIndex={0}
                title="上下拖拽调整文件管理高度，双击恢复默认比例"
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  fileDrag.current = {
                    startY: e.clientY,
                    ratio: fileRatio,
                    height: workspaceRef.current!.clientHeight - 8,
                  };
                  setResizingFiles(true);
                }}
                onPointerMove={(e) => {
                  const drag = fileDrag.current;
                  if (drag)
                    setFileRatio(
                      clampFileRatio(
                        drag.ratio + (drag.startY - e.clientY) / drag.height,
                        drag.height,
                      ),
                    );
                }}
                onPointerUp={(e) => {
                  fileDrag.current = null;
                  setResizingFiles(false);
                  if (e.currentTarget.hasPointerCapture(e.pointerId))
                    e.currentTarget.releasePointerCapture(e.pointerId);
                }}
                onLostPointerCapture={() => {
                  fileDrag.current = null;
                  setResizingFiles(false);
                }}
                onDoubleClick={() => setFileRatio(0.5)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                    e.preventDefault();
                    const height = workspaceRef.current!.clientHeight - 8;
                    setFileRatio((r) =>
                      clampFileRatio(
                        r + (e.key === "ArrowUp" ? 0.05 : -0.05),
                        height,
                      ),
                    );
                  }
                }}
              >
                <span />
              </div>
              <div
                className="file-panel"
                style={{ flex: `${fileRatio} 1 0px` }}
              >
                <div className="panel-heading">
                  <div>
                    <Folder size={16} />
                    <strong>文件管理</strong>
                    <span className="badge">SFTP</span>
                  </div>
                  <div>
                    <button
                      disabled={!localSelection.length || !current?.sftp}
                      onClick={() =>
                        void transfer(
                          "upload",
                          localSelection.map((n) => join(local.path, n)),
                        )
                      }
                    >
                      <Upload size={14} />
                      上传
                    </button>
                    <button
                      disabled={!remoteSelection.length || !current?.sftp}
                      onClick={() =>
                        void transfer(
                          "download",
                          remoteSelection.map((n) => join(remote.path, n)),
                        )
                      }
                    >
                      <Download size={14} />
                      下载
                    </button>
                    <button
                      className={showQueue ? "on" : ""}
                      onClick={() => setShowQueue(!showQueue)}
                    >
                      <ArrowUpDown size={14} />
                      传输队列
                      {tasks.filter((t) => t.status === "running").length >
                        0 && (
                        <span className="badge">
                          {tasks.filter((t) => t.status === "running").length}
                        </span>
                      )}
                    </button>
                    <button
                      title="关闭文件面板"
                      onClick={() => setFiles(false)}
                    >
                      <X size={15} />
                    </button>
                  </div>
                </div>
                {fileError && (
                  <div className="file-error">
                    {fileError}
                    <button title="关闭错误" onClick={() => setFileError("")}>
                      <X size={13} />
                    </button>
                  </div>
                )}
                {showQueue ? (
                  <div className="queue">
                    {tasks.length === 0 ? (
                      <div className="file-empty">
                        暂无传输任务。从文件列表拖到另一侧即可开始。
                      </div>
                    ) : (
                      [...tasks].reverse().map((t) => (
                        <div className="task" key={t.id}>
                          <span className={`task-icon ${t.status}`}>
                            {t.status === "done" ? (
                              <Check size={18} />
                            ) : t.direction === "upload" ? (
                              <Upload size={18} />
                            ) : t.direction === "download" ? (
                              <Download size={18} />
                            ) : t.direction === "remote-copy" ? (
                              <Copy size={18} />
                            ) : t.direction === "remote-move" ? (
                              <Scissors size={18} />
                            ) : (
                              <Trash2 size={18} />
                            )}
                          </span>
                          <div className="task-info">
                            <strong>
                              {t.sources
                                .map((s) =>
                                  s.split(/[\\/]/).filter(Boolean).at(-1),
                                )
                                .join(", ")}
                            </strong>
                            <small>
                              {sessions
                                .find((s) => s.id === t.sessionId)
                                ?.route.at(-1)?.name || "已关闭的会话"}
                              {t.direction === "upload"
                                ? ` · 上传至 ${t.destination}`
                                : t.direction === "download"
                                  ? ` · 下载至 ${t.destination}`
                                  : t.direction === "remote-delete"
                                    ? " · 递归删除"
                                    : ` · ${t.direction === "remote-copy" ? "复制到" : "移动到"} ${t.destination}`}
                            </small>
                            <progress
                              max={Math.max(t.total, 1)}
                              value={
                                t.status === "done"
                                  ? Math.max(t.total, 1)
                                  : t.bytes
                              }
                            />
                          </div>
                          <div className="task-status">
                            {label(t.status)}
                            <small>
                              {size(t.bytes)} / {size(t.total)}
                              {t.status === "running" && t.started
                                ? ` · ${size(t.bytes / Math.max(1, (Date.now() - t.started) / 1000))}/s`
                                : ""}
                            </small>
                            {t.message && <small>{t.message}</small>}
                          </div>
                          {["running", "queued"].includes(t.status) ? (
                            <button
                              title="取消传输"
                              onClick={() =>
                                void api("files:cancel", t.id).catch(notify)
                              }
                            >
                              <X size={16} />
                            </button>
                          ) : ["error", "cancelled"].includes(t.status) &&
                            ["upload", "download"].includes(t.direction) ? (
                            <button
                              title="重试传输"
                              onClick={() =>
                                void api(
                                  "files:transfer",
                                  t.sessionId,
                                  t.direction,
                                  t.sources,
                                  t.destination,
                                ).catch(notify)
                              }
                            >
                              <RefreshCw size={16} />
                            </button>
                          ) : null}
                        </div>
                      ))
                    )}
                  </div>
                ) : (
                  <div className="browsers">
                    {renderBrowser("local")}
                    <div className="transfer-divider">
                      <ArrowUpDown size={15} />
                    </div>
                    {renderBrowser("remote")}
                  </div>
                )}
                <div className="file-hint">
                  拖拽文件或文件夹到另一侧进行传输 · Ctrl + 点击可多选{" "}
                  <span>目标：{current?.route.at(-1)?.name || "未连接"}</span>
                </div>
              </div>
            </>
          )}
        </div>
        <footer className="statusbar">
          <span>
            <span className="dot connected" />
            sshTo <span className="version">v1.0.0</span>
          </span>
          <span>
            {current
              ? `${current.route.at(-1)?.host} · ${label(current.status)}`
              : "准备就绪"}
            <span className="status-separator">|</span>SSH2 / SFTP
          </span>
        </footer>
      </main>
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button title="关闭提示" onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {preview && (
        <FilePreview
          file={preview}
          onClose={() => {
            setPreview(null);
            requestAnimationFrame(() => previewTrigger.current?.focus());
          }}
        />
      )}
      {dialog?.kind === "text" && (
        <div className="overlay">
          <form
            className="modal"
            onSubmit={(e) => {
              e.preventDefault();
              const v = dialogInputRef.current?.value.trim() || "";
              dialog.resolve(v || null);
              setDialog(null);
              focusEntries(dialog.side);
            }}
          >
            <div className="modal-title">
              <div className="modal-icon">
                <Pencil size={22} />
              </div>
              <div>
                <h2>{dialog.title}</h2>
                {dialog.detail && <p>{dialog.detail}</p>}
              </div>
              <button
                type="button"
                title="关闭"
                onClick={() => {
                  dialog.resolve(null);
                  setDialog(null);
                  focusEntries(dialog.side);
                }}
              >
                <X size={18} />
              </button>
            </div>
            <label>
              名称
              <input
                ref={dialogInputRef}
                autoFocus
                required
                defaultValue={dialog.initial}
                onFocus={(e) => {
                  const input = e.currentTarget;
                  if (dialog.selectBase) {
                    const dot = dialog.initial.lastIndexOf(".");
                    input.setSelectionRange(
                      0,
                      dot > 0 ? dot : dialog.initial.length,
                    );
                  } else input.select();
                }}
              />
            </label>
            <div className="modal-footer">
              <span />
              <button
                type="button"
                onClick={() => {
                  dialog.resolve(null);
                  setDialog(null);
                  focusEntries(dialog.side);
                }}
              >
                取消
              </button>
              <button type="submit" onClick={() => focusEntries(dialog.side)}>
                确定
              </button>
            </div>
          </form>
        </div>
      )}
      {dialog?.kind === "choice" && (
        <div className="overlay">
          <div
            ref={modalRef}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={dialog.title}
            tabIndex={-1}
            onKeyDown={(e) =>
              modalKeyDown(
                e,
                () => {
                  dialog.resolve(dialog.actions.at(-1)!.value);
                  setDialog(null);
                  focusEntries(dialog.side);
                },
                () => {
                  dialog.resolve(dialog.actions[0]?.value ?? "");
                  setDialog(null);
                  focusEntries(dialog.side);
                },
              )
            }
          >
            <div className="modal-title">
              <div className="modal-icon">
                <Info size={22} />
              </div>
              <div>
                <h2>{dialog.title}</h2>
                <p>{dialog.detail}</p>
              </div>
              <button
                type="button"
                title="关闭"
                onClick={() => {
                  dialog.resolve("");
                  setDialog(null);
                  focusEntries(dialog.side);
                }}
              >
                <X size={18} />
              </button>
            </div>
            <div className="modal-footer">
              <span />
              {dialog.actions.map((a) => (
                <button
                  key={a.value}
                  className={a.danger ? "danger" : ""}
                  onClick={() => {
                    dialog.resolve(a.value);
                    setDialog(null);
                    focusEntries(dialog.side);
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {dialog?.kind === "stat" && (
        <div className="overlay">
          <div
            ref={modalRef}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="文件属性"
            tabIndex={-1}
            onKeyDown={(e) => modalKeyDown(e, null, () => setDialog(null))}
          >
            <div className="modal-title">
              <div className="modal-icon">
                <Info size={22} />
              </div>
              <div>
                <h2>属性</h2>
                <p>{dialog.name}</p>
              </div>
              <button title="关闭" onClick={() => setDialog(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="stat-list">
              <span>路径</span>
              <code>{dialog.path}</code>
              <span>类型</span>
              <span>{dialog.stat.directory ? "目录" : "文件"}</span>
              <span>大小</span>
              <span>
                {dialog.stat.directory ? "—" : size(dialog.stat.size)}
              </span>
              <span>修改时间</span>
              <span>{fileTime(dialog.stat.mtime)}</span>
              <span>权限</span>
              <span>{perms(dialog.stat.mode)}</span>
              <span>所有者</span>
              <span>
                {dialog.stat.uid} / {dialog.stat.gid}
              </span>
            </div>
            <div className="modal-footer">
              <span />
              <button onClick={() => setDialog(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
      {editing && (
        <div className="overlay">
          <form className="modal" onSubmit={save}>
            <div className="modal-title">
              <div className="modal-icon">
                <Server size={22} />
              </div>
              <div>
                <h2>{editing.id ? "编辑设备" : "添加 SSH 设备"}</h2>
                <p>配置连接信息，建立你的远程工作空间。</p>
              </div>
              <button
                type="button"
                title="关闭"
                onClick={() => setEditing(null)}
              >
                <X size={18} />
              </button>
            </div>
            <label>
              设备名称
              <input
                autoFocus
                required
                placeholder="例如：开发服务器"
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </label>
            <div className="form-row">
              <label>
                主机 / IP 地址
                <input
                  required
                  placeholder="192.168.1.100"
                  value={editing.host}
                  onChange={(e) =>
                    setEditing({ ...editing, host: e.target.value })
                  }
                />
              </label>
              <label className="port">
                端口
                <input
                  required
                  type="number"
                  min="1"
                  max="65535"
                  value={editing.port}
                  onChange={(e) =>
                    setEditing({ ...editing, port: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <label>
              用户名
              <input
                required
                value={editing.username}
                onChange={(e) =>
                  setEditing({ ...editing, username: e.target.value })
                }
              />
            </label>
            <div className="auth-tabs">
              <button
                type="button"
                className={editing.auth === "password" ? "selected" : ""}
                onClick={() => setEditing({ ...editing, auth: "password" })}
              >
                <KeyRound size={14} />
                密码登录
              </button>
              <button
                type="button"
                className={editing.auth === "key" ? "selected" : ""}
                onClick={() => setEditing({ ...editing, auth: "key" })}
              >
                <ShieldCheck size={14} />
                私钥登录
              </button>
            </div>
            {editing.auth === "key" && (
              <label>
                私钥文件
                <div className="input-button">
                  <input
                    required
                    value={editing.keyPath}
                    onChange={(e) =>
                      setEditing({ ...editing, keyPath: e.target.value })
                    }
                  />
                  <button
                    type="button"
                    onClick={() =>
                      void api<string | null>("dialog:key")
                        .then((p) => {
                          if (p) setEditing({ ...editing, keyPath: p });
                        })
                        .catch(notify)
                    }
                  >
                    选择文件
                  </button>
                </div>
              </label>
            )}
            <label>
              {editing.auth === "key" ? "私钥口令（可选）" : "登录密码"}
              <input
                type="password"
                autoComplete="new-password"
                value={secret}
                placeholder={
                  editing.hasSecret
                    ? "已配置，留空保留现有凭据"
                    : "输入密码或连接时填写"
                }
                onChange={(e) => setSecret(e.target.value)}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={remember}
                disabled={!vault}
                onChange={(e) => setRemember(e.target.checked)}
              />
              通过系统凭据库保存密码{!vault && <small>当前不可用</small>}
            </label>
            <div className="jump-heading">
              <label>
                跳板路径 <small>按顺序连接，最后到达此设备</small>
              </label>
              <button
                type="button"
                disabled={
                  !devices.some(
                    (d) => d.id !== editing.id && !editing.jumps.includes(d.id),
                  )
                }
                onClick={() => {
                  const d = devices.find(
                    (d) => d.id !== editing.id && !editing.jumps.includes(d.id),
                  );
                  if (d)
                    setEditing({ ...editing, jumps: [...editing.jumps, d.id] });
                }}
              >
                <Plus size={14} />
                添加跳板
              </button>
            </div>
            {editing.jumps.length === 0 ? (
              <div className="jump-empty">
                本机 <ArrowRight size={13} /> 直接连接目标设备
              </div>
            ) : (
              editing.jumps.map((id, i) => (
                <div className="jump-row" key={i}>
                  <span>{i + 1}</span>
                  <select
                    aria-label={`第 ${i + 1} 级跳板`}
                    value={id}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        jumps: editing.jumps.map((v, j) =>
                          j === i ? e.target.value : v,
                        ),
                      })
                    }
                  >
                    {devices
                      .filter(
                        (d) =>
                          d.id !== editing.id &&
                          (!editing.jumps.includes(d.id) || d.id === id),
                      )
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} · {d.host}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    title="上移跳板"
                    disabled={i === 0}
                    onClick={() => {
                      const jumps = [...editing.jumps];
                      [jumps[i - 1], jumps[i]] = [jumps[i], jumps[i - 1]];
                      setEditing({ ...editing, jumps });
                    }}
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button
                    type="button"
                    title="移除跳板"
                    onClick={() =>
                      setEditing({
                        ...editing,
                        jumps: editing.jumps.filter((_, j) => j !== i),
                      })
                    }
                  >
                    <X size={14} />
                  </button>
                </div>
              ))
            )}
            <div className="modal-footer">
              {editing.id && (
                <button
                  className="danger"
                  type="button"
                  onClick={() => {
                    if (window.confirm(`删除设备“${editing.name}”？`))
                      void api("devices:remove", editing.id)
                        .then(() => {
                          setEditing(null);
                          void refreshDevices();
                        })
                        .catch(notify);
                  }}
                >
                  <Trash2 size={14} />
                  删除设备
                </button>
              )}
              <span />
              <button type="button" onClick={() => setEditing(null)}>
                取消
              </button>
              <button className="primary" type="submit" disabled={busy}>
                {busy ? "保存中…" : "保存设备"}
              </button>
            </div>
          </form>
        </div>
      )}
      {credentials && (
        <div className="overlay">
          <form
            className="modal credential-modal"
            onSubmit={(e) => {
              e.preventDefault();
              void start(credentials.target, passwords);
            }}
          >
            <div className="modal-title">
              <KeyRound size={22} />
              <div>
                <h2>连接认证</h2>
                <p>为连接路径中的设备输入凭据，仅本次连接使用。</p>
              </div>
              <button
                type="button"
                title="关闭"
                onClick={() => setCredentials(null)}
              >
                <X size={18} />
              </button>
            </div>
            {credentials.route.map((d) => (
              <label key={d.id}>
                {d.name} · {d.username}@{d.host}
                <input
                  autoFocus
                  type="password"
                  placeholder={
                    d.auth === "key" ? "私钥口令（无口令可留空）" : "登录密码"
                  }
                  value={passwords[d.id] || ""}
                  onChange={(e) =>
                    setPasswords({ ...passwords, [d.id]: e.target.value })
                  }
                />
              </label>
            ))}
            <div className="modal-footer">
              <span />
              <button type="button" onClick={() => setCredentials(null)}>
                取消
              </button>
              <button className="primary" type="submit">
                连接设备
                <ArrowRight size={15} />
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
