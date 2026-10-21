const { _electron: electron } = require("@playwright/test");
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
    server = await fixture(remote);
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
      .locator(".file-empty")
      .filter({ hasText: "此目录为空" })
      .waitFor();
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
