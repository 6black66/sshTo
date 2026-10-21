const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
} = require("electron");
const path = require("node:path");
const { Store, SSHService } = require("./backend.cjs");
let win, store, service;
const available = () =>
  safeStorage.isEncryptionAvailable() &&
  !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend());
app.whenReady().then(async () => {
  store = new Store(app.getPath("userData"), {
    available,
    // Match the Linux provider checked by available(), including KWallet.
    encrypt: async (s) => safeStorage.encryptString(s).toString("base64"),
    decrypt: async (s) => safeStorage.decryptString(Buffer.from(s, "base64")),
  });
  try {
    await store.init();
  } catch (e) {
    dialog.showErrorBox("无法读取配置", e.message);
    app.quit();
    return;
  }
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 650,
    backgroundColor: "#10131a",
    title: "sshTo",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  service = new SSHService(store, async (question) => {
    if (win.isDestroyed()) return false;
    const host = question.kind === "host";
    const result = await dialog.showMessageBox(win, {
      type: host ? "warning" : "question",
      title: host ? "确认 SSH 主机身份" : "文件已存在",
      message: host
        ? question.previous
          ? "主机密钥已变化，请核实后再更新"
          : "首次连接此设备"
        : "覆盖目标文件？",
      detail: host
        ? `${question.name} · ${question.host}\n指纹：${question.fingerprint}${question.previous ? "\n原指纹：" + question.previous : ""}`
        : question.path,
      buttons: host
        ? ["取消", question.previous ? "确认更新并连接" : "信任并连接"]
        : ["跳过", "覆盖"],
      defaultId: 0,
      cancelId: 0,
    });
    return result.response === 1;
  });
  service.on("event", (e) => {
    if (!win.isDestroyed()) win.webContents.send("ssh:event", e);
  });
  const handlers = {
    "devices:list": () => store.list(),
    "devices:save": (d, s, r) => store.save(d, s, r),
    "devices:remove": (id) => store.remove(id),
    "vault:available": available,
    "sessions:connect": (id, credentials) => service.connect(id, credentials),
    "sessions:close": (id) => service.close(id),
    "sessions:input": (id, data) => {
      if (typeof data !== "string" || data.length > 1024 * 1024)
        throw Error("终端输入无效");
      service.input(id, data);
    },
    "sessions:resize": (id, c, r) => {
      if (!Number.isInteger(c) || !Number.isInteger(r))
        throw Error("终端尺寸无效");
      service.resize(id, c, r);
    },
    "files:list": (id, dir) => service.list(id, dir),
    "files:transfer": (id, d, s, dest) => service.transfer(id, d, s, dest),
    "files:cancel": (id) => service.cancel(id),
    "dialog:key": async () => {
      const r = await dialog.showOpenDialog(win, {
        title: "选择 SSH 私钥",
        properties: ["openFile", "showHiddenFiles"],
      });
      return r.filePaths[0] || null;
    },
  };
  for (const [name, fn] of Object.entries(handlers))
    ipcMain.handle(name, async (event, ...args) => {
      if (
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame
      )
        throw Error("无效请求来源");
      try {
        return { ok: true, value: await fn(...args) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  let quitting = false;
  win.on("close", (event) => {
    if (quitting) return;
    const active = [...service.tasks.values()].some((t) =>
      ["running", "queued"].includes(t.status),
    );
    if (active) {
      event.preventDefault();
      dialog
        .showMessageBox(win, {
          type: "question",
          message: "文件仍在传输，退出并取消传输？",
          buttons: ["继续传输", "退出"],
          defaultId: 0,
          cancelId: 0,
        })
        .then(async (r) => {
          if (r.response === 1) {
            quitting = true;
            for (const id of service.sessions.keys()) service.close(id);
            await Promise.allSettled([...service.jobs.values()]);
            win.close();
          }
        });
    } else {
      for (const id of service.sessions.keys()) service.close(id);
    }
  });
  if (process.argv.includes("--dev"))
    await win.loadURL("http://127.0.0.1:5173");
  else await win.loadFile(path.join(__dirname, "../dist/index.html"));
});
app.on("window-all-closed", () => app.quit());
