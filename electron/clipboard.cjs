// Clipboard and native menus stay in the main process; terminal paste returns through xterm.
function createClipboardHandlers(win, service, { clipboard, Menu }) {
  const report = (id, error) =>
    service.event("clipboard-error", {
      id: id || "",
      message: error.message || "剪贴板操作失败",
    });
  return {
    "clipboard:read": () => clipboard.readText(),
    "clipboard:write": (text) => {
      if (typeof text !== "string") throw Error("复制内容无效");
      return clipboard.writeText(text);
    },
    "clipboard:edit": (action) => {
      if (action === "copy") win.webContents.copy();
      else if (action === "paste") win.webContents.paste();
      else throw Error("无效的剪贴板操作");
    },
    "clipboard:menu": async (options) => {
      if (!options || !["terminal", "standard"].includes(options.kind))
        throw Error("右键菜单参数无效");
      const terminal = options.kind === "terminal";
      if (
        terminal &&
        (typeof options.sessionId !== "string" ||
          typeof options.selection !== "string")
      )
        throw Error("终端菜单参数无效");
      const id = terminal ? options.sessionId : "";
      const clipboardText = await clipboard.readText();
      if (win.isDestroyed()) return;
      const canPaste = terminal
        ? service.sessions.get(id)?.status === "connected"
        : options.editable === true;
      const menu = Menu.buildFromTemplate([
        {
          label: "复制",
          accelerator: "Ctrl+Shift+C",
          registerAccelerator: false,
          enabled: terminal
            ? options.selection.length > 0
            : options.canCopy === true,
          click: () => {
            if (terminal)
              void clipboard
                .writeText(options.selection)
                .catch((error) => report(id, error));
            else win.webContents.copy();
          },
        },
        {
          label: "粘贴",
          accelerator: "Ctrl+Shift+V",
          registerAccelerator: false,
          enabled: canPaste && clipboardText.length > 0,
          click: () => {
            if (terminal)
              void clipboard
                .readText()
                .then((text) => {
                  if (service.sessions.get(id)?.status !== "connected")
                    throw Error("连接已断开，无法粘贴");
                  service.event("paste", { id, data: text });
                })
                .catch((error) => report(id, error));
            else win.webContents.paste();
          },
        },
      ]);
      menu.popup({ window: win });
    },
  };
}
module.exports = { createClipboardHandlers };
