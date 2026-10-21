import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const { Store, routeFor, validateDevice } = createRequire(import.meta.url)(
  "../electron/backend.cjs",
);
const device = (id = "target", jumps: string[] = []) => ({
  id,
  name: id,
  host: "127.0.0.1",
  port: 22,
  username: "tester",
  auth: "password",
  jumps,
});
describe("device configuration", () => {
  it("validates required connection fields and ports", () => {
    expect(() => validateDevice({ ...device(), port: 0 })).toThrow();
    expect(() => validateDevice({ ...device(), host: "" })).toThrow();
    expect(() => validateDevice({ ...device(), auth: "key" })).toThrow();
    expect(validateDevice(device()).port).toBe(22);
  });
  it("builds ordered jump routes and refuses missing/repeated hosts", () => {
    const a = device("a"),
      b = device("b"),
      target = device("target", ["a", "b"]);
    expect(
      routeFor(target, [a, b, target]).map((d: { id: string }) => d.id),
    ).toEqual(["a", "b", "target"]);
    expect(() => routeFor(device("target", ["missing"]), [])).toThrow();
    expect(() => routeFor(device("target", ["target"]), [device()])).toThrow();
    expect(() => routeFor(device("target", ["a", "a"]), [a])).toThrow();
  });
});
describe("credential persistence", () => {
  it("persists encrypted secrets, keeps session passwords in memory, and protects referenced hosts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshto-test-"));
    const vault = {
      available: () => true,
      encrypt: async (s: string) => Buffer.from(s).toString("base64"),
      decrypt: async (s: string) => Buffer.from(s, "base64").toString(),
    };
    try {
      const s = new Store(dir, vault);
      await s.init();
      await s.save(device("a"), "never-in-json", true);
      await s.save(device("b", ["a"]), "memory-only", false);
      const text = await fs.readFile(path.join(dir, "config.json"), "utf8");
      expect(text).not.toContain("never-in-json");
      expect(text).not.toContain("memory-only");
      expect(await s.secret("b")).toBe("memory-only");
      const reloaded = new Store(dir, vault);
      await reloaded.init();
      expect(await reloaded.secret("a")).toBe("never-in-json");
      expect(await reloaded.secret("b")).toBe("");
      await expect(s.remove("a")).rejects.toThrow();
      expect(s.list()[0]).not.toHaveProperty("password");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("refuses persistent secrets without a secure vault", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshto-test-"));
    try {
      const s = new Store(dir, { available: () => false });
      await s.init();
      await expect(s.save(device(), "secret", true)).rejects.toThrow();
      await s.save(device(), "secret", false);
      expect(await s.secret("target")).toBe("secret");
      expect(
        await fs.readFile(path.join(dir, "config.json"), "utf8"),
      ).not.toContain('secret"');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("serializes concurrent configuration writes without corrupting JSON", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshto-test-"));
    try {
      const s = new Store(dir, { available: () => false });
      await s.init();
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          s.save(device(String(i)), "", false),
        ),
      );
      expect(
        JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8"))
          .devices,
      ).toHaveLength(12);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
