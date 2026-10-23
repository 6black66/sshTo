import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
const { SSHService } = createRequire(import.meta.url)(
  "../electron/backend.cjs",
);
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sshto-conflicts-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
async function fixture(approve: Function) {
  const source = path.join(root, "remote", "bundle"),
    destination = path.join(root, "local");
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(path.join(destination, "bundle"), { recursive: true });
  for (const name of ["a.txt", "b.txt"]) {
    await fs.writeFile(path.join(source, name), "new " + name);
    await fs.writeFile(path.join(destination, "bundle", name), "old " + name);
  }
  await fs.writeFile(path.join(source, "added.txt"), "new file");
  await fs.writeFile(path.join(destination, "bundle", "keep.txt"), "keep me");
  const ftp = {
    lstat: (p: string, cb: Function) => {
      void fs.lstat(p).then((st) => cb(null, st), cb);
    },
    readdir: (p: string, cb: Function) => {
      void fs.readdir(p).then(
        (names) =>
          cb(
            null,
            names.sort().map((filename) => ({ filename })),
          ),
        cb,
      );
    },
    createReadStream,
  };
  const service = new SSHService({}, approve);
  service.sessions.set("session", { sftp: ftp, closed: false });
  const task = (id = "task", dest = destination) => ({
    id,
    sessionId: "session",
    direction: "download",
    sources: [source],
    destination: dest,
    status: "queued",
    bytes: 0,
    total: 0,
    cancelled: false,
    skipped: 0,
  });
  const content = (name: string) =>
    fs.readFile(path.join(destination, "bundle", name), "utf8");
  return { service, task, content, source, destination };
}
describe("apply conflict decisions to a transfer", () => {
  it("prompts once for overwrite-all and merges folders without deleting other files", async () => {
    const questions: any[] = [];
    const f = await fixture((q: unknown) => {
      questions.push(q);
      return { approved: true, applyToAll: true };
    });
    const task = f.task();
    await f.service.run(task);
    expect(questions).toHaveLength(1);
    expect(questions[0].taskId).toBe("task");
    expect(await f.content("a.txt")).toBe("new a.txt");
    expect(await f.content("b.txt")).toBe("new b.txt");
    expect(await f.content("keep.txt")).toBe("keep me");
    expect(await f.content("added.txt")).toBe("new file");
  });
  it("prompts once for skip-all and still copies nonconflicting files", async () => {
    let prompts = 0;
    const f = await fixture(() => {
      prompts++;
      return { approved: false, applyToAll: true };
    });
    const task = f.task();
    await f.service.run(task);
    expect(prompts).toBe(1);
    expect(task.skipped).toBe(2);
    expect(await f.content("a.txt")).toBe("old a.txt");
    expect(await f.content("b.txt")).toBe("old b.txt");
    expect(await f.content("added.txt")).toBe("new file");
  });
  it("continues prompting individually when the checkbox is not selected", async () => {
    let prompts = 0;
    const f = await fixture(() => ({
      approved: ++prompts === 1,
      applyToAll: false,
    }));
    await f.service.run(f.task());
    expect(prompts).toBe(2);
    expect(await f.content("a.txt")).toBe("new a.txt");
    expect(await f.content("b.txt")).toBe("old b.txt");
  });
  it("resets choices for new runs and accepts existing boolean approval callbacks", async () => {
    let prompts = 0;
    const f = await fixture(() => {
      prompts++;
      return { approved: true, applyToAll: true };
    });
    await f.service.run(f.task());
    expect(prompts).toBe(1);
    f.service.approve = () => {
      prompts++;
      return false;
    };
    const retried = f.task("retry");
    await f.service.run(retried);
    expect(prompts).toBe(4);
    expect(retried.skipped).toBe(3);
  });
  it("keeps concurrent task choices separate", async () => {
    const counts: Record<string, number> = {};
    const f = await fixture((q: { taskId: string }) => {
      counts[q.taskId] = (counts[q.taskId] || 0) + 1;
      return { approved: false, applyToAll: q.taskId === "all" };
    });
    const other = path.join(root, "other");
    await fs.mkdir(path.join(other, "bundle"), { recursive: true });
    for (const name of ["a.txt", "b.txt"])
      await fs.writeFile(path.join(other, "bundle", name), "old");
    await Promise.all([
      f.service.run(f.task("all")),
      f.service.run(f.task("each", other)),
    ]);
    expect(counts).toEqual({ all: 1, each: 2 });
  });
  it("honors cancellation while a conflict prompt is open", async () => {
    const f = await fixture(() => {
      task.cancelled = true;
      return { approved: false, applyToAll: true };
    });
    const task = f.task();
    await expect(f.service.run(task)).rejects.toThrow("传输已取消");
    expect(await f.content("a.txt")).toBe("old a.txt");
  });
});
