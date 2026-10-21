import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PassThrough } from "node:stream";
const { PreviewReader, PREVIEW_LIMIT } = createRequire(import.meta.url)(
  "../electron/preview.cjs",
);
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sshto-preview-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const localReader = () =>
  new PreviewReader(() => {
    throw Error("not remote");
  });
describe("read-only file preview", () => {
  it("reads UTF-8, BOM, empty files and file symlinks without modifying them", async () => {
    const reader = localReader(),
      file = path.join(root, "config.xml");
    const text = "<config>你好\n  value\t= 1</config>";
    await fs.writeFile(file, text);
    await fs.symlink("config.xml", path.join(root, "link"));
    expect((await reader.read("one", null, path.join(root, "link"))).text).toBe(
      text,
    );
    expect(await fs.readFile(file, "utf8")).toBe(text);
    await fs.writeFile(file, "\uFEFF" + text);
    expect((await reader.read("bom", null, file)).text).toBe(text);
    await fs.writeFile(file, "");
    expect(await reader.read("empty", null, file)).toEqual({
      text: "",
      bytesRead: 0,
      truncated: false,
    });
    expect(reader.requests.size).toBe(0);
  });
  it("caps reads at 1 MiB and handles a UTF-8 codepoint split by the cap", async () => {
    const reader = localReader(),
      file = path.join(root, "large.log");
    await fs.writeFile(
      file,
      Buffer.concat([Buffer.alloc(PREVIEW_LIMIT - 1, 97), Buffer.from("中文")]),
    );
    const result = await reader.read("large", null, file);
    expect(result.truncated).toBe(true);
    expect(result.bytesRead).toBe(PREVIEW_LIMIT);
    expect(result.text).toBe("a".repeat(PREVIEW_LIMIT - 1));
    await fs.writeFile(file, Buffer.alloc(PREVIEW_LIMIT, 97));
    expect((await reader.read("exact", null, file)).truncated).toBe(false);
  });
  it("rejects binary, non UTF-8, missing files, folders and broken links", async () => {
    const reader = localReader(),
      file = path.join(root, "sample");
    for (const bytes of [
      Buffer.from([0x7f, 69, 76, 70, 0]),
      Buffer.from([0xff, 0xfe, 0x41, 0]),
      Buffer.from([0xe4, 0xb8]),
    ]) {
      await fs.writeFile(file, bytes);
      await expect(reader.read("unsupported", null, file)).rejects.toThrow(
        "UTF-8",
      );
    }
    await expect(reader.read("folder", null, root)).rejects.toThrow("普通文件");
    await expect(
      reader.read("missing", null, path.join(root, "missing")),
    ).rejects.toThrow();
    await fs.symlink("missing", path.join(root, "broken"));
    await expect(
      reader.read("broken", null, path.join(root, "broken")),
    ).rejects.toThrow();
    expect(reader.requests.size).toBe(0);
  });
  it("cancels an in-progress remote stream and leaves other sessions untouched", async () => {
    const streams: PassThrough[] = [];
    const ftp = {
      stat: (_p: unknown, cb: Function) => cb(null, { isFile: () => true }),
      createReadStream: () => {
        const stream = new PassThrough();
        streams.push(stream);
        return stream;
      },
    };
    const reader = new PreviewReader(() => ftp);
    const first = reader.read("first", "a", "/file"),
      second = reader.read("second", "b", "/file");
    const cancelled = expect(first).rejects.toThrow("连接已断开");
    await new Promise(setImmediate);
    reader.cancelSession("a");
    await cancelled;
    expect(streams[0].destroyed).toBe(true);
    expect(streams[1].destroyed).toBe(false);
    streams[1].end("second session");
    expect((await second).text).toBe("second session");
    expect(reader.requests.size).toBe(0);
  });
  it("cancels pending metadata and ignores late callbacks", async () => {
    let callback: Function = () => {};
    let opened = false;
    const reader = new PreviewReader(() => ({
      stat: (_p: unknown, cb: Function) => {
        callback = cb;
      },
      createReadStream: () => {
        opened = true;
        return new PassThrough();
      },
    }));
    const pending = reader.read("cancel", "a", "/file");
    const cancelled = expect(pending).rejects.toThrow("取消");
    reader.cancel("cancel");
    await cancelled;
    callback(null, { isFile: () => true });
    await new Promise(setImmediate);
    expect(opened).toBe(false);
    expect(reader.requests.size).toBe(0);
  });
  it("times out stalled reads and propagates permission failures", async () => {
    const stream = new PassThrough();
    const reader = new PreviewReader(
      () => ({
        stat: (_p: unknown, cb: Function) => cb(null, { isFile: () => true }),
        createReadStream: () => stream,
      }),
      30,
    );
    await expect(reader.read("timeout", "a", "/file")).rejects.toThrow(
      "读取超时",
    );
    expect(stream.destroyed).toBe(true);
    expect(reader.requests.size).toBe(0);
    const denied = new PreviewReader(() => ({
      stat: (_p: unknown, cb: Function) => cb(Error("Permission denied")),
    }));
    await expect(denied.read("denied", "a", "/private")).rejects.toThrow(
      "Permission denied",
    );
    expect(denied.requests.size).toBe(0);
  });
});
