const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { utils } = require("ssh2");
const { Store, SSHService } = require("../electron/backend.cjs");
const { fixture } = require("./ssh-fixture.cjs");
function waitEvent(service, predicate, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const listener = (e) => {
      if (predicate(e)) {
        clearTimeout(timer);
        service.off("event", listener);
        resolve(e);
      }
    };
    const timer = setTimeout(() => {
      service.off("event", listener);
      reject(Error("Timed out awaiting event"));
    }, timeout);
    service.on("event", listener);
  });
}
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sshto-integration-"));
  const servers = [];
  let service;
  try {
    const remote = path.join(root, "remote"),
      local = path.join(root, "local");
    await fs.mkdir(remote);
    await fs.mkdir(local);
    execFileSync("ssh-keygen", [
      "-t",
      "ed25519",
      "-N",
      "private-pass",
      "-f",
      path.join(root, "id_ed25519"),
      "-q",
    ]);
    const parsed = utils.parseKey(
      await fs.readFile(path.join(root, "id_ed25519")),
      "private-pass",
    );
    assert(!(parsed instanceof Error));
    for (let i = 0; i < 3; i++)
      servers.push(await fixture(remote, { publicKey: parsed }));
    const denied = await fixture(remote, { noForward: true });
    servers.push(denied);
    const noSftp = await fixture(remote, { noSftp: true });
    servers.push(noSftp);
    const store = new Store(path.join(root, "config"), {
      available: () => false,
    });
    await store.init();
    const device = (id, index, jumps = [], auth = "password") => ({
      id,
      name: id,
      host: "127.0.0.1",
      port: servers[index].port,
      username: "tester",
      auth,
      keyPath: path.join(root, "id_ed25519"),
      jumps,
    });
    await store.save(device("a", 0), "test-secret", false);
    await store.save(device("b", 1), "test-secret", false);
    await store.save(
      device("target", 2, ["a", "b"], "key"),
      "private-pass",
      false,
    );
    await store.save(device("denied", 3), "test-secret", false);
    await store.save(
      { ...device("blocked", 2), jumps: ["denied"] },
      "test-secret",
      false,
    );
    await store.save(device("nosftp", 4), "test-secret", false);
    let approvals = 0;
    service = new SSHService(store, async () => {
      approvals++;
      return true;
    });
    const ready = waitEvent(service, (e) => e.type === "sftp" && e.available);
    const s = await service.connect("target");
    await ready;
    assert.equal(service.sessions.get(s.id).clients.length, 3);
    assert.equal(approvals, 3);
    console.log(
      "✓ Password + encrypted private key authentication over two jump hosts",
    );
    const output = waitEvent(
      service,
      (e) =>
        e.type === "data" &&
        Buffer.from(e.data, "base64").toString().includes("hello 中文"),
    );
    service.input(s.id, "hello 中文");
    await output;
    service.resize(s.id, 140, 45);
    console.log("✓ Interactive shell UTF-8 input/output and resize");
    const folder = path.join(local, "中文目录");
    await fs.mkdir(folder);
    const content = crypto.randomBytes(3 * 1024 * 1024);
    await fs.writeFile(path.join(folder, "large.bin"), content);
    await fs.writeFile(path.join(folder, "文件.txt"), "你好 SSH");
    await fs.symlink("/does-not-exist", path.join(folder, "link"));
    let completed = waitEvent(
      service,
      (e) => e.type === "transfer" && ["done", "error"].includes(e.task.status),
    );
    await service.transfer(s.id, "upload", [folder], "/");
    let event = await completed;
    assert.equal(event.task.status, "done", event.task.message);
    assert.equal(event.task.skipped, 1);
    assert.deepEqual(
      await fs.readFile(path.join(remote, "中文目录", "large.bin")),
      content,
    );
    console.log(
      "✓ Recursive upload, Unicode filenames, 3 MB integrity, symlink skipping",
    );
    const listing = await service.list(s.id, "/中文目录");
    assert.equal(listing.entries.length, 2);
    const download = path.join(root, "downloads");
    await fs.mkdir(download);
    completed = waitEvent(
      service,
      (e) => e.type === "transfer" && ["done", "error"].includes(e.task.status),
    );
    await service.transfer(s.id, "download", ["/中文目录"], download);
    event = await completed;
    assert.equal(event.task.status, "done", event.task.message);
    assert.deepEqual(
      await fs.readFile(path.join(download, "中文目录", "large.bin")),
      content,
    );
    console.log("✓ Recursive download and content integrity");
    // A server without the OpenSSH atomic rename extension must preserve existing targets.
    completed = waitEvent(
      service,
      (e) => e.type === "transfer" && ["done", "error"].includes(e.task.status),
    );
    await service.transfer(
      s.id,
      "upload",
      [path.join(folder, "文件.txt")],
      "/中文目录",
    );
    event = await completed;
    assert(["done", "error"].includes(event.task.status));
    assert.equal(
      await fs.readFile(path.join(remote, "中文目录", "文件.txt"), "utf8"),
      "你好 SSH",
    );
    assert(
      !(await fs.readdir(path.join(remote, "中文目录"))).some((n) =>
        n.endsWith(".part"),
      ),
    );
    console.log(
      "✓ Overwrite confirmation preserves target and removes temporary files",
    );
    completed = waitEvent(
      service,
      (e) => e.type === "transfer" && e.task.status === "cancelled",
    );
    const taskId = await service.transfer(s.id, "upload", [folder], "/");
    service.cancel(taskId);
    await completed;
    console.log("✓ Transfer cancellation");
    await fs.mkdir(path.join(remote, "cancel-target"));
    const progress = waitEvent(
      service,
      (e) =>
        e.type === "transfer" &&
        e.task.bytes > 0 &&
        e.task.status === "running",
    );
    completed = waitEvent(
      service,
      (e) => e.type === "transfer" && e.task.status === "cancelled",
    );
    const partial = await service.transfer(
      s.id,
      "upload",
      [path.join(folder, "large.bin")],
      "/cancel-target",
    );
    await progress;
    service.cancel(partial);
    await completed;
    assert.deepEqual(await fs.readdir(path.join(remote, "cancel-target")), []);
    console.log("✓ Cancellation during streaming removes partial remote file");

    const others = [];
    for (let i = 0; i < 3; i++) {
      const r = waitEvent(service, (e) => e.type === "sftp" && e.available);
      const one = await service.connect("a");
      await r;
      others.push(one);
    }
    assert.equal(service.sessions.size, 4);
    console.log("✓ Four independent simultaneous sessions");
    const isolated = waitEvent(
      service,
      (e) =>
        e.type === "data" &&
        Buffer.from(e.data, "base64").toString().includes("session-isolation"),
    );
    service.input(others[1].id, "session-isolation");
    assert.equal((await isolated).id, others[1].id);
    const host = `[127.0.0.1]:${servers[0].port}`;
    store.data.hosts[host] = "SHA256:previous-key";
    const approve = service.approve;
    let asked;
    service.approve = async (question) => {
      asked = question;
      return false;
    };
    const rejected = waitEvent(
      service,
      (e) => e.type === "status" && e.status === "error",
    );
    await service.connect("a");
    await rejected;
    assert.equal(asked.previous, "SHA256:previous-key");
    assert.equal(store.data.hosts[host], "SHA256:previous-key");
    service.approve = approve;
    const trusted = waitEvent(service, (e) => e.type === "sftp" && e.available);
    const updated = await service.connect("a");
    await trusted;
    assert.notEqual(store.data.hosts[host], "SHA256:previous-key");
    service.close(updated.id);
    console.log(
      "✓ Changed host key rejected until explicit approval; session output stays isolated",
    );

    const failure = waitEvent(
      service,
      (e) => e.type === "status" && e.status === "error",
    );
    await service.connect("a", { a: "wrong" });
    await failure;
    console.log("✓ Authentication failure reported");
    const blocked = waitEvent(
      service,
      (e) => e.type === "status" && e.status === "error",
    );
    await service.connect("blocked");
    await blocked;
    console.log("✓ Forwarding denied reported");
    const unsupported = waitEvent(
      service,
      (e) => e.type === "sftp" && e.available === false,
    );
    const ns = await service.connect("nosftp");
    await unsupported;
    assert.equal(service.sessions.get(ns.id).status, "connected");
    console.log("✓ Missing SFTP leaves terminal connected");
    await servers[1].stop();
    const interrupted = await waitEvent(
      service,
      (e) => e.id === s.id && e.type === "status" && e.status === "error",
    );
    assert(interrupted.message);
    assert(!service.sessions.has(s.id));
    console.log("✓ Jump interruption releases the entire chain");
    for (const id of [...service.sessions.keys()]) service.close(id);
    assert.equal(service.sessions.size, 0);
    console.log("All integration checks passed.");
  } finally {
    if (service)
      for (const id of [...service.sessions.keys()]) service.close(id);
    await Promise.allSettled(servers.map((s) => s.stop()));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
