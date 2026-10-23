const { contextBridge, ipcRenderer } = require("electron");
const channels = new Set([
  "devices:list",
  "devices:save",
  "devices:remove",
  "vault:available",
  "sessions:connect",
  "sessions:close",
  "sessions:input",
  "sessions:resize",
  "files:list",
  "files:preview",
  "files:preview-cancel",
  "files:transfer",
  "files:cancel",
  "dialog:key",
  "clipboard:read",
  "clipboard:write",
  "clipboard:edit",
  "clipboard:menu",
]);
contextBridge.exposeInMainWorld("sshTo", {
  call: async (name, ...args) => {
    if (!channels.has(name)) throw Error("未知接口");
    const r = await ipcRenderer.invoke(name, ...args);
    if (!r.ok) throw Error(r.error);
    return r.value;
  },
  subscribe: (fn) => {
    const listener = (_e, data) => fn(data);
    ipcRenderer.on("ssh:event", listener);
    return () => ipcRenderer.removeListener("ssh:event", listener);
  },
});
