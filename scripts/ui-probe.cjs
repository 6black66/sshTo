// End-to-end UI regression probe (Playwright + Electron + SSH fixture).
// Run with `npm run test:ui-probe` (xvfb) or `node scripts/ui-probe.cjs` on a real display.
// Covers: file list multi-selection, terminal row clipping after panel drag,
// preview window maximize/restore/resize with size persistence, edit-mode
// syntax highlighting, the large-file fallback editor and remote save.
const { _electron: electron } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { fixture } = require("./ssh-fixture.cjs");

const bigLog = (lines) => {
  const rows = [];
  for (let i = 0; i < lines; i++)
    rows.push(
      `[2026-01-01 00:00:00.000][INFO] [Probe::line${i}] 中文日志内容 ${"x".repeat(60)}`,
    );
  rows.push("[2026-01-01 00:00:01.000][INFO] PROBE-TAIL-MARKER 清理完成");
  return rows.join("\n") + "\n";
};

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sshto-probe-ui-"));
  let app, server;
  const ok = (name, cond, extra) =>
    console.log(
      (cond ? "PASS " : "FAIL ") + name + (extra ? " | " + extra : ""),
    );
  try {
    const remote = path.join(root, "remote");
    await fs.mkdir(remote);
    await fs.writeFile(path.join(remote, "a.txt"), "a\n");
    await fs.writeFile(path.join(remote, "b.txt"), "b\n");
    await fs.writeFile(path.join(remote, "c.txt"), "c\n");
    await fs.writeFile(path.join(remote, "d.txt"), "d\n");
    await fs.writeFile(path.join(remote, "del.txt"), "delete me\n");
    await fs.writeFile(path.join(remote, "2.txt"), "2\n");
    await fs.writeFile(path.join(remote, "10.txt"), "10\n");
    await fs.writeFile(path.join(remote, "100.txt"), "100\n");
    await fs.mkdir(path.join(remote, "z-dir"));
    await fs.writeFile(path.join(remote, "z-dir", "inner.txt"), "i\n");
    await fs.writeFile(
      path.join(remote, "note.xml"),
      '<config>你好\n  <tag a="1">x</tag>\n</config>',
    );
    await fs.writeFile(path.join(remote, "big.log"), bigLog(2300));
    server = await fixture(remote, {});
    app = await electron.launch({
      executablePath: process.env.SSHTO_EXECUTABLE,
      args: [
        ...(process.env.SSHTO_EXECUTABLE ? [] : ["."]),
        "--no-sandbox",
        "--user-data-dir=" + path.join(root, "profile"),
      ],
      cwd: path.resolve(__dirname, ".."),
      timeout: 30000,
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    });
    await page.getByRole("heading", { name: "连接设备，打开可能。" }).waitFor();
    await page
      .getByRole("button", { name: "添加 SSH 设备", exact: true })
      .click();
    await page.getByLabel("设备名称", { exact: true }).fill("probe");
    await page.getByLabel("主机 / IP 地址").fill("127.0.0.1");
    await page.getByLabel("端口", { exact: true }).fill(String(server.port));
    await page.getByLabel("用户名", { exact: true }).fill("tester");
    await page.getByLabel("登录密码", { exact: true }).fill("test-secret");
    await page.getByRole("button", { name: "保存设备", exact: true }).click();
    await page.getByTitle("连接设备", { exact: true }).click();
    await page.locator(".session-state.connected").waitFor({ timeout: 20000 });
    const remoteBrowser = page.locator(".browser").nth(1);
    const entry = (name) =>
      remoteBrowser.getByRole("button", { name, exact: true });
    await entry("big.log").waitFor({ timeout: 15000 });

    // Natural sort: numbered files must order 2, 10, 100 (not 1, 10, 100 style
    // lexicographic order); directories still come first.
    const entryOrder = await page
      .locator(".browser")
      .nth(1)
      .locator(".entry")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("aria-label") || ""),
      );
    ok(
      "natural sort orders 2, 10, 100 with dirs first",
      entryOrder[0] === "z-dir" &&
        entryOrder.slice(1, 4).join() === "2.txt,10.txt,100.txt",
      JSON.stringify(entryOrder),
    );

    // File list selection: shift range, plain reset, ctrl add.
    // Note: the browser renders dirs first (z-dir on top), then a..d — a shift
    // range from a.txt to d.txt must follow the rendered order without gaps.
    await entry("a.txt").click();
    await entry("d.txt").click({ modifiers: ["Shift"] });
    const rangeNames = await page.locator(".entry.selected").allInnerTexts();
    ok(
      "shift+click selects rendered-order range without gaps",
      (await page.locator(".entry.selected").count()) === 5 &&
        !rangeNames.some((t) => t.includes("z-dir")),
      JSON.stringify(rangeNames.map((t) => t.split("\n")[0])),
    );
    await entry("z-dir").click();
    await entry("d.txt").click({ modifiers: ["Shift"] });
    const crossNames = await page.locator(".entry.selected").allInnerTexts();
    ok(
      "shift range across dir/file boundary selects all",
      (await page.locator(".entry.selected").count()) === 9 &&
        JSON.stringify(crossNames.map((t) => t.split("\n")[0])),
    );
    await entry("b.txt").click();
    ok(
      "plain click resets selection",
      (await page.locator(".entry.selected").count()) === 1,
    );
    await entry("a.txt").click({ modifiers: ["Control"] });
    ok(
      "ctrl+click adds to selection",
      (await page.locator(".entry.selected").count()) === 2,
    );

    // Terminal last row must not be clipped after dragging the file panel.
    const handle = page.getByRole("separator", { name: "调整文件管理高度" });
    const hb = await handle.boundingBox();
    let worst = -Infinity;
    for (const delta of [100, 200, 300]) {
      await page.mouse.move(hb.x + 4, hb.y + 4);
      await page.mouse.down();
      await page.mouse.move(hb.x + 4, hb.y + 4 - delta, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      worst = Math.max(
        worst,
        await page.evaluate(() => {
          const term = document
            .querySelector(".terminal")
            .getBoundingClientRect();
          const rows = document.querySelector(".xterm-rows");
          const lastRow =
            rows && rows.lastElementChild
              ? rows.lastElementChild.getBoundingClientRect()
              : null;
          return lastRow ? lastRow.bottom - term.bottom : 0;
        }),
      );
    }
    ok(
      "terminal last row not clipped after panel drag",
      worst <= 0,
      "overflow=" + worst.toFixed(2) + "px",
    );

    // Preview window: maximize button, double-click heading, resize handle.
    await entry("note.xml").dblclick();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 10000 });
    const panel = page.locator(".file-preview");
    const vp = await page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
    }));
    const rect = () =>
      panel.evaluate((el) => el.getBoundingClientRect().toJSON());
    const before = await rect();
    await dialog
      .getByTitle("最大化窗口（双击标题栏同样生效）", { exact: true })
      .click();
    const max = await rect();
    ok(
      "maximize fills viewport",
      Math.abs(max.width - vp.w) < 2 && Math.abs(max.height - vp.h) < 2,
    );
    ok(
      "overlay padding removed",
      (await page
        .locator(".preview-overlay")
        .evaluate((el) => getComputedStyle(el).paddingTop)) === "0px",
    );
    await dialog
      .getByTitle("还原窗口（双击标题栏同样生效）", { exact: true })
      .click();
    const restored = await rect();
    ok(
      "restore returns to default size",
      Math.abs(restored.width - before.width) < 2 &&
        Math.abs(restored.height - before.height) < 2,
    );
    await page
      .locator(".preview-heading")
      .dblclick({ position: { x: 30, y: 10 } });
    ok("dblclick heading maximizes", Math.abs((await rect()).width - vp.w) < 2);
    await page
      .locator(".preview-heading")
      .dblclick({ position: { x: 30, y: 10 } });
    ok(
      "dblclick heading restores",
      Math.abs((await rect()).width - before.width) < 2,
    );
    const grip = page.locator(".preview-resize-handle");
    const gb = await grip.boundingBox();
    await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
    await page.mouse.down();
    await page.mouse.move(gb.x + 150, gb.y + 100, { steps: 6 });
    await page.mouse.up();
    const resized = await rect();
    ok(
      "corner drag enlarges panel",
      resized.width > restored.width + 100 &&
        resized.height > restored.height + 50,
    );
    const saved = JSON.parse(
      (await page.evaluate(() => localStorage.getItem("preview-size"))) || "{}",
    );
    ok(
      "size persisted to localStorage",
      Math.abs(saved.w - Math.round(resized.width)) < 3 &&
        Math.abs(saved.h - Math.round(resized.height)) < 3,
    );

    // Edit mode on a highlightable file: overlay, transparent textarea, live re-highlight, save.
    await dialog.getByRole("button", { name: "编辑", exact: true }).click();
    await page.waitForTimeout(500);
    const ta = dialog.getByLabel("文件内容编辑区");
    await ta.waitFor();
    ok(
      "editor text transparent over highlight",
      (await ta.evaluate((el) => getComputedStyle(el).color)) ===
        "rgba(0, 0, 0, 0)",
    );
    const hl = dialog.locator(".preview-editor-hl");
    ok("highlight layer rendered", (await hl.count()) === 1);
    const sizes = await page.evaluate(() => ({
      ta: document.querySelector(".preview-editor").getBoundingClientRect()
        .height,
      hl: document.querySelector(".preview-editor-hl").getBoundingClientRect()
        .height,
    }));
    ok(
      "overlay textarea fills panel",
      Math.abs(sizes.ta - sizes.hl) < 2 && sizes.ta > 300,
      JSON.stringify(sizes),
    );
    await ta.focus();
    await ta.press("ControlOrMeta+End");
    await ta.type('\n<new attr="v">');
    await page.waitForTimeout(700);
    ok("highlight follows typing", (await hl.textContent()).includes("<new"));
    await dialog.getByRole("button", { name: /保存/ }).click();
    await page.getByText("已保存", { exact: true }).waitFor({ timeout: 10000 });
    ok(
      "save persists typed content",
      (await fs.readFile(path.join(remote, "note.xml"), "utf8")).includes(
        "<new",
      ),
    );

    // Large log (over the highlight limit): fallback editor fills the panel and reaches the tail.
    await dialog.getByTitle("关闭预览", { exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await entry("big.log").dblclick();
    await dialog.waitFor({ timeout: 10000 });
    await dialog.getByLabel("文件内容").waitFor();
    ok(
      "big log preview falls back to plain text",
      (await dialog
        .getByText("内容较大，使用纯文本显示", { exact: true })
        .count()) === 1,
    );
    await dialog.getByRole("button", { name: "编辑", exact: true }).click();
    const bigTa = dialog.getByLabel("文件内容编辑区");
    await bigTa.waitFor();
    await page.waitForTimeout(300);
    const bigSizes = await page.evaluate(() => {
      const stack = document.querySelector(".preview-editor-stack");
      const ta = document.querySelector(".preview-editor");
      return {
        stackH: Math.round(stack.getBoundingClientRect().height),
        taH: Math.round(ta.getBoundingClientRect().height),
        overlay: !!document.querySelector(".preview-editor-hl"),
      };
    });
    ok("no highlight overlay over the highlight limit", !bigSizes.overlay);
    ok(
      "fallback editor fills panel height",
      Math.abs(bigSizes.taH - bigSizes.stackH) < 3,
      JSON.stringify(bigSizes),
    );
    await bigTa.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(200);
    const tail = await bigTa.evaluate((el) => ({
      visible: el.scrollHeight - el.scrollTop - el.clientHeight < 2,
      text: el.value.slice(-40),
    }));
    ok(
      "file tail reachable and visible",
      tail.visible && tail.text.includes("PROBE-TAIL-MARKER"),
      JSON.stringify(tail.text),
    );

    // Delete confirmation modal: Enter must delete (not leak to the entry's
    // open action), Escape must cancel.
    await dialog.getByTitle("关闭预览", { exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await entry("del.txt").click();
    await page.keyboard.press("Delete");
    await dialog
      .getByText("确认删除", { exact: true })
      .waitFor({ timeout: 5000 });
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "detached" });
    ok(
      "enter in delete dialog deletes, does not open preview",
      (await page.locator(".file-preview").count()) === 0,
    );
    await remoteBrowser.getByTitle("刷新目录", { exact: true }).click();
    await entry("del.txt")
      .waitFor({ state: "detached", timeout: 10000 })
      .catch(async () => {
        await remoteBrowser.getByTitle("刷新目录", { exact: true }).click();
        await entry("del.txt").waitFor({ state: "detached", timeout: 10000 });
      });
    ok("file actually deleted", true);
    await entry("d.txt").click();
    await page.keyboard.press("Delete");
    await dialog
      .getByText("确认删除", { exact: true })
      .waitFor({ timeout: 5000 });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    ok(
      "escape in delete dialog cancels",
      (await page.locator(".file-preview").count()) === 0,
    );
    await remoteBrowser.getByTitle("刷新目录", { exact: true }).click();
    await entry("d.txt").waitFor({ timeout: 10000 });

    ok("no page errors", errors.length === 0);
    if (errors.length) console.log(errors.slice(0, 10));
  } catch (e) {
    console.log(
      "PROBE FAILURE:",
      e.message.split("\n")[0],
      "|",
      e.stack.split("\n").slice(1, 3).join(" | "),
    );
    if (app) {
      try {
        const p = await app.firstWindow();
        await fs.mkdir("test-results", { recursive: true });
        await p.screenshot({ path: "test-results/ui-probe-failure.png" });
        console.log((await p.locator("body").innerText()).slice(-1500));
      } catch {}
    }
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
    if (server) await server.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
})();
