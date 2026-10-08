import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3157", headless: true, serviceWorkers: "allow" },
  webServer: { command: "npx next start -p 3157", url: "http://127.0.0.1:3157", reuseExistingServer: false, timeout: 60000 },
});
