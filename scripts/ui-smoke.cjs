const { _electron: electron, expect } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { fixture } = require("./ssh-fixture.cjs");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sshto-ui-"));
  let app, server;
  try {
    const remote = path.join(root, "remote"),
      local = path.join(root, "local");
    await fs.mkdir(remote);
    await fs.mkdir(local);
    await fs.writeFile(path.join(local, "拖拽测试.txt"), "Hello from sshTo");
    const terminalInput = [];
    server = await fixture(remote, {
      readDelay: 400,
      onInput: (buffer) => terminalInput.push(Buffer.from(buffer)),
    });
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
    page.on("pageerror", (e) => errors.push(e.message));
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
    await page.getByLabel("设备名称", { exact: true }).fill("开发服务器");
    await page.getByLabel("主机 / IP 地址").fill("127.0.0.1");
    await page.getByLabel("端口", { exact: true }).fill(String(server.port));
    await page.getByLabel("用户名", { exact: true }).fill("tester");
    await page.getByLabel("登录密码", { exact: true }).fill("test-secret");
    await page.getByRole("button", { name: "保存设备", exact: true }).click();
    await page.getByTitle("连接设备", { exact: true }).click();
    await page.locator(".session-state.connected").waitFor({ timeout: 20000 });
    await page
      .locator(".browser")
      .nth(1)
      .locator(".file-empty")
      .filter({ hasText: "此目录为空" })
      .waitFor();
    const fileHandle = page.getByRole("separator", {
      name: "调整文件管理高度",
      exact: true,
    });
    const panelHeight = () =>
      page
        .locator(".file-panel")
        .evaluate((el) => el.getBoundingClientRect().height);
    const initialHeight = await panelHeight();
    const workspaceHeight = await page
      .locator(".workspace-content")
      .evaluate((el) => el.clientHeight);
    assert(
      Math.abs(initialHeight - (workspaceHeight - 8) / 2) < 2,
      "File panel should start at half height",
    );
    const dragFiles = async (delta) => {
      const rect = await fileHandle.boundingBox();
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2 + delta,
        { steps: 8 },
      );
      await page.mouse.up();
    };
    await dragFiles(-100);
    assert((await panelHeight()) > initialHeight + 90);
    await dragFiles(200);
    assert((await panelHeight()) < initialHeight - 90);
    await dragFiles(-1000);
    assert((await page.locator(".terminals").boundingBox()).height >= 179);
    await dragFiles(1000);
    assert((await panelHeight()) >= 179);
    await fileHandle.dblclick();
    assert(Math.abs((await panelHeight()) - initialHeight) < 2);
    await fileHandle.focus();
    await page.keyboard.press("ArrowUp");
    assert((await panelHeight()) > initialHeight + 20);
    await fileHandle.dblclick();
    console.log(
      "✓ File panel defaults to 50%, resizes both ways, respects minimums and resets on double click",
    );
    await fs.mkdir(path.join(remote, "plugin-target"));
    await fs.writeFile(
      path.join(remote, "plugin-target", "inside.txt"),
      "linked content",
    );
    await fs.symlink("plugin-target", path.join(remote, "plugins"));
    await fs.symlink("missing", path.join(remote, "broken-link"));
    const remoteBrowser = page.locator(".browser").nth(1);
    await remoteBrowser.getByTitle("刷新目录", { exact: true }).click();
    const pluginLink = remoteBrowser.getByRole("button", {
      name: "plugins",
      exact: true,
    });
    await pluginLink.dblclick();
    await remoteBrowser
      .getByRole("button", { name: "inside.txt", exact: true })
      .waitFor();
    await remoteBrowser.getByTitle("上级目录", { exact: true }).click();
    await pluginLink.focus();
    await page.keyboard.press("Enter");
    await remoteBrowser
      .getByRole("button", { name: "inside.txt", exact: true })
      .waitFor();
    await remoteBrowser.getByTitle("上级目录", { exact: true }).click();
    await remoteBrowser
      .getByRole("button", { name: "broken-link", exact: true })
      .dblclick();
    await page
      .locator(".file-error")
      .filter({ hasText: "软链接目标不存在" })
      .waitFor();
    await page.getByTitle("关闭错误", { exact: true }).click();
    console.log(
      "✓ Remote symlink folders open by double-click and Enter; broken links show a clear error",
    );
    // Open four independent tabs, then verify split layout and resizing.
    for (let i = 0; i < 3; i++) {
      await page.getByTitle("连接设备", { exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".session-state.connected").length ===
          document.querySelectorAll(".tab").length,
      );
    }
    await page.getByTitle("左右分屏", { exact: true }).click();
    assert.equal(await page.locator(".terminal-pane:visible").count(), 4);
    const handle = page.getByRole("separator").first();
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + 2, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 50, box.y + 30);
    await page.mouse.up();
    await page.getByTitle("左右分屏", { exact: true }).click();
    const localPath = page.getByLabel("本地路径", { exact: true });
    await localPath.fill(local);
    await localPath.press("Enter");
    await page
      .locator(".browser")
      .first()
      .getByRole("button", { name: "拖拽测试.txt", exact: true })
      .waitFor();
    await page
      .locator(".browser")
      .nth(1)
      .getByRole("button", { name: "plugins", exact: true })
      .waitFor();
    assert.equal(await page.getByText("修改时间", { exact: true }).count(), 2);
    const timestamp = await page
      .locator(".browser")
      .first()
      .getByRole("button", { name: "拖拽测试.txt", exact: true })
      .locator(".file-mtime")
      .innerText();
    assert.match(timestamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const dt = await page.evaluateHandle(() => new DataTransfer());
    await page
      .locator(".browser")
      .first()
      .getByRole("button", { name: "拖拽测试.txt", exact: true })
      .dispatchEvent("dragstart", { dataTransfer: dt });
    await page
      .locator(".browser")
      .nth(1)
      .dispatchEvent("drop", { dataTransfer: dt });
    await page
      .locator(".task-status")
      .filter({ hasText: "已完成" })
      .waitFor({ timeout: 15000 });
    assert.equal(
      await fs.readFile(path.join(remote, "拖拽测试.txt"), "utf8"),
      "Hello from sshTo",
    );
    await page.getByRole("button", { name: "传输队列", exact: true }).click();
    await page
      .locator(".browser")
      .nth(1)
      .getByRole("button", { name: "拖拽测试.txt", exact: true })
      .waitFor();
    const remoteTimestamp = await page
      .locator(".browser")
      .nth(1)
      .getByRole("button", { name: "拖拽测试.txt", exact: true })
      .locator(".file-mtime")
      .innerText();
    assert.match(remoteTimestamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    console.log(
      "✓ Local and remote file rows display modification date and time",
    );

    const previewText =
      "<config>你好\n  <script>window.previewInjected=true</script>\n</config>";
    await fs.writeFile(path.join(local, "note.xml"), previewText);
    await fs.writeFile(
      path.join(local, "large.log"),
      "x".repeat(1024 * 1024 + 10),
    );
    await fs.writeFile(path.join(local, "empty.txt"), "");
    await fs.writeFile(
      path.join(local, "config.json"),
      JSON.stringify({ enabled: true, port: 22, name: "中文" }),
    );
    await fs.writeFile(
      path.join(local, "binary.bin"),
      Buffer.from([0, 1, 2, 255]),
    );
    await fs.writeFile(path.join(remote, "slow.txt"), "old remote result");
    await fs.symlink("拖拽测试.txt", path.join(remote, "file-link"));
    const localBrowser = page.locator(".browser").first();
    await localBrowser.getByTitle("刷新目录", { exact: true }).click();
    await remoteBrowser.getByTitle("刷新目录", { exact: true }).click();
    const note = localBrowser.getByRole("button", {
      name: "note.xml",
      exact: true,
    });
    await note.dblclick();
    const previewDialog = page.getByRole("dialog");
    await previewDialog.getByLabel("文件内容").waitFor();
    await previewDialog.locator(".hljs-name").first().waitFor();
    assert.notEqual(
      await previewDialog
        .locator(".hljs-name")
        .first()
        .evaluate((el) => getComputedStyle(el).color),
      await previewDialog
        .getByLabel("文件内容")
        .evaluate((el) => getComputedStyle(el).color),
    );
    assert.equal(
      await previewDialog.getByLabel("文件内容").textContent(),
      previewText,
    );
    assert.equal(
      await previewDialog
        .locator("input,textarea,[contenteditable=true],script")
        .count(),
      0,
    );
    await previewDialog
      .getByRole("button", { name: "复制全部", exact: true })
      .click();
    await previewDialog
      .getByRole("button", { name: "已复制", exact: true })
      .waitFor();
    assert.equal(
      await app.evaluate(({ clipboard }) => clipboard.readText()),
      previewText,
    );
    await fs.mkdir("test-results", { recursive: true });
    await page.screenshot({ path: "test-results/preview.png" });
    await page.keyboard.press("Escape");
    await previewDialog.waitFor({ state: "detached" });
    await remoteBrowser
      .getByRole("button", { name: "file-link", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await previewDialog.getByLabel("文件内容").waitFor();
    assert.equal(
      await previewDialog.getByLabel("文件内容").textContent(),
      "Hello from sshTo",
    );
    await previewDialog.getByTitle("关闭预览", { exact: true }).click();
    await remoteBrowser
      .getByRole("button", { name: "slow.txt", exact: true })
      .dblclick();
    await previewDialog.getByText("正在读取文件…", { exact: true }).waitFor();
    await previewDialog.getByTitle("关闭预览", { exact: true }).click();
    await note.focus();
    await page.keyboard.press("Enter");
    await previewDialog.getByLabel("文件内容").waitFor();
    await page.waitForTimeout(1000);
    assert.equal(
      await previewDialog.getByLabel("文件内容").textContent(),
      previewText,
    );
    await previewDialog.getByTitle("关闭预览", { exact: true }).click();
    await localBrowser
      .getByRole("button", { name: "config.json", exact: true })
      .dblclick();
    await previewDialog.locator(".hljs-string").first().waitFor();
    assert.notEqual(
      await previewDialog
        .locator(".hljs-string")
        .first()
        .evaluate((el) => getComputedStyle(el).color),
      await previewDialog
        .locator(".hljs-number")
        .first()
        .evaluate((el) => getComputedStyle(el).color),
    );
    await previewDialog.getByTitle("关闭预览", { exact: true }).click();
    await localBrowser
      .getByRole("button", { name: "large.log", exact: true })
      .dblclick();
    await previewDialog.locator(".preview-notice").waitFor();
    assert.equal(
      (await previewDialog.getByLabel("文件内容").textContent()).length,
      1024 * 1024,
    );
    await previewDialog
      .getByText("内容较大，使用纯文本显示", { exact: true })
      .waitFor();
    await previewDialog.getByTitle("关闭预览", { exact: true }).click();
    await localBrowser
      .getByRole("button", { name: "empty.txt", exact: true })
      .dblclick();
    await previewDialog.getByText("此文件为空", { exact: true }).waitFor();
    await previewDialog.getByTitle("关闭预览", { exact: true }).click();
    await localBrowser
      .getByRole("button", { name: "binary.bin", exact: true })
      .dblclick();
    await previewDialog
      .getByRole("alert")
      .filter({ hasText: "UTF-8" })
      .waitFor();
    assert(
      await previewDialog
        .getByRole("button", { name: "复制全部", exact: true })
        .isDisabled(),
    );
    await previewDialog.getByTitle("关闭预览", { exact: true }).click();
    console.log(
      "✓ Read-only preview: local XML, remote file link, copy, Escape, empty and large files, binary rejection and stale-response isolation",
    );

    const conflictNames = ["overwrite-a.txt", "overwrite-b.txt"];
    for (const name of conflictNames) {
      await fs.writeFile(path.join(local, name), "local old");
      await fs.writeFile(path.join(remote, name), "remote " + name);
    }
    await localBrowser.getByTitle("刷新目录", { exact: true }).click();
    await remoteBrowser.getByTitle("刷新目录", { exact: true }).click();
    let conflictRuns = 0;
    const chooseAll = async (approved) => {
      await app.evaluate(({ dialog }, approve) => {
        globalThis.__sshtoConflictPrompts = [];
        dialog.showMessageBox = async (_window, options) => {
          globalThis.__sshtoConflictPrompts.push({
            label: options.checkboxLabel,
            checked: options.checkboxChecked,
          });
          return { response: approve ? 1 : 0, checkboxChecked: true };
        };
      }, approved);
      await remoteBrowser
        .getByRole("button", { name: conflictNames[0], exact: true })
        .click();
      await remoteBrowser
        .getByRole("button", { name: conflictNames[1], exact: true })
        .click({ modifiers: ["Control"] });
      await page.getByRole("button", { name: "下载", exact: true }).click();
      await page.waitForFunction(
        (count) =>
          Array.from(document.querySelectorAll(".task")).filter((el) =>
            el.textContent.includes("overwrite-a.txt"),
          ).length === count,
        ++conflictRuns,
      );

      await page
        .locator(".task")
        .filter({ hasText: conflictNames[0] })
        .first()
        .locator(".task-status")
        .filter({ hasText: "已完成" })
        .waitFor();
      const prompts = await app.evaluate(
        () => globalThis.__sshtoConflictPrompts,
      );
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0].label, "对本次传输的所有同名文件执行此操作");
      assert.equal(prompts[0].checked, false);
      await page.getByRole("button", { name: "传输队列", exact: true }).click();
    };
    await chooseAll(true);
    for (const name of conflictNames)
      assert.equal(
        await fs.readFile(path.join(local, name), "utf8"),
        "remote " + name,
      );
    for (const name of conflictNames)
      await fs.writeFile(path.join(remote, name), "new version");
    await chooseAll(false);
    for (const name of conflictNames)
      assert.equal(
        await fs.readFile(path.join(local, name), "utf8"),
        "remote " + name,
      );
    console.log(
      "✓ Conflict dialog checkbox applies overwrite-all or skip-all once per task and resets for the next task",
    );

    // Inspect real native Menu objects without blocking automation on an OS popup.
    await app.evaluate(({ Menu }) => {
      Menu.prototype.popup = function () {
        globalThis.__sshtoContextMenu = this;
      };
    });
    const clipboardText = () =>
      app.evaluate(({ clipboard }) => clipboard.readText());
    const setClipboard = (text) =>
      app.evaluate(async ({ clipboard }, value) => {
        await clipboard.writeText(value);
      }, text);
    const menuItems = () =>
      app.evaluate(() =>
        globalThis.__sshtoContextMenu?.items.map((item) => ({
          label: item.label,
          enabled: item.enabled,
        })),
      );
    const resetMenu = () =>
      app.evaluate(() => {
        globalThis.__sshtoContextMenu = null;
      });
    const menuClick = (label) =>
      app.evaluate((_electron, name) => {
        const item = globalThis.__sshtoContextMenu.items.find(
          (item) => item.label === name,
        );
        if (!item?.enabled) throw Error("Menu item disabled");
        item.click();
      }, label);
    const terminal = page.locator(".terminal-pane:visible > .terminal");
    const terminalArea = terminal.locator(".xterm-helper-textarea");
    await terminalArea.focus();
    await setClipboard("clipboard-keep");
    let inputStart = terminalInput.length;
    await page.keyboard.press("Control+Shift+C");
    await page.waitForTimeout(100);
    assert.equal(await clipboardText(), "clipboard-keep");
    assert.equal(terminalInput.length, inputStart);
    await setClipboard("SHORTCUT_PASTE_中文");
    await page.keyboard.press("Control+Shift+V");
    await expect
      .poll(() => Buffer.concat(terminalInput.slice(inputStart)).toString())
      .toBe("SHORTCUT_PASTE_中文");
    await page.waitForTimeout(100);
    assert.equal(
      Buffer.concat(terminalInput.slice(inputStart)).toString(),
      "SHORTCUT_PASTE_中文",
    );
    inputStart = terminalInput.length;
    await page.keyboard.press("Control+C");
    await expect
      .poll(() => Buffer.concat(terminalInput.slice(inputStart)).toString())
      .toBe("\x03");
    const screen = await terminal.locator(".xterm-screen").boundingBox();
    await page.mouse.move(screen.x + 1, screen.y + 8);
    await page.mouse.down();
    await page.mouse.move(screen.x + screen.width - 2, screen.y + 8, {
      steps: 8,
    });
    await page.mouse.up();
    await page.keyboard.press("Control+Shift+C");
    await expect
      .poll(async () => String(await clipboardText()).trim())
      .toBe("fixture ready");
    inputStart = terminalInput.length;
    await resetMenu();
    await terminal.click({ button: "right", position: { x: 30, y: 20 } });
    await expect.poll(menuItems).toEqual([
      { label: "复制", enabled: true },
      { label: "粘贴", enabled: true },
    ]);
    await setClipboard("before-menu-copy");
    await menuClick("复制");
    await expect
      .poll(async () => String(await clipboardText()).trim())
      .toBe("fixture ready");
    await setClipboard("CONTEXT_PASTE_中文");
    await menuClick("粘贴");
    await expect
      .poll(() => Buffer.concat(terminalInput.slice(inputStart)).toString())
      .toBe("CONTEXT_PASTE_中文");
    await page.waitForTimeout(100);
    assert.equal(
      Buffer.concat(terminalInput.slice(inputStart)).toString(),
      "CONTEXT_PASTE_中文",
    );
    // Standard text controls retain native editing and gain Ctrl+Shift shortcuts.
    await page.getByTitle("编辑 开发服务器", { exact: true }).click();
    const hostInput = page.getByLabel("主机 / IP 地址");
    await hostInput.fill("copy-from-input");
    await hostInput.selectText();
    await page.keyboard.press("Control+Shift+C");
    await expect.poll(clipboardText).toBe("copy-from-input");
    await setClipboard("paste-shortcut.example");
    await hostInput.fill("");
    await page.keyboard.press("Control+Shift+V");
    await expect
      .poll(() => hostInput.inputValue())
      .toBe("paste-shortcut.example");
    await hostInput.selectText();
    await resetMenu();
    await hostInput.click({ button: "right", position: { x: 30, y: 15 } });
    await expect.poll(menuItems).toEqual([
      { label: "复制", enabled: true },
      { label: "粘贴", enabled: true },
    ]);
    await setClipboard("before-input-copy");
    await menuClick("复制");
    await expect.poll(clipboardText).toBe("paste-shortcut.example");
    await hostInput.selectText();
    await setClipboard("paste-context.example");
    await menuClick("粘贴");
    await expect
      .poll(() => hostInput.inputValue())
      .toBe("paste-context.example");
    const passwordInput = page.getByLabel("登录密码", { exact: true });
    await passwordInput.fill("password-test");
    await passwordInput.selectText();
    await resetMenu();
    await passwordInput.click({ button: "right", position: { x: 30, y: 15 } });
    await expect.poll(menuItems).toEqual([
      { label: "复制", enabled: false },
      { label: "粘贴", enabled: true },
    ]);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    // Selected highlighted text can be copied, but the read-only preview cannot receive paste.
    await note.dblclick();
    await previewDialog.getByLabel("文件内容").waitFor();
    const selectPreview = () =>
      previewDialog.getByLabel("文件内容").evaluate((el) => {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      });
    await selectPreview();
    await page.keyboard.press("Control+Shift+C");
    await expect.poll(clipboardText).toBe(previewText);
    await selectPreview();
    await resetMenu();
    await previewDialog
      .getByLabel("文件内容")
      .click({ button: "right", position: { x: 30, y: 15 } });
    await expect.poll(menuItems).toEqual([
      { label: "复制", enabled: true },
      { label: "粘贴", enabled: false },
    ]);
    await setClipboard("before-preview-copy");
    await menuClick("复制");
    await expect.poll(clipboardText).toBe(previewText);
    await page.keyboard.press("Control+Shift+V");
    assert.equal(
      await previewDialog.getByLabel("文件内容").textContent(),
      previewText,
    );
    await previewDialog.getByTitle("关闭预览", { exact: true }).click();
    console.log(
      "✓ Clipboard shortcuts and context menus: terminal copy/paste, no duplicate input, Ctrl+C preserved, editable fields and read-only previews",
    );
    await page.locator(".terminal-pane:visible .xterm-helper-textarea").focus();
    await page.keyboard.type("echo hello");
    await page.waitForTimeout(300);
    assert.deepEqual(errors, []);
    await fs.mkdir("test-results", { recursive: true });
    await page.screenshot({ path: "test-results/workspace.png" });
    console.log(
      "✓ Electron launch, device form, four sessions, pane resize, drag upload and terminal input",
    );
    console.log("✓ No renderer errors; screenshot: test-results/workspace.png");
    await app.close();
    app = null;
    // Restart the application against the same profile to verify saved configuration.
    app = await electron.launch({
      executablePath: process.env.SSHTO_EXECUTABLE,
      args: [
        ...(process.env.SSHTO_EXECUTABLE ? [] : ["."]),
        "--no-sandbox",
        "--user-data-dir=" + path.join(root, "profile"),
      ],
      cwd: path.resolve(__dirname, ".."),
    });
    const restarted = await app.firstWindow();
    await restarted.getByText("开发服务器", { exact: true }).waitFor();
    console.log("✓ Device configuration survives application restart");
  } catch (e) {
    if (app) {
      const p = await app.firstWindow();
      await fs.mkdir("test-results", { recursive: true });
      await p.screenshot({ path: "test-results/failure.png" });
      console.log((await p.locator("body").innerText()).slice(-3000));
    }
    throw e;
  } finally {
    if (app) await app.close();
    if (server) await server.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
