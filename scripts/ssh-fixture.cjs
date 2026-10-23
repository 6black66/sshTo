// Real SSH transport fixture. Its SFTP subsystem maps to a disposable local directory.
const {
  Server,
  utils: {
    sftp: { STATUS_CODE: C, flagsToString },
  },
} = require("ssh2");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
function attachSftp(s, root, readDelay = 0) {
  let sequence = 0;
  const handles = new Map();
  const resolve = (p) => {
    const r = path.resolve(root, "." + path.posix.resolve("/", p));
    if (r !== root && !r.startsWith(root + path.sep))
      throw Error("outside fixture");
    return r;
  };
  const fail = (id, e) =>
    s.status(
      id,
      e.code === "ENOENT"
        ? C.NO_SUCH_FILE
        : e.code === "EACCES"
          ? C.PERMISSION_DENIED
          : C.FAILURE,
      e.message,
    );
  const run = (id, fn) =>
    Promise.resolve()
      .then(fn)
      .catch((e) => fail(id, e));
  const handle = (value) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(++sequence);
    handles.set(sequence, value);
    return b;
  };
  const get = (b) => handles.get(b.readUInt32BE());
  const attrs = (st) => ({
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  });
  for (const event of ["STAT", "LSTAT"])
    s.on(event, (id, p) =>
      run(id, async () =>
        s.attrs(
          id,
          attrs(await fsp[event === "STAT" ? "stat" : "lstat"](resolve(p))),
        ),
      ),
    );
  s.on("FSTAT", (id, h) =>
    run(id, async () => s.attrs(id, attrs(await get(h).fd.stat()))),
  );
  s.on("REALPATH", (id, p) =>
    s.name(id, [
      { filename: path.posix.resolve("/", p), longname: "", attrs: {} },
    ]),
  );
  s.on("OPENDIR", (id, p) =>
    run(id, async () => {
      const dir = resolve(p);
      const names = await fsp.readdir(dir);
      const entries = await Promise.all(
        names.map(async (name) => ({
          filename: name,
          longname: name,
          attrs: attrs(await fsp.lstat(path.join(dir, name))),
        })),
      );
      s.handle(id, handle({ entries }));
    }),
  );
  s.on("READDIR", (id, h) => {
    const item = get(h);
    if (item.entries.length) {
      s.name(id, item.entries);
      item.entries = [];
    } else s.status(id, C.EOF);
  });
  s.on("OPEN", (id, p, flags, a) =>
    run(id, async () => {
      const fd = await fsp.open(
        resolve(p),
        flagsToString(flags),
        a.mode || 0o600,
      );
      s.handle(id, handle({ fd }));
    }),
  );
  s.on("READ", (id, h, offset, length) =>
    run(id, async () => {
      if (readDelay)
        await new Promise((resolve) => setTimeout(resolve, readDelay));
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await get(h).fd.read(buffer, 0, length, offset);
      if (bytesRead) s.data(id, buffer.subarray(0, bytesRead));
      else s.status(id, C.EOF);
    }),
  );
  s.on("WRITE", (id, h, offset, data) =>
    run(id, async () => {
      await get(h).fd.write(data, 0, data.length, offset);
      s.status(id, C.OK);
    }),
  );
  s.on("CLOSE", (id, h) =>
    run(id, async () => {
      const item = get(h);
      if (item.fd) await item.fd.close();
      handles.delete(h.readUInt32BE());
      s.status(id, C.OK);
    }),
  );
  for (const [event, method] of [
    ["MKDIR", "mkdir"],
    ["REMOVE", "unlink"],
    ["RMDIR", "rmdir"],
  ])
    s.on(event, (id, p) =>
      run(id, async () => {
        await fsp[method](resolve(p));
        s.status(id, C.OK);
      }),
    );
  s.on("RENAME", (id, a, b) =>
    run(id, async () => {
      await fsp.rename(resolve(a), resolve(b));
      s.status(id, C.OK);
    }),
  );
  s.on("EXTENDED", (id, name, ...args) => {
    if (name === "posix-rename@openssh.com")
      run(id, async () => {
        await fsp.rename(resolve(args[0]), resolve(args[1]));
        s.status(id, C.OK);
      });
    else s.status(id, C.OP_UNSUPPORTED);
  });
  s.on("close", () => {
    for (const item of handles.values())
      if (item.fd) item.fd.close().catch(() => {});
  });
}
async function fixture(
  root,
  {
    password = "test-secret",
    publicKey,
    noSftp = false,
    noForward = false,
    readDelay = 0,
    onInput,
  } = {},
) {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const key = privateKey.export({ type: "pkcs1", format: "pem" });
  const clients = new Set(),
    sockets = new Set();
  const server = new Server({ hostKeys: [key] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.password === password) ctx.accept();
      else if (
        ctx.method === "publickey" &&
        publicKey &&
        ctx.key.data.equals(publicKey.getPublicSSH()) &&
        (!ctx.signature ||
          publicKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo))
      )
        ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () => {
      client.on("tcpip", (accept, reject, info) => {
        if (noForward) return reject();
        const socket = net.connect(info.destPort, info.destIP);
        sockets.add(socket);
        socket.on("connect", () => {
          const stream = accept();
          stream.pipe(socket).pipe(stream);
          stream.on("close", () => socket.destroy());
        });
        socket.on("error", () => reject());
        socket.on("close", () => sockets.delete(socket));
      });
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (accept) => accept());
        session.on("window-change", (accept) => accept && accept());
        session.on("shell", (accept) => {
          const stream = accept();
          stream.write("fixture ready\r\n");
          stream.on("data", (b) => {
            onInput?.(b);
            stream.write(b);
          });
        });
        session.on("sftp", (accept, reject) => {
          if (noSftp) return reject();
          attachSftp(accept(), root, readDelay);
        });
      });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    stop: async () => {
      for (const c of clients) {
        c.end();
        c._sock?.destroy();
      }
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}
module.exports = { fixture };
