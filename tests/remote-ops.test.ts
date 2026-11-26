import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
const { SSHService } = createRequire(import.meta.url)(
  "../electron/backend.cjs",
);

type MockNode = {
  type: "dir" | "file" | "link";
  target?: string;
  data?: string;
};
const err = (code: number) => Object.assign(Error("mock"), { code });

class MockSftp {
  root = new Map<string, MockNode>();
  constructor(entries: Record<string, MockNode>) {
    for (const [p, n] of Object.entries(entries)) this.root.set(p, n);
  }
  private get(p: string): MockNode {
    const n = this.root.get(p);
    if (!n) throw err(2);
    return n;
  }
  private resolve(p: string, hops = 0): string {
    if (hops > 40) throw err(4);
    const parts = p.split("/").filter(Boolean);
    let cur = "";
    for (let i = 0; i < parts.length; i++) {
      cur += "/" + parts[i];
      const n = this.root.get(cur);
      if (!n) throw err(2);
      if (n.type === "link") {
        const rest = "/" + parts.slice(i + 1).join("/");
        return this.resolve(n.target! + rest, hops + 1);
      }
    }
    return cur;
  }
  private static attrs(n: MockNode) {
    return {
      isDirectory: () => n.type === "dir",
      isSymbolicLink: () => n.type === "link",
      isFile: () => n.type === "file",
      size: n.data?.length ?? 0,
    };
  }
  lstat(p: string, cb: (e: unknown, r?: unknown) => void) {
    try {
      cb(null, MockSftp.attrs(this.get(p)));
    } catch (e) {
      cb(e);
    }
  }
  stat(p: string, cb: (e: unknown, r?: unknown) => void) {
    try {
      cb(null, MockSftp.attrs(this.get(this.resolve(p))));
    } catch (e) {
      cb(e);
    }
  }
  readdir(p: string, cb: (e: unknown, r?: unknown) => void) {
    try {
      const real = this.resolve(p);
      const prefix = real === "/" ? "/" : real + "/";
      cb(
        null,
        [...this.root.keys()]
          .filter(
            (k) =>
              k.startsWith(prefix) && !k.slice(prefix.length).includes("/"),
          )
          .map((k) => ({ filename: k.slice(k.lastIndexOf("/") + 1) })),
      );
    } catch (e) {
      cb(e);
    }
  }
  rename(a: string, b: string, cb: (e: unknown, r?: unknown) => void) {
    try {
      const n = this.get(a);
      if (this.root.has(b)) throw err(4);
      this.root.delete(a);
      this.root.set(b, n);
      cb(null);
    } catch (e) {
      cb(e);
    }
  }
  unlink(p: string, cb: (e: unknown, r?: unknown) => void) {
    try {
      const n = this.get(p);
      if (n.type === "dir") throw err(4);
      this.root.delete(p);
      cb(null);
    } catch (e) {
      cb(e);
    }
  }
  rmdir(p: string, cb: (e: unknown, r?: unknown) => void) {
    try {
      this.get(p);
      this.root.delete(p);
      cb(null);
    } catch (e) {
      cb(e);
    }
  }
  mkdir(p: string, cb: (e: unknown, r?: unknown) => void) {
    try {
      if (this.root.has(p)) throw err(4);
      this.root.set(p, { type: "dir" });
      cb(null);
    } catch (e) {
      cb(e);
    }
  }
  createReadStream(p: string) {
    const data = Buffer.from(this.get(this.resolve(p)).data ?? "");
    return new Readable({
      read() {
        this.push(data);
        this.push(null);
      },
    });
  }
  createWriteStream(p: string) {
    const chunks: Buffer[] = [];
    const ws = new Writable({
      write(c: Buffer, _e, cb) {
        chunks.push(c);
        cb();
      },
    });
    ws.on("finish", () => {
      this.root.set(p, {
        type: "file",
        data: Buffer.concat(chunks).toString(),
      });
    });
    return ws;
  }
}

const makeService = () => {
  const service = new SSHService({} as object, async () => ({
    approved: true,
    applyToAll: false,
  })) as InstanceType<typeof SSHService> & {
    sessions: Map<string, unknown>;
    runOp: (t: Record<string, unknown>) => Promise<void>;
    rename: (
      id: string | null,
      src: string,
      dst: string,
      overwrite?: boolean,
    ) => Promise<void>;
    paste: (
      id: string | null,
      op: string,
      sources: string[],
      dest: string,
      recordUndo?: boolean,
    ) => Promise<Record<string, unknown>>;
  };
  return service;
};
const attach = (service: ReturnType<typeof makeService>, ftp: MockSftp) => {
  service.sessions.set("s", { sftp: ftp, closed: false });
};
const task = (over: Record<string, unknown>) => ({
  id: "t1",
  sessionId: "s",
  status: "queued",
  bytes: 0,
  total: 0,
  cancelled: false,
  skipped: 0,
  ...over,
});

