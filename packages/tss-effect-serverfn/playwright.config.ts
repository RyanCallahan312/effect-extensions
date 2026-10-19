import { defineConfig, devices } from "@playwright/test";

const apps = [
  { name: "basic", port: 4310 },
  { name: "services", port: 4312 },
] as const;

const targets = apps.flatMap((app) => [
  { app: app.name, mode: "dev", port: app.port },
  { app: app.name, mode: "preview", port: app.port + 1 },
]);

export default defineConfig({
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  projects: targets.map(({ app, mode, port }) => ({
    name: `${app}-${mode}`,
    testMatch: `${app}.spec.ts`,
    use: { baseURL: `http://127.0.0.1:${port}` },
  })),
  reporter: [["list"], ["html", { open: "never" }]],
  retries: 0,
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    ...devices["Desktop Chrome"],
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: targets.map(({ app, mode, port }) => ({
    command: `bun run --cwd examples/${app} ${mode} --host 127.0.0.1 --port ${port} --strictPort`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
    reuseExistingServer: false,
    timeout: 60_000,
    url: `http://127.0.0.1:${port}`,
  })),
  workers: 2,
});
