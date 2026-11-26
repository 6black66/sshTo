// Manual connect-speed benchmark against a real saved device.
// Usage: npm run bench:connect -- [deviceName]
// Needs a real display and the system keyring: the stored secret cannot be
// decrypted from an automated shell, so the script removes the device's saved
// secret from a profile COPY and lets you type the password in the credential
// modal (typed passwords stay in memory, never written to disk).
const { _electron: electron } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const deviceName = process.argv[2] || process.env.npm_config_device || "sw";
const cwd = path.resolve(__dirname, "..");
const configSrc = path.join(os.homedir(), ".config/sshto/config.json");

(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "sshto-bench-"));
  const cfg = JSON.parse(await fs.readFile(configSrc, "utf8"));
  const device = cfg.devices.find((d) => d.name === deviceName);
  if (!device) {
    console.error(`device "${deviceName}" not found in ${configSrc}`);
    process.exit(1);
  }
  delete cfg.secrets[device.id]; // force the credential modal; user types the password
  await fs.writeFile(path.join(profile, "config.json"), JSON.stringify(cfg));
  const app = await electron.launch({
    executablePath: process.env.SSHTO_EXECUTABLE,
    args: [
      ...(process.env.SSHTO_EXECUTABLE ? [] : ["."]),
      "--no-sandbox",
      "--user-data-dir=" + profile,
    ],
    cwd,
    timeout: 30000,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("heading", { name: "连接设备，打开可能。" }).waitFor();
    console.log(
      `>>> 请在窗口中点击 ${deviceName} 的连接按钮，在认证框输入密码并提交。`,
    );
    await page
      .locator(".device", { hasText: deviceName })
      .first()
      .getByTitle("连接设备", { exact: true })
      .click();
    await page.locator(".credential-modal").waitFor({ timeout: 15000 });
    await page
      .locator(".credential-modal")
      .waitFor({ state: "detached", timeout: 240000 });
    const t0 = Date.now(); // modal submit; timing starts here
    const connected = await page
      .locator(".session-state.connected")
      .waitFor({ timeout: 120000 })
      .then(() => Date.now() - t0)
      .catch(() => -1);
    if (connected < 0) {
      const msgs = await page
        .locator(".session-message")
        .allInnerTexts()
        .catch(() => []);
      console.error("connect failed:", JSON.stringify(msgs));
      process.exitCode = 1;
      return;
    }
    console.log(`${deviceName} connect=${connected}ms`);
    await page
      .locator(".browser")
      .nth(1)
      .locator(".entry, .file-empty")
      .first()
      .waitFor({ timeout: 30000 });
    console.log(`${deviceName} listing=${Date.now() - t0 - connected}ms`);
    await page.locator(".terminal").first().click();
    const echoes = [];
    for (let i = 0; i < 3; i++) {
      const marker = `bench-${i}-${Math.random().toString(36).slice(2, 8)}`;
      const s = Date.now();
      await page.keyboard.type(`echo ${marker}`);
      await page.keyboard.press("Enter");
      await page
        .locator(".xterm-rows")
        .first()
        .getByText(marker, { exact: true })
        .last()
        .waitFor({ timeout: 20000 });
      echoes.push(Date.now() - s);
    }
    console.log(`${deviceName} echo=${echoes.join("/")}ms`);
  } finally {
    await app.close().catch(() => {});
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
})();