describe("remote rename with overwrite", () => {
  it("replaces the target and cleans up the backup", async () => {
    const ftp = new MockSftp({
      "/d/a.txt": { type: "file", data: "NEW" },
      "/d/b.txt": { type: "file", data: "OLD" },
    });
    const svc = makeService();
    attach(svc, ftp);
    await svc.rename("s", "/d/a.txt", "/d/b.txt", true);
    expect(ftp.root.get("/d/b.txt")!.data).toBe("NEW");
    expect(ftp.root.has("/d/a.txt")).toBe(false);
    expect(
      [...ftp.root.keys()].filter((k) => k.includes(".sshto-bak-")),
    ).toHaveLength(0);
  });
  it("restores the original target when the rename fails", async () => {
    const ftp = new MockSftp({
      "/d/b.txt": { type: "file", data: "PRECIOUS" },
    });
    const svc = makeService();
    attach(svc, ftp);
    await expect(
      svc.rename("s", "/d/missing.txt", "/d/b.txt", true),
    ).rejects.toThrow();
    expect(ftp.root.get("/d/b.txt")!.data).toBe("PRECIOUS");
    expect(
      [...ftp.root.keys()].filter((k) => k.includes(".sshto-bak-")),
    ).toHaveLength(0);
  });
});

describe("remote file operations via task runner", () => {
  it("moves files and records undo pairs", async () => {
    const ftp = new MockSftp({
      "/x": { type: "dir" },
      "/y": { type: "dir" },
      "/x/f.txt": { type: "file", data: "m" },
    });
    const svc = makeService();
    attach(svc, ftp);
    const t = task({
      direction: "remote-move",
      sources: ["/x/f.txt"],
      destination: "/y",
    });
    await svc.runOp(t);
    expect(ftp.root.has("/x/f.txt")).toBe(false);
    expect(ftp.root.get("/y/f.txt")!.data).toBe("m");
    expect(t.status).toBe("done");
    expect(t.undo).toEqual({
      kind: "move",
      pairs: [{ from: "/x/f.txt", to: "/y/f.txt" }],
    });
  });
  it("skips undo recording when recordUndo is false", async () => {
    const ftp = new MockSftp({
      "/x": { type: "dir" },
      "/y": { type: "dir" },
      "/x/f.txt": { type: "file", data: "m" },
    });
    const svc = makeService();
    attach(svc, ftp);
    const t = task({
      direction: "remote-move",
      sources: ["/x/f.txt"],
      destination: "/y",
      recordUndo: false,
    });
    await svc.runOp(t);
    expect(ftp.root.has("/y/f.txt")).toBe(true);
    expect(t.undo).toBeUndefined();
  });
  it("copies files recursively and records undo paths", async () => {
    const ftp = new MockSftp({
      "/x": { type: "dir" },
      "/x/sub": { type: "dir" },
      "/x/sub/f.txt": { type: "file", data: "c" },
      "/y": { type: "dir" },
    });
    const svc = makeService();
    attach(svc, ftp);
    const t = task({
      direction: "remote-copy",
      sources: ["/x/sub"],
      destination: "/y",
    });
    await svc.runOp(t);
    expect(ftp.root.get("/y/sub/f.txt")!.data).toBe("c");
    expect(t.undo).toEqual({ kind: "copy", paths: ["/y/sub"] });
    expect(t.total).toBeGreaterThan(0);
    expect(t.bytes).toBeGreaterThan(0);
  });
  it("aborts instead of hanging on cyclic symlinks", async () => {
    const ftp = new MockSftp({
      "/a": { type: "dir" },
      "/a/link": { type: "link", target: "/a" },
      "/a/f.txt": { type: "file", data: "z" },
    });
    const svc = makeService();
    attach(svc, ftp);
    const t = task({
      direction: "remote-copy",
      sources: ["/a"],
      destination: "/b",
    });
    await expect(svc.runOp(t)).rejects.toThrow();
  });
  it("deletes recursively including symlinks without following them", async () => {
    const ftp = new MockSftp({
      "/a": { type: "dir" },
      "/a/sub": { type: "dir" },
      "/a/sub/f.txt": { type: "file", data: "z" },
      "/a/link": { type: "link", target: "/" },
      "/kept": { type: "file", data: "keep" },
    });
    const svc = makeService();
    attach(svc, ftp);
    const t = task({ direction: "remote-delete", sources: ["/a"] });
    await svc.runOp(t);
    expect(ftp.root.has("/a")).toBe(false);
    expect(ftp.root.has("/kept")).toBe(true);
    expect(t.total).toBe(4);
  });
});

