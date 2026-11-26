const { Client } = require("ssh2");
const { PreviewReader } = require("./preview.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

function validateDevice(d) {
  if (
    !d ||
    typeof d.name !== "string" ||
    !d.name.trim() ||
    typeof d.host !== "string" ||
    !d.host.trim() ||
    typeof d.username !== "string" ||
    !d.username.trim()
  )
    throw Error("请填写名称、主机和用户名");
  if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535)
    throw Error("端口必须在 1–65535 之间");
  if (!["password", "key"].includes(d.auth)) throw Error("认证方式无效");
  if (d.auth === "key" && !d.keyPath) throw Error("请选择私钥");
  if (!Array.isArray(d.jumps) || d.jumps.some((x) => typeof x !== "string"))
    throw Error("跳板路径无效");
  return {
    id: d.id || crypto.randomUUID(),
    name: d.name.trim(),
    host: d.host.trim(),
    port: d.port,
    username: d.username.trim(),
    auth: d.auth,
    keyPath: d.keyPath || "",
    jumps: d.jumps,
  };
}
function routeFor(target, devices) {
  const route = [
    ...target.jumps.map((id) => {
      const d = devices.find((x) => x.id === id);
      if (!d) throw Error("跳板设备已被删除");
      return d;
    }),
    target,
  ];
  if (new Set(route.map((x) => x.id)).size !== route.length)
    throw Error("跳板路径不能包含重复设备或目标自身");
  return route;
}
class Store {
  constructor(dir, vault) {
    this.dir = dir;
    this.vault = vault;
    this.data = { version: 1, devices: [], secrets: {}, hosts: {} };
    this.memory = new Map();
    this.queue = Promise.resolve();
  }
  async init() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      this.data = JSON.parse(
        await fs.readFile(path.join(this.dir, "config.json"), "utf8"),
      );
      if (this.data.version !== 1 || !Array.isArray(this.data.devices))
        throw Error("配置格式无效");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  async persist() {
    const snapshot = JSON.stringify(this.data, null, 2);
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        const file = path.join(this.dir, "config.json");
        await fs.writeFile(file + ".tmp", snapshot, { mode: 0o600 });
        await fs.rename(file + ".tmp", file);
      });
    this.queue = operation;
    return operation;
  }
  list() {
    return this.data.devices.map((d) => ({
      ...d,
      hasSecret: this.memory.has(d.id) || !!this.data.secrets[d.id],
      savedSecret: !!this.data.secrets[d.id],
    }));
  }
  async save(raw, secret, remember) {
    const d = validateDevice(raw);
    routeFor(d, [...this.data.devices.filter((x) => x.id !== d.id), d]);
    if (remember && secret && !this.vault.available())
      throw Error("系统凭据库不可用，请关闭“保存密码”后重试");
    const previous = this.data.devices.find((x) => x.id === d.id);
    if (
      previous &&
      (previous.auth !== d.auth || previous.keyPath !== d.keyPath)
    ) {
      this.memory.delete(d.id);
      delete this.data.secrets[d.id];
    }
    if (typeof secret === "string") {
      this.memory.set(d.id, secret);
      if (remember && secret)
        this.data.secrets[d.id] = await this.vault.encrypt(secret);
      else delete this.data.secrets[d.id];
    } else if (!remember) delete this.data.secrets[d.id];
    this.data.devices = this.data.devices
      .filter((x) => x.id !== d.id)
      .concat(d);
    await this.persist();
    return d;
  }
  async remove(id) {
    if (this.data.devices.some((d) => d.jumps.includes(id)))
      throw Error("此设备被跳板路径引用，请先修改关联设备");
    this.data.devices = this.data.devices.filter((d) => d.id !== id);
    delete this.data.secrets[id];
    this.memory.delete(id);
    await this.persist();
  }
  async secret(id) {
    if (this.memory.has(id)) return this.memory.get(id);
    if (this.data.secrets[id]) {
      if (!this.vault.available())
        throw Error("请解锁系统凭据库，或重新输入密码");
      return this.vault.decrypt(this.data.secrets[id]);
    }
    return "";
  }
}
const call = (obj, method, ...args) =>
  new Promise((resolve, reject) =>
    obj[method](...args, (e, result) => (e ? reject(e) : resolve(result))),
  );
