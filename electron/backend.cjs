const { Client } = require("ssh2");
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
class SSHService extends EventEmitter {
  constructor(store, approve) {
    super();
    this.store = store;
    this.approve = approve;
    this.sessions = new Map();
    this.tasks = new Map();
    this.jobs = new Map();
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
        entries: items
          .filter((x) => ![".", ".."].includes(x.filename))
          .map((x) => ({
            name: x.filename,
            directory: x.attrs.isDirectory(),
            symlink: x.attrs.isSymbolicLink(),
            size: x.attrs.size,
          })),
      };
    }
    const resolved = path.resolve(dir || require("node:os").homedir());
    const items = await fs.readdir(resolved, { withFileTypes: true });
    const entries = await Promise.all(
      items.map(async (x) => {
        const st = await fs.lstat(path.join(resolved, x.name));
        return {
          name: x.name,
          directory: st.isDirectory(),
          symlink: st.isSymbolicLink(),
          size: st.size,
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
      if (
        exists &&
        !(await this.approve({
          kind: "overwrite",
          path: f.dst,
          sessionId: t.sessionId,
        }))
      ) {
        t.skipped++;
        continue;
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
    t.status = "done";
    t.message = t.skipped ? `已完成，跳过 ${t.skipped} 项` : "已完成";
    this.event("transfer", { task: { ...t } });
  }
}
module.exports = { Store, SSHService, validateDevice, routeFor };
