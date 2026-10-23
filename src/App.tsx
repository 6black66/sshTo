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
export default function App() {
  const [preview, setPreview] = useState<PreviewSource | null>(null);
  const previewTrigger = useRef<HTMLElement | null>(null);
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
    [busy, setBusy] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
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
    void api<Listing>("files:list", null, "").then(setLocal).catch(notify);
    return window.sshTo.subscribe((e) => {
      if (e.type === "clipboard-error") setError(e.message || "剪贴板操作失败");
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
      if (e.type === "transfer" && e.task)
        setTasks((all) => [...all.filter((t) => t.id !== e.task!.id), e.task!]);
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
      void api<Listing>("files:list", current.id, ".")
        .then((r) => {
          if (!cancelled) setRemote(r);
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
    try {
      const r = await api<Listing>("files:list", null, dir);
      setLocal(r);
      setLocalSelection([]);
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
      if (id === activeRef.current) {
        setRemote(r);
        setRemoteSelection([]);
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
  const selected = (
    side: "local" | "remote",
    name: string,
    e: React.MouseEvent,
  ) => {
    const update = side === "local" ? setLocalSelection : setRemoteSelection;
    update((prev) =>
      e.ctrlKey || e.metaKey
        ? prev.includes(name)
          ? prev.filter((n) => n !== name)
          : [...prev, name]
        : [name],
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
  const renderBrowser = (side: "local" | "remote") => {
    const listing = side === "local" ? local : remote,
      selection = side === "local" ? localSelection : remoteSelection,
      refresh = side === "local" ? refreshLocal : refreshRemote;
    const ready = side === "local" || current?.sftp;
    return (
      <section
        className="browser"
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
        <div className="entries">
          {!ready ? (
            <div className="file-empty">
              {current?.sftpMessage || "连接设备后，即可拖拽传输文件"}
            </div>
          ) : remoteLoading && side === "remote" ? (
            <div className="file-empty">正在读取目录…</div>
          ) : listing.entries.length === 0 ? (
            <div className="file-empty">此目录为空</div>
          ) : (
            [...listing.entries]
              .sort(
                (a, b) =>
                  Number(b.directory) - Number(a.directory) ||
                  a.name.localeCompare(b.name),
              )
              .map((entry: Entry) => (
                <div
                  key={entry.name}
                  tabIndex={0}
                  role="button"
                  aria-label={entry.name}
                  className={`entry ${selection.includes(entry.name) ? "selected" : ""}`}
                  onClick={(e) => selected(side, entry.name, e)}
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
                  onDoubleClick={() => {
                    if (entry.linkError) setFileError(entry.linkError);
                    else if (entry.directory)
                      void refresh(join(listing.path, entry.name));
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
                            ) : (
                              <Download size={18} />
                            )}
                          </span>
                          <div className="task-info">
                            <strong>
                              {t.sources
                                .map((s) => s.split("/").at(-1))
                                .join(", ")}
                            </strong>
                            <small>
                              {sessions
                                .find((s) => s.id === t.sessionId)
                                ?.route.at(-1)?.name || "已关闭的会话"}{" "}
                              · {t.direction === "upload" ? "上传至" : "下载至"}{" "}
                              {t.destination}
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
                          ) : ["error", "cancelled"].includes(t.status) ? (
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