function linkFailure(error) {
  if (error.code === "ENOENT" || error.code === 2) return "软链接目标不存在";
  if (error.code === "ELOOP") return "软链接循环或层级过深";
  return "无法访问软链接目标：" + error.message;
}
class SSHService extends EventEmitter {
  constructor(store, approve) {
    super();
    this.store = store;
    this.approve = approve;
    this.sessions = new Map();
    this.tasks = new Map();
    this.jobs = new Map();
    this.previews = new PreviewReader((id) => this.sftp(id));
  }
  event(type, data) {
    this.emit("event", { type, ...data });
  }
  async connect(deviceId, credentials = {}) {
    const target = this.store.data.devices.find((d) => d.id === deviceId);
    if (!target) throw Error("设备不存在");
    const route = routeFor(target, this.store.data.devices),
      id = crypto.randomUUID();
    const session = {
      id,
      deviceId,
      route,
      clients: [],
      status: "connecting",
      closed: false,
    };
    this.sessions.set(id, session);
    // Return the ID before connection events so the renderer can subscribe/render first.
    setTimeout(
      () => this.open(session, credentials).catch((e) => this.fail(session, e)),
      20,
    );
    return {
      id,
      deviceId,
      route: route.map((d) => ({ id: d.id, name: d.name, host: d.host })),
      status: "connecting",
    };
  }
  async open(s, credentials) {
    let sock;
    for (let i = 0; i < s.route.length; i++) {
      if (s.closed) return;
      const d = s.route[i];
      s.hop = i;
      this.event("status", {
        id: s.id,
        status: "connecting",
        hop: i,
        message: `正在连接 ${d.name}`,
      });
      const secret = credentials[d.id] ?? (await this.store.secret(d.id));
      const options = {
        host: d.host,
        port: d.port,
        username: d.username,
        readyTimeout: 20000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        sock,
      };
      if (d.auth === "key") {
        options.privateKey = await fs.readFile(d.keyPath);
        options.passphrase = secret || undefined;
      } else {
        options.password = secret;
        options.tryKeyboard = true;
      }
      options.hostVerifier = (key, cb) => {
        const fingerprint =
          "SHA256:" +
          crypto
            .createHash("sha256")
            .update(key)
            .digest("base64")
            .replace(/=+$/, "");
        const host = `[${d.host}]:${d.port}`;
        const old = this.store.data.hosts[host];
        (async () => {
          if (old === fingerprint) return true;
          const ok = await this.approve({
            kind: "host",
            name: d.name,
            host,
            fingerprint,
            previous: old || null,
          });
          if (!ok || s.closed) return false;
          this.store.data.hosts[host] = fingerprint;
          await this.store.persist();
          return true;
        })().then(cb, () => cb(false));
      };
      const client = new Client();
      s.clients.push(client);
      client.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => {
        finish(prompts.map(() => secret));
      });
      await new Promise((resolve, reject) => {
        client.once("ready", resolve);
        client.on("error", (e) => {
          reject(e);
          if (s.status === "connected") this.fail(s, e);
        });
        client.on("close", () => {
          reject(Error(`${d.name} 连接已关闭`));
          if (!s.closed) this.fail(s, Error(`${d.name} 连接已断开`));
        });
        client.connect(options);
      });
      this.event("hop", { id: s.id, hop: i });
      if (s.closed) {
        client.end();
        return;
      }
      if (i < s.route.length - 1) {
        const next = s.route[i + 1];
        sock = await call(
          client,
          "forwardOut",
          "127.0.0.1",
          0,
          next.host,
          next.port,
        );
      }
    }
    const last = s.clients.at(-1);
    s.shell = await call(last, "shell", {
      term: "xterm-256color",
      cols: 100,
      rows: 30,
    });
    s.shell.on("data", (data) =>
      this.event("data", { id: s.id, data: data.toString("base64") }),
    );
    s.shell.stderr.on("data", (data) =>
      this.event("data", { id: s.id, data: data.toString("base64") }),
    );
    s.shell.on("close", () => {
      if (!s.closed) this.fail(s, Error("终端已退出"));
    });
    if (s.closed) {
      s.shell.destroy();
      return;
    }
    s.status = "connected";
    this.event("status", {
      id: s.id,
      status: "connected",
      hop: s.route.length - 1,
      message: "已连接",
    });
    try {
      s.sftp = await call(last, "sftp");
      this.event("sftp", { id: s.id, available: true });
    } catch (e) {
      this.event("sftp", {
        id: s.id,
        available: false,
        message: "此设备未提供 SFTP：" + e.message,
      });
    }
  }
  fail(s, e) {
    if (s.closed) return;
    this.event("status", {
      id: s.id,
      status: "error",
      hop: s.hop,
      message: `${s.route[s.hop || 0].name}：${e.message}`,
    });
    this.close(s.id, false);
  }
  close(id, notify = true) {
    this.previews.cancelSession(id);
    const s = this.sessions.get(id);
    if (!s) return;
    s.closed = true;
    for (const t of this.tasks.values())
      if (t.sessionId === id) this.cancel(t.id);
    s.shell?.destroy();
    const pending = [...this.tasks.values()]
      .filter((t) => t.sessionId === id)
      .map((t) => this.jobs.get(t.id))
      .filter(Boolean);
    const release = () => {
      s.sftp?.end();
      for (const c of [...s.clients].reverse()) c.end();
    };
    // Keep SFTP alive until cancelled jobs have removed their temporary files.
    if (pending.length) Promise.allSettled(pending).then(release);
    else release();
    this.sessions.delete(id);
    if (notify)
      this.event("status", { id, status: "disconnected", message: "已断开" });
  }
  input(id, data) {
    const s = this.sessions.get(id);
    if (s?.status === "connected") s.shell.write(data);
  }
  resize(id, cols, rows) {
    this.sessions
      .get(id)
      ?.shell?.setWindow(Math.max(1, rows), Math.max(1, cols), 0, 0);
  }
  sftp(id) {
    const s = this.sessions.get(id);
    if (!s?.sftp || s.closed) throw Error("SFTP 尚未就绪");
    return s.sftp;
  }
  async list(id, dir) {
    if (id) {
      const ftp = this.sftp(id);
      const resolved = await call(ftp, "realpath", dir || ".");
      const items = await call(ftp, "readdir", resolved);
      return {
        path: resolved,
        entries: await Promise.all(
          items
            .filter((x) => ![".", ".."].includes(x.filename))
            .map(async (x) => {
              let attrs = x.attrs,
                linkError;
              const symlink = attrs.isSymbolicLink();
              if (symlink) {
                try {
                  attrs = await call(
                    ftp,
                    "stat",
                    path.posix.join(resolved, x.filename),
                  );
                } catch (e) {
                  linkError = linkFailure(e);
                }
              }
              return {
                name: x.filename,
                directory: attrs.isDirectory(),
                symlink,
                size: attrs.size,
                mtime:
                  typeof attrs.mtime === "number" ? attrs.mtime * 1000 : null,
                linkError,
              };
            }),
        ),
      };
    }
    const resolved = path.resolve(dir || require("node:os").homedir());
    const items = await fs.readdir(resolved, { withFileTypes: true });
    const entries = await Promise.all(
      items.map(async (x) => {
        const fullPath = path.join(resolved, x.name);
        const st = await fs.lstat(fullPath);
        let attrs = st,
          linkError;
        if (st.isSymbolicLink()) {
          try {
            attrs = await fs.stat(fullPath);
          } catch (e) {
            linkError = linkFailure(e);
          }
        }
        return {
          name: x.name,
          directory: attrs.isDirectory(),
          symlink: st.isSymbolicLink(),
          size: attrs.size,
          mtime: attrs.mtimeMs,
          linkError,
        };
      }),
    );
    return { path: resolved, entries };
  }
  async transfer(sessionId, direction, sources, destination) {
    if (
      !["upload", "download"].includes(direction) ||
      !Array.isArray(sources) ||
      !sources.length ||
      sources.some((p) => typeof p !== "string") ||
      typeof destination !== "string"
    )
      throw Error("传输参数无效");
    this.sftp(sessionId);
    const id = crypto.randomUUID();
    const task = {
      id,
      sessionId,
      direction,
      sources,
      destination,
      status: "queued",
      bytes: 0,
      total: 0,
      cancelled: false,
      skipped: 0,
    };
    this.tasks.set(id, task);
    this.event("transfer", { task: { ...task } });
    const job = this.run(task)
      .catch((e) => {
        task.status = task.cancelled ? "cancelled" : "error";
        task.message = e.message;
        this.event("transfer", { task: { ...task, streams: undefined } });
      })
      .finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    return id;
  }
  cancel(id) {
    const t = this.tasks.get(id);
    if (t) {
      t.cancelled = true;
      for (const stream of t.streams || []) stream.destroy(Error("传输已取消"));
    }
  }
  validName(name) {
    if (
      typeof name !== "string" ||
      !name.trim().length ||
      name === "." ||
      name === ".." ||
      /[/\\]/.test(name)
    )
      throw Error("名称不能为空或包含路径分隔符");
    return name;
  }
  async rmRemote(ftp, src) {
    let st;
    try {
      st = await call(ftp, "lstat", src);
    } catch (e) {
      if (e.code === 2) return;
      throw e;
    }
    if (st.isDirectory() && !st.isSymbolicLink()) {
      const items = await call(ftp, "readdir", src);
      for (const x of items)
        if (![".", ".."].includes(x.filename))
          await this.rmRemote(ftp, path.posix.join(src, x.filename));
      await call(ftp, "rmdir", src);
    } else await call(ftp, "unlink", src);
  }
  async remoteRename(ftp, src, dst) {
    try {
      await call(ftp, "rename", src, dst);
    } catch (e) {
      await call(ftp, "ext_openssh_rename", src, dst).catch(() => {
        throw e;
      });
    }
  }
  async replaceRemote(ftp, src, dst) {
    let existed = false;
    const bak = dst + ".sshto-bak-" + crypto.randomUUID();
    try {
      await call(ftp, "lstat", dst);
      existed = true;
    } catch (e) {
      if (e.code !== 2) throw e;
    }
    if (existed) await this.remoteRename(ftp, dst, bak);
    try {
      await this.remoteRename(ftp, src, dst);
    } catch (e) {
      if (existed) await this.remoteRename(ftp, bak, dst).catch(() => {});
      throw e;
    }
    if (existed) await this.rmRemote(ftp, bak);
    return existed;
  }
  async rename(id, src, dst, overwrite = false) {
    if (typeof src !== "string" || typeof dst !== "string" || !src || !dst)
      throw Error("重命名参数无效");
    if (src === dst) throw Error("源和目标相同");
    if (id) {
      const ftp = this.sftp(id);
      this.validName(path.posix.basename(dst));
      if (overwrite) {
        await this.replaceRemote(ftp, src, dst);
        return;
      }
      try {
        await call(ftp, "lstat", dst);
        throw Error("目标已存在");
      } catch (e) {
        if (e.code !== 2) throw e;
      }
      await this.remoteRename(ftp, src, dst);
    } else {
      this.validName(path.basename(dst));
      let existed = false;
      if (overwrite) {
        try {
          await fs.lstat(dst);
          existed = true;
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
      } else {
        try {
          await fs.lstat(dst);
          throw Error("目标已存在");
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
      }
      const bak = existed ? dst + ".sshto-bak-" + crypto.randomUUID() : null;
      if (bak) await fs.rename(dst, bak);
      try {
        await fs.rename(src, dst).catch(async (e) => {
          if (e.code !== "EXDEV") throw e;
          await fs.cp(src, dst, { recursive: true });
          await fs.rm(src, { recursive: true });
        });
      } catch (e) {
        if (bak) await fs.rename(bak, dst).catch(() => {});
        throw e;
      }
      if (bak) await fs.rm(bak, { recursive: true, force: true });
    }
  }
  async mkdir(id, dir, name) {
    if (typeof dir !== "string" || !dir) throw Error("目录参数无效");
    const target = (id ? path.posix : path).join(dir, this.validName(name));
    if (id) {
      const ftp = this.sftp(id);
      try {
        await call(ftp, "mkdir", target);
      } catch (e) {
        try {
          const st = await call(ftp, "stat", target);
          if (st.isDirectory()) throw Error("同名目录已存在");
        } catch {
          throw e;
        }
        throw e;
      }
    } else {
      try {
        await fs.mkdir(target);
      } catch (e) {
        if (e.code === "EEXIST") throw Error("已存在同名文件或目录");
        throw e;
      }
    }
    return target;
  }
  async touch(id, dir, name) {
    if (typeof dir !== "string" || !dir) throw Error("目录参数无效");
    const target = (id ? path.posix : path).join(dir, this.validName(name));
    if (id) {
      const ftp = this.sftp(id);
      const handle = await call(ftp, "open", target, "wx");
      await call(ftp, "close", handle);
    } else {
      try {
        await fs.writeFile(target, "", { flag: "wx" });
      } catch (e) {
        if (e.code === "EEXIST") throw Error("已存在同名文件");
        throw e;
      }
    }
    return target;
  }
  async remove(id, paths) {
    if (
      !Array.isArray(paths) ||
      !paths.length ||
      paths.some((p) => typeof p !== "string" || !p)
    )
      throw Error("删除参数无效");
    if (id) return this.fileOp(id, "remote-delete", paths, "");
    for (const p of paths) await fs.rm(p, { recursive: true });
    return { done: paths.length, skipped: 0 };
  }
  async paste(id, op, sources, destination, recordUndo = true) {
    if (
      !["copy", "move"].includes(op) ||
      !Array.isArray(sources) ||
      !sources.length ||
      sources.some((p) => typeof p !== "string" || !p) ||
      typeof destination !== "string" ||
      !destination
    )
      throw Error("粘贴参数无效");
    if (id) {
      if (!["copy", "move"].includes(op)) throw Error("粘贴参数无效");
      return {
        taskId: await this.fileOp(
          id,
          op === "copy" ? "remote-copy" : "remote-move",
          sources,
          destination,
          recordUndo,
        ),
      };
    }
    const moved = [],
      copied = [],
      done = [];
    let overwriteDecision,
      skipped = 0,
      overwritten = 0;
    for (const src of sources) {
      const dst = path.join(destination, path.basename(src));
      if (dst === src || destination.startsWith(src + path.sep)) {
        skipped++;
        continue;
      }
      let exists = false;
      try {
        await fs.lstat(dst);
        exists = true;
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (exists) {
        let approved = overwriteDecision;
        if (approved === undefined) {
          const decision = await this.approve({
            kind: "overwrite",
            path: dst,
            sessionId: null,
          });
          approved =
            typeof decision === "boolean"
              ? decision
              : decision?.approved === true;
          if (
            decision &&
            typeof decision === "object" &&
            decision.applyToAll === true
          )
            overwriteDecision = approved;
        }
        if (!approved) {
          skipped++;
          continue;
        }
        overwritten++;
      }
      if (op === "move") {
        if (exists) await fs.rm(dst, { recursive: true, force: true });
        await fs.rename(src, dst).catch(async (e) => {
          if (e.code !== "EXDEV") throw e;
          await fs.cp(src, dst, { recursive: true });
          await fs.rm(src, { recursive: true });
        });
        moved.push({ from: src, to: dst });
      } else {
        if (exists) await fs.rm(dst, { recursive: true, force: true });
        await fs.cp(src, dst, { recursive: true });
        copied.push(dst);
      }
      done.push(dst);
    }
    return { moved, copied, skipped, overwritten };
  }
  async stat(id, target) {
    if (typeof target !== "string" || !target) throw Error("路径无效");
    if (id) {
      const st = await call(this.sftp(id), "stat", target);
      return {
        directory: st.isDirectory(),
        size: st.size,
        mtime: typeof st.mtime === "number" ? st.mtime * 1000 : null,
        mode: st.mode,
        uid: st.uid,
        gid: st.gid,
      };
    }
    const st = await fs.stat(target);
    return {
      directory: st.isDirectory(),
      size: st.size,
      mtime: st.mtimeMs,
      mode: st.mode,
      uid: st.uid,
      gid: st.gid,
    };
  }
  async saveFile(id, filePath, content, baseMtime, force = false) {
    if (typeof filePath !== "string" || !filePath || filePath.includes("\0"))
      throw Error("保存路径无效");
    if (typeof content !== "string") throw Error("保存内容无效");
    if (content.length > 8 * 1024 * 1024)
      throw Error("文件过大（超过 8 MiB），暂不支持在线编辑保存");
    const conflict = () => Error("文件在打开后已被外部修改，请确认覆盖保存");
    if (id) {
      const ftp = this.sftp(id);
      const st = await call(ftp, "stat", filePath);
      if (!st.isFile()) throw Error("仅支持保存普通文件");
      if (
        !force &&
        typeof baseMtime === "number" &&
        typeof st.mtime === "number" &&
        Math.abs(st.mtime * 1000 - baseMtime) > 1000
      )
        throw conflict();
      await new Promise((resolve, reject) => {
        const ws = ftp.createWriteStream(filePath, { flags: "w" });
        ws.on("error", reject);
        // ssh2 SFTP streams emit "close" rather than "finish" when done.
        ws.on("close", resolve);
        ws.end(Buffer.from(content, "utf8"));
      });
      const after = await call(ftp, "stat", filePath);
      return {
        mtime: typeof after.mtime === "number" ? after.mtime * 1000 : null,
      };
    }
    const st = await fs.stat(filePath);
    if (!st.isFile()) throw Error("仅支持保存普通文件");
    if (
      !force &&
      typeof baseMtime === "number" &&
      Math.abs(st.mtimeMs - baseMtime) > 10
    )
      throw conflict();
    await fs.writeFile(filePath, content, "utf8");
    const after = await fs.stat(filePath);
    return { mtime: after.mtimeMs };
  }
  async fileOp(sessionId, op, sources, destination, recordUndo = true) {
    if (
      !["remote-copy", "remote-move", "remote-delete"].includes(op) ||
      typeof sessionId !== "string" ||
      !sessionId ||
      !Array.isArray(sources) ||
      !sources.length ||
      sources.some((p) => typeof p !== "string" || !p)
    )
      throw Error("文件操作参数无效");
    if (op !== "remote-delete" && typeof destination !== "string")
      throw Error("文件操作参数无效");
    this.sftp(sessionId);
    const id = crypto.randomUUID();
    const task = {
      id,
      sessionId,
      direction: op,
      sources,
      destination: destination || "",
      status: "queued",
      bytes: 0,
      total: 0,
      cancelled: false,
      skipped: 0,
      recordUndo: recordUndo !== false,
    };
    this.tasks.set(id, task);
    this.event("transfer", { task: { ...task } });
    const job = this.runOp(task)
      .catch((e) => {
        task.status = task.cancelled ? "cancelled" : "error";
        task.message = e.message;
        this.event("transfer", { task: { ...task, streams: undefined } });
      })
      .finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    return id;
  }
  async run(t) {
    const ftp = this.sftp(t.sessionId),
      remote = t.direction === "download";
    const sourcePath = remote ? path.posix : path;
    const destPath = remote ? path : path.posix;
    const files = [],
      dirs = [];
    const check = () => {
      if (t.cancelled) throw Error("传输已取消");
    };
    const scan = async (src, dst) => {
      check();
      const st = remote ? await call(ftp, "lstat", src) : await fs.lstat(src);
      if (st.isSymbolicLink()) {
        t.skipped++;
        return;
      }
      if (st.isDirectory()) {
        dirs.push(dst);
        const names = remote
          ? (await call(ftp, "readdir", src)).map((x) => x.filename)
          : await fs.readdir(src);
        for (const name of names.filter((n) => n !== "." && n !== "..")) {
          if (name.includes("/") || name.includes("\\"))
            throw Error("无效目录项");
          await scan(sourcePath.join(src, name), destPath.join(dst, name));
        }
      } else if (st.isFile()) {
        files.push({ src, dst, size: st.size });
        t.total += st.size;
      }
    };
    t.status = "running";
    t.started = Date.now();
    this.event("transfer", { task: { ...t } });
    for (const src of t.sources)
      await scan(src, destPath.join(t.destination, sourcePath.basename(src)));
    for (const dir of dirs) {
      check();
      try {
        if (remote) await fs.mkdir(dir, { recursive: true });
        else await call(ftp, "mkdir", dir);
      } catch (e) {
        const st = remote ? await fs.stat(dir) : await call(ftp, "stat", dir);
        if (!st.isDirectory()) throw e;
      }
    }
    // This choice belongs only to this run; concurrent jobs and retries prompt independently.
    let overwriteDecision;
    for (const f of files) {
      check();
      let exists = false;
      try {
        if (remote) await fs.lstat(f.dst);
        else await call(ftp, "lstat", f.dst);
        exists = true;
      } catch (e) {
        if (remote ? e.code !== "ENOENT" : e.code !== 2) throw e;
      }
      if (exists) {
        let approved = overwriteDecision;
        if (approved === undefined) {
          const decision = await this.approve({
            kind: "overwrite",
            path: f.dst,
            sessionId: t.sessionId,
            taskId: t.id,
          });
          check();
          approved =
            typeof decision === "boolean"
              ? decision
              : decision?.approved === true;
          if (
            decision &&
            typeof decision === "object" &&
            decision.applyToAll === true
          )
            overwriteDecision = approved;
        }
        if (!approved) {
          t.skipped++;
          continue;
        }
      }
      check();
      const tmp = f.dst + ".sshto-" + t.id + ".part";
      t.current = f.src;
      try {
        await new Promise((resolve, reject) => {
          const input = remote
            ? ftp.createReadStream(f.src)
            : require("node:fs").createReadStream(f.src);
          const output = remote
            ? require("node:fs").createWriteStream(tmp, {
                flags: "wx",
                mode: 0o600,
              })
            : ftp.createWriteStream(tmp, { flags: "wx", mode: 0o600 });
          t.streams = [input, output];
          let settled = false;
          const fail = (e) => {
            if (settled) return;
            settled = true;
            input.destroy();
            output.destroy();
            reject(e);
          };
          input.on("error", fail);
          output.on("error", fail);
          input.on("data", (chunk) => {
            t.bytes += chunk.length;
            const now = Date.now();
            if (!t.lastUpdate || now - t.lastUpdate > 120) {
              t.lastUpdate = now;
              this.event("transfer", { task: { ...t, streams: undefined } });
            }
          });
          output.on("close", () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          });
          input.pipe(output);
        });
        check();
        if (remote) await fs.rename(tmp, f.dst);
        else {
          try {
            await call(ftp, "ext_openssh_rename", tmp, f.dst);
          } catch (e) {
            if (exists) throw Error("远端不支持原子覆盖，原文件已保留");
            await call(ftp, "rename", tmp, f.dst);
          }
        }
      } catch (e) {
        try {
          if (remote) await fs.unlink(tmp);
          else await call(ftp, "unlink", tmp);
        } catch {}
        throw e;
      } finally {
        t.streams = undefined;
      }
    }
    check();
    t.status = "done";
    t.message = t.skipped ? `已完成，跳过 ${t.skipped} 项` : "已完成";
    this.event("transfer", { task: { ...t } });
  }
  async runOp(t) {
    const ftp = this.sftp(t.sessionId);
    t.status = "running";
    t.started = Date.now();
    this.event("transfer", { task: { ...t } });
    const check = () => {
      if (t.cancelled) throw Error("传输已取消");
    };
    const progress = () => this.event("transfer", { task: { ...t } });
    if (t.direction === "remote-delete") {
      const count = async (src) => {
        const st = await call(ftp, "lstat", src);
        if (st.isDirectory() && !st.isSymbolicLink()) {
          let n = 1;
          const items = await call(ftp, "readdir", src);
          for (const x of items)
            if (![".", ".."].includes(x.filename))
              n += await count(path.posix.join(src, x.filename));
          return n;
        }
        return 1;
      };
      let total = 0;
      for (const src of t.sources) total += await count(src).catch(() => 0);
      t.total = Math.max(total, 1);
      const rmWalk = async (src) => {
        check();
        const st = await call(ftp, "lstat", src);
        if (st.isDirectory() && !st.isSymbolicLink()) {
          const items = await call(ftp, "readdir", src);
          for (const x of items)
            if (![".", ".."].includes(x.filename))
              await rmWalk(path.posix.join(src, x.filename));
          await call(ftp, "rmdir", src);
        } else await call(ftp, "unlink", src);
        t.bytes++;
        progress();
      };
      for (const src of t.sources) {
        check();
        t.current = src;
        await rmWalk(src);
      }
    } else {
      let overwriteDecision,
        overwrote = false;
      const movedPairs = [],
        copiedPaths = [];
      for (const src of t.sources) {
        check();
        const dst = path.posix.join(t.destination, path.posix.basename(src));
        if (dst === src || t.destination.startsWith(src + "/")) {
          t.skipped++;
          continue;
        }
        let exists = false;
        try {
          await call(ftp, "lstat", dst);
          exists = true;
        } catch (e) {
          if (e.code !== 2) throw e;
        }
        if (exists) {
          let approved = overwriteDecision;
          if (approved === undefined) {
            const decision = await this.approve({
              kind: "overwrite",
              path: dst,
              sessionId: t.sessionId,
              taskId: t.id,
            });
            check();
            approved =
              typeof decision === "boolean"
                ? decision
                : decision?.approved === true;
            if (
              decision &&
              typeof decision === "object" &&
              decision.applyToAll === true
            )
              overwriteDecision = approved;
          }
          if (!approved) {
            t.skipped++;
            continue;
          }
          overwrote = true;
        }
        if (t.direction === "remote-move") {
          t.current = src;
          t.total = t.sources.length;
          if (exists) await this.replaceRemote(ftp, src, dst);
          else await this.remoteRename(ftp, src, dst);
          movedPairs.push({ from: src, to: dst });
          t.bytes++;
          progress();
        } else {
          t.current = src;
          const files = [],
            dirs = [];
          let totalBytes = 0;
          const walk = async (s, d, depth) => {
            check();
            if (depth > 64)
              throw Error("目录嵌套过深或存在软链接循环，已中止复制");
            const st = await call(ftp, "stat", s);
            if (st.isDirectory()) {
              dirs.push(d);
              const items = await call(ftp, "readdir", s);
              for (const x of items)
                if (![".", ".."].includes(x.filename))
                  await walk(
                    path.posix.join(s, x.filename),
                    path.posix.join(d, x.filename),
                    depth + 1,
                  );
            } else {
              files.push({ src: s, dst: d, size: st.size });
              totalBytes += st.size;
            }
          };
          await walk(src, dst, 0);
          copiedPaths.push(dst);
          t.total = Math.max(totalBytes, 1);
          for (const d of dirs) {
            check();
            try {
              await call(ftp, "mkdir", d);
            } catch (e) {
              try {
                const st = await call(ftp, "stat", d);
                if (st.isDirectory()) continue;
              } catch {}
              throw e;
            }
          }
          for (const f of files) {
            check();
            t.current = f.src;
            await new Promise((resolve, reject) => {
              const input = ftp.createReadStream(f.src);
              const output = ftp.createWriteStream(f.dst);
              t.streams = [input, output];
              input.pipe(output);
              input.on("error", reject);
              output.on("error", reject);
              input.on("data", (chunk) => {
                t.bytes += chunk.length;
              });
              output.on("close", resolve);
            });
            t.streams = undefined;
            progress();
          }
        }
      }
      if (!overwrote && t.recordUndo !== false) {
        if (t.direction === "remote-move" && movedPairs.length)
          t.undo = { kind: "move", pairs: movedPairs };
        else if (t.direction === "remote-copy" && copiedPaths.length)
          t.undo = { kind: "copy", paths: copiedPaths };
      }
    }
    check();
    t.status = "done";
    t.message = t.skipped ? `已完成，跳过 ${t.skipped} 项` : "已完成";
    this.event("transfer", { task: { ...t } });
  }
}
module.exports = { Store, SSHService, validateDevice, routeFor };
