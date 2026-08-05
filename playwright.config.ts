import { existsSync } from "node:fs";

import { defineConfig, devices } from "@playwright/test";

const PORT = 5173;
const baseURL = `http://localhost:${PORT}`;

// 環境に PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers でプリインストールされたChromiumがある場合は
// それを使う(`playwright install` は実行しない)。プロジェクトの @playwright/test が要求する
// ブラウザリビジョンとプリインストール版のリビジョンが一致せず標準の解決に失敗することがあるため、
// 実行ファイルを明示指定する。存在しない環境(CI等、通常インストールを行う場合)では
// Playwright標準の解決に任せる。
const preinstalledChromium = "/opt/pw-browsers/chromium";
const executablePath = existsSync(preinstalledChromium) ? preinstalledChromium : undefined;

export default defineConfig({
  testDir: "./e2e",
  // WASM(opencascade.js, 約11MB)の初期化に初回は数秒〜数十秒かかりうるため、
  // 通常のE2Eより長めに確保する。
  timeout: 150_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev -- --port 5173 --strictPort",
    url: baseURL,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
});
