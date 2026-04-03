#!/usr/bin/env node
/**
 * Colab Keepalive — One-command Google login setup
 *
 * Launches a Chrome/Edge window with a temporary profile where cookie
 * encryption is disabled. After the user logs in and closes the browser,
 * the profile is uploaded to the fly.io keepalive container.
 *
 * Usage:
 *   cd keepalive && npm run setup
 *   # or: node keepalive/setup.mjs [--url <keepalive-url>] [--key <api-key>]
 *
 * If --url is omitted, reads app name from keepalive/fly.toml → https://<app>.fly.dev
 * If --key is omitted, reads from KEEPALIVE_API_KEY env var
 */

import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { request } from "node:https";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Parse args ─────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) opts.url = args[++i];
    else if (args[i] === "--key" && args[i + 1]) opts.key = args[++i];
    else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
Colab Keepalive — Google login setup

Usage:
  node keepalive/setup.mjs [--url <keepalive-url>] [--key <api-key>]

Options:
  --url   Keepalive container URL (default: from fly.toml)
  --key   API key (default: from KEEPALIVE_API_KEY env var)
  --help  Show this help
`);
      process.exit(0);
    }
  }
  return opts;
}

// ── Resolve keepalive URL from fly.toml ────────────────────────────

function resolveUrl(opts) {
  if (opts.url) return opts.url;

  const flyToml = join(__dirname, "fly.toml");
  if (existsSync(flyToml)) {
    const content = readFileSync(flyToml, "utf-8");
    const match = content.match(/^app\s*=\s*"(.+)"/m);
    if (match) {
      const url = `https://${match[1]}.fly.dev`;
      console.log(`  Keepalive URL: ${url} (from fly.toml)`);
      return url;
    }
  }

  console.error("Error: Could not determine keepalive URL.");
  console.error("  Pass --url or ensure fly.toml has an app name.");
  process.exit(1);
}

// ── Resolve API key ────────────────────────────────────────────────

function resolveKey(opts) {
  if (opts.key) return opts.key;
  if (process.env.KEEPALIVE_API_KEY) return process.env.KEEPALIVE_API_KEY;

  console.error("Error: No API key provided.");
  console.error("  Pass --key or set KEEPALIVE_API_KEY env var.");
  process.exit(1);
}

// ── Find a Chromium-based browser executable ───────────────────────

function findBrowser() {
  const candidates =
    process.platform === "win32"
      ? [
          process.env.CHROME,
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
        ? [
            process.env.CHROME,
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
          ]
        : [
            process.env.CHROME,
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
          ];

  for (const c of candidates) {
    if (!c) continue;
    if (existsSync(c)) return c;
  }

  console.error("Error: No Chromium-based browser found.");
  console.error("  Set the CHROME env var to your browser path.");
  process.exit(1);
}

// ── HTTP upload ────────────────────────────────────────────────────

function httpsPost(url, apiKey, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname,
      method: "POST",
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/octet-stream",
        "Content-Length": body.length,
      },
    };

    const req = request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString() }));
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log("\n🐌 Colab Keepalive — Setup\n");

  const opts = parseArgs();
  const baseUrl = resolveUrl(opts);
  const apiKey = resolveKey(opts);
  const browserPath = findBrowser();
  const profileDir = mkdtempSync(join(tmpdir(), "colab-profile-"));

  console.log(`  Browser: ${browserPath}`);
  console.log(`  Profile: ${profileDir}\n`);
  console.log("  Opening browser for Google login...");
  console.log("  → Log in to your Google account.");
  console.log("  → Close the browser when done.\n");

  // Launch browser directly (not via Puppeteer) to avoid automation detection.
  // --disable-features=LockProfileCookieDatabase disables OS-level cookie encryption
  // so the profile can be transferred to a Linux container.
  const child = spawn(browserPath, [
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=LockProfileCookieDatabase",
    "https://accounts.google.com",
  ], { stdio: "ignore" });

  // Wait for browser to close
  await new Promise((resolve) => child.on("close", resolve));

  console.log("  Browser closed. Uploading profile...\n");

  // Verify login produced a profile
  const defaultDir = join(profileDir, "Default");
  if (!existsSync(defaultDir)) {
    console.error("  Error: No Default profile directory found. Did you log in?");
    process.exit(1);
  }

  // Tar the profile
  const tarFile = join(profileDir, "profile.tar.gz");
  const { execFileSync } = await import("node:child_process");
  const tarBin = process.platform === "win32"
    ? join(process.env.SYSTEMROOT || "C:\\Windows", "System32", "tar.exe")
    : "tar";
  execFileSync(tarBin, ["czf", tarFile, "-C", profileDir, "Default"], { stdio: "pipe" });

  const tarData = readFileSync(tarFile);
  console.log(`  Profile size: ${(tarData.length / 1024 / 1024).toFixed(1)} MB`);

  const res = await httpsPost(`${baseUrl}/upload-profile`, apiKey, tarData);

  if (res.status === 200) {
    console.log("  Upload successful!\n");
    console.log("  ✓ Setup complete. Google login cookies are now on the keepalive container.");
    console.log("  ✓ You can now use colab_start from Claude to launch Colab sessions.\n");
  } else {
    console.error(`  Upload failed: ${res.status} ${res.data}`);
    process.exit(1);
  }

  // Cleanup temp files
  try {
    const { rmSync } = await import("node:fs");
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(tarFile, { force: true });
  } catch { /* best effort */ }
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
