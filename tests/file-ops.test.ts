import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const { SSHService } = createRequire(import.meta.url)(
  "../electron/backend.cjs",
);
const makeService = (
  overwrite: unknown = { approved: true, applyToAll: false },
) =>
  new SSHService({} as object, async () => overwrite) as InstanceType<
    typeof SSHService
  >;
const tmp = async () => fs.mkdtemp(path.join(os.tmpdir(), "sshto-ops-"));

describe("file name validation", () => {
  it("rejects empty, dot, and separator-containing names", () => {
    const svc = makeService();
    for (const bad of ["", ".", "..", "a/b", "a\\b", "  "])
      expect(() => svc.validName(bad)).toThrow();
    expect(svc.validName("ok.txt")).toBe("ok.txt");
  });
});

describe("local rename", () => {
  it("renames a file and refuses silent overwrites", async () => {
    const dir = await tmp();
    const svc = makeService();
    await fs.writeFile(path.join(dir, "a.txt"), "hi");
    await svc.rename(null, path.join(dir, "a.txt"), path.join(dir, "b.txt"));
    expect(await fs.readFile(path.join(dir, "b.txt"), "utf8")).toBe("hi");
    await expect(
      svc.rename(null, path.join(dir, "b.txt"), path.join(dir, "b.txt")),
    ).rejects.toThrow("源和目标相同");
    await fs.writeFile(path.join(dir, "c.txt"), "x");
    await expect(
      svc.rename(null, path.join(dir, "b.txt"), path.join(dir, "c.txt")),
    ).rejects.toThrow("目标已存在");
    await svc.rename(
      null,
      path.join(dir, "b.txt"),
      path.join(dir, "c.txt"),
      true,
    );
    await expect(fs.lstat(path.join(dir, "b.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(path.join(dir, "c.txt"), "utf8")).toBe("hi");
  });
  it("rejects renaming to a path separator name", async () => {
    const dir = await tmp();
    const svc = makeService();
    await fs.writeFile(path.join(dir, "a"), "");
    await expect(
      svc.rename(null, path.join(dir, "a"), path.join(dir, "..", "evil")),
    ).rejects.toThrow();
  });
});

describe("local mkdir/touch", () => {
  it("creates a directory and file, with friendly exists errors", async () => {
    const dir = await tmp();
    const svc = makeService();
    const made = await svc.mkdir(null, dir, "sub");
    expect((await fs.stat(path.join(dir, "sub"))).isDirectory()).toBe(true);
    expect(made.endsWith("sub")).toBe(true);
    await expect(svc.mkdir(null, dir, "sub")).rejects.toThrow("已存在同名");
    const touched = await svc.touch(null, dir, "new.txt");
    expect((await fs.stat(path.join(dir, "new.txt"))).isFile()).toBe(true);
    expect(touched.endsWith("new.txt")).toBe(true);
    await expect(svc.touch(null, dir, "new.txt")).rejects.toThrow("已存在同名");
    await expect(svc.mkdir(null, dir, "x/y")).rejects.toThrow();
  });
});

describe("local delete", () => {
  it("removes nested directories recursively", async () => {
    const dir = await tmp();
    const svc = makeService();
    await fs.mkdir(path.join(dir, "d", "e"), { recursive: true });
    await fs.writeFile(path.join(dir, "d", "e", "f.txt"), "z");
    await fs.symlink(path.join(dir, "d"), path.join(dir, "link"));
    const r = await svc.remove(null, [
      path.join(dir, "d"),
      path.join(dir, "link"),
    ]);
    expect(r.done).toBe(2);
    await expect(fs.lstat(path.join(dir, "d"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.lstat(path.join(dir, "link"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      svc.remove(null, [path.join(dir, "missing")]),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(svc.remove(null, [])).rejects.toThrow();
  });
});

describe("local paste", () => {
  it("copies directories recursively and honours skip decisions", async () => {
    const dir = await tmp();
    const skip = makeService({ approved: false, applyToAll: true });
    const ok = makeService();
    await fs.mkdir(path.join(dir, "src", "inner"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "inner", "f.txt"), "data");
    await fs.writeFile(path.join(dir, "src", "top.txt"), "t");
    await fs.mkdir(path.join(dir, "dst"));
    const r = await ok.paste(
      null,
      "copy",
      [path.join(dir, "src")],
      path.join(dir, "dst"),
    );
    expect(r.skipped).toBe(0);
    expect(
      await fs.readFile(path.join(dir, "dst", "src", "inner", "f.txt"), "utf8"),
    ).toBe("data");
    await fs.writeFile(
      path.join(dir, "dst", "src", "inner", "f.txt"),
      "changed",
    );
    await skip.paste(
      null,
      "copy",
      [path.join(dir, "src")],
      path.join(dir, "dst"),
    );
    expect(
      await fs.readFile(path.join(dir, "dst", "src", "inner", "f.txt"), "utf8"),
    ).toBe("changed");
    await ok.paste(
      null,
      "copy",
      [path.join(dir, "src")],
      path.join(dir, "dst"),
    );
    expect(
      await fs.readFile(path.join(dir, "dst", "src", "inner", "f.txt"), "utf8"),
    ).toBe("data");
  });
  it("moves a file and refuses self-move", async () => {
    const dir = await tmp();
    const svc = makeService();
    await fs.writeFile(path.join(dir, "m.txt"), "m");
    const r = await svc.paste(
      null,
      "move",
      [path.join(dir, "m.txt")],
      path.join(dir),
    );
    expect(r.skipped).toBe(1);
    await fs.mkdir(path.join(dir, "out"));
    const r2 = await svc.paste(
      null,
      "move",
      [path.join(dir, "m.txt")],
      path.join(dir, "out"),
    );
    expect(r2.moved).toHaveLength(1);
    expect(await fs.readFile(path.join(dir, "out", "m.txt"), "utf8")).toBe("m");
    await expect(fs.lstat(path.join(dir, "m.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("local stat", () => {
  it("returns directory, size and mode info", async () => {
    const dir = await tmp();
    const svc = makeService();
    await fs.writeFile(path.join(dir, "s.txt"), "12345");
    const st = await svc.stat(null, path.join(dir, "s.txt"));
    expect(st.directory).toBe(false);
    expect(st.size).toBe(5);
    expect(st.mode).toBeGreaterThan(0);
    const d = await svc.stat(null, dir);
    expect(d.directory).toBe(true);
  });
});
