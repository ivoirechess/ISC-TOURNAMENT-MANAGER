import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 20_000,
  use: {
    baseURL: "http://127.0.0.1:4173/ISC-TOURNAMENT-MANAGER/",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "python3 -m http.server 4173 --bind 127.0.0.1",
    cwd: "..",
    url: "http://127.0.0.1:4173/ISC-TOURNAMENT-MANAGER/",
    reuseExistingServer: true,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit-ipad", use: { ...devices["iPad Pro 11"] } },
    { name: "chromium-mobile", use: { ...devices["Pixel 5"] } },
  ],
});