describe("remote saveFile and copy over ssh2-style streams", () => {
  // Real ssh2 SFTP WriteStreams emit "close" when done and never "finish";
  // waiting on "finish" hangs forever (regression guard for backend.cjs).
  class Ssh2StyleWriteStream extends Writable {
    private chunks: Buffer[] = [];
    constructor(private readonly onDone: (data: string) => void) {
      super();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emit(event: string | symbol, ...args: any[]): boolean {
      if (event === "finish") return true;
      return super.emit(event, ...args);
    }
    _write(chunk: Buffer, _enc: unknown, cb: () => void) {
      this.chunks.push(chunk);
      cb();
    }
    _final(cb: () => void) {
      cb();
      this.onDone(Buffer.concat(this.chunks).toString());
      this.destroy();
    }
  }
  const ssh2Ftp = (entries: Record<string, MockNode>) => {
    const ftp = new MockSftp(entries);
    ftp.createWriteStream = (p: string, _opts?: unknown) =>
      new Ssh2StyleWriteStream((data) =>
        ftp.root.set(p, { type: "file", data }),
      );
    return ftp;
  };
  it("saveFile completes when the write stream only emits close", async () => {
    const ftp = ssh2Ftp({ "/f.txt": { type: "file", data: "old" } });
    const svc = makeService();
    attach(svc, ftp);
    const r = (await svc.saveFile(
      "s",
      "/f.txt",
      "NEW-CONTENT",
      null,
      false,
    )) as {
      mtime: number | null;
    };
    expect(ftp.root.get("/f.txt")!.data).toBe("NEW-CONTENT");
    expect(r.mtime).toBeNull();
  });
  it("remote copy completes when the write stream only emits close", async () => {
    const ftp = ssh2Ftp({
      "/x": { type: "dir" },
      "/x/f.txt": { type: "file", data: "copy-me" },
      "/y": { type: "dir" },
    });
    const svc = makeService();
    attach(svc, ftp);
    const t = task({
      direction: "remote-copy",
      sources: ["/x/f.txt"],
      destination: "/y",
    });
    await svc.runOp(t);
    expect(ftp.root.get("/y/f.txt")!.data).toBe("copy-me");
    expect(t.status).toBe("done");
  });
});

describe("local saveFile", () => {
  it("writes content, detects external modification and forces overwrite", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshto-save-"));
    const svc = makeService();
    const file = path.join(dir, "f.txt");
    await fs.writeFile(file, "v1");
    const opened = (await fs.stat(file)).mtimeMs;
    const r = (await svc.saveFile(null, file, "v2", opened, false)) as {
      mtime: number;
    };
    expect(await fs.readFile(file, "utf8")).toBe("v2");
    expect(r.mtime).toBeGreaterThan(0);
    await fs.writeFile(file, "external edit");
    const now = new Date();
    await fs.utimes(file, now, new Date(now.getTime() + 10_000));
    await expect(svc.saveFile(null, file, "v3", opened, false)).rejects.toThrow(
      "已被外部修改",
    );
    const r2 = (await svc.saveFile(null, file, "v3", opened, true)) as {
      mtime: number;
    };
    expect(await fs.readFile(file, "utf8")).toBe("v3");
    expect(r2.mtime).toBeGreaterThan(0);
    await expect(
      svc.saveFile(null, path.join(dir, "missing.txt"), "x", null, true),
    ).rejects.toThrow();
    await expect(
      svc.saveFile(null, file, "x".repeat(9 * 1024 * 1024), null, true),
    ).rejects.toThrow("文件过大");
  });
});

describe("local paste undo reporting", () => {
  it("counts overwrites and reports moved pairs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshto-undo-"));
    const svc = makeService();
    await fs.writeFile(path.join(dir, "a.txt"), "A");
    await fs.mkdir(path.join(dir, "dst"));
    await fs.writeFile(path.join(dir, "dst", "a.txt"), "old");
    const r = (await svc.paste(
      null,
      "copy",
      [path.join(dir, "a.txt")],
      path.join(dir, "dst"),
    )) as {
      copied: string[];
      overwritten: number;
    };
    expect(r.overwritten).toBe(1);
    expect(r.copied).toHaveLength(1);
    await fs.writeFile(path.join(dir, "a.txt"), "A2");
    const r2 = (await svc.paste(
      null,
      "move",
      [path.join(dir, "a.txt")],
      path.join(dir, "dst"),
    )) as {
      moved: { from: string; to: string }[];
      overwritten: number;
    };
    expect(r2.overwritten).toBe(1);
    expect(r2.moved).toEqual([
      { from: path.join(dir, "a.txt"), to: path.join(dir, "dst", "a.txt") },
    ]);
    expect(await fs.readFile(path.join(dir, "dst", "a.txt"), "utf8")).toBe(
      "A2",
    );
  });
});
