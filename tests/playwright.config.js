const { defineConfig } = require("@playwright/test");
const fs = require("fs");

// Prefer a pre-installed Chromium when one exists (e.g. CI images that ship
// /opt/pw-browsers); otherwise fall back to Playwright's own browser download.
const PREINSTALLED = process.env.LANTERN_CHROMIUM || "/opt/pw-browsers/chromium";

// The app is served from a local HTTP server (127.0.0.1:4173). The kokoro-js
// CDN module and Google Fonts are served by a local mock HTTPS server on :443;
// --host-resolver-rules points those hostnames at 127.0.0.1 so the mock is hit
// even for fetches issued by the service worker (which Playwright's route
// interception cannot see). Both servers have an "offline" kill switch used by
// the offline/service-worker tests.
module.exports = defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  globalSetup: require.resolve("./helpers/global-setup"),
  globalTeardown: require.resolve("./helpers/global-teardown"),
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 390, height: 844 },
    ignoreHTTPSErrors: true,
    chromiumSandbox: false,
    launchOptions: {
      ...(fs.existsSync(PREINSTALLED) ? { executablePath: PREINSTALLED } : {}),
      args: [
        "--host-resolver-rules=MAP cdn.jsdelivr.net 127.0.0.1,MAP fonts.googleapis.com 127.0.0.1,MAP fonts.gstatic.com 127.0.0.1,MAP huggingface.co 127.0.0.1,MAP *.huggingface.co 127.0.0.1,MAP *.hf.co 127.0.0.1",
        "--ignore-certificate-errors",
        "--autoplay-policy=no-user-gesture-required",
        "--no-proxy-server",
      ],
    },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
