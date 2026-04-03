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

import puppeteer from "puppeteer-core";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { request } from "node:https";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Parse args ─────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) opts.url = args[++i];
    else if (args[i] === "--key" && args[i + 1]) opts.key = args[++i];
    else if (args[i] === "--notebook" && args[i + 1]) opts.notebook = args[++i];
    else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
Colab Keepalive — Google login setup

Usage:
  node keepalive/setup.mjs --notebook <notebook-url> [--url <keepalive-url>] [--key <api-key>]

Options:
  --notebook  A Colab notebook URL on Drive (used to establish Drive auth)
  --url       Keepalive container URL (default: from fly.toml)
  --key       API key (default: from KEEPALIVE_API_KEY env var)
  --help      Show this help
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
  // Only use Chrome or Chromium — NOT Edge/Brave, which encrypt cookies with OS DPAPI
  const candidates =
    process.platform === "win32"
      ? [
          process.env.CHROME,
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : process.platform === "darwin"
        ? [
            process.env.CHROME,
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
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

  // No browser found — try to install Chrome for Testing
  console.log("  No browser found. Installing Chrome for Testing...");
  try {
    const output = execSync("npx -y @puppeteer/browsers install chrome@stable", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const match = output.match(/chrome@[^\s]+ (.+)/);
    if (match && existsSync(match[1])) return match[1];
  } catch { /* failed */ }

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

function httpsPostJson(url, apiKey, jsonBody) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = Buffer.from(jsonBody);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname,
      method: "POST",
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json",
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
  console.log("  → The browser will close automatically once login is detected.\n");

  // Launch via Puppeteer with automation detection disabled.
  // Puppeteer-managed profiles have unencrypted cookies (no OS DPAPI).
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: false,
    userDataDir: profileDir,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
    ],
    defaultViewport: null,
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  await page.goto("https://accounts.google.com", { waitUntil: "domcontentloaded" });

  // Poll for login completion
  console.log("  Waiting for Google login...");
  let loggedIn = false;
  while (!loggedIn) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const url = page.url();
      if (url.includes("myaccount.google.com") || url.includes("accounts.google.com/SignOutOptions")) {
        loggedIn = true;
        break;
      }
      const cookies = await page.cookies("https://accounts.google.com");
      const hasSID = cookies.some((c) => c.name === "SID" || c.name === "SSID");
      if (hasSID) loggedIn = true;
    } catch {
      if (!browser.connected) {
        console.error("  Error: Browser was closed before login completed.");
        process.exit(1);
      }
    }
  }

  console.log("  Login detected! Warming up sessions...");

  // 1. Visit Colab top to establish Colab cookies
  console.log("  → Opening Colab...");
  await page.goto("https://colab.research.google.com", { waitUntil: "networkidle2", timeout: 30_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));

  // 2. Open a Drive notebook to trigger Drive authentication
  if (opts.notebook) {
    console.log("  → Opening Drive notebook to establish Drive auth...");
    console.log("  → Complete any consent/auth prompts in the browser.");
    console.log("  → Waiting for notebook to load...\n");
    await page.goto(opts.notebook, { waitUntil: "networkidle2", timeout: 60_000 }).catch(() => {});
    // Wait for notebook to be fully loaded
    console.log("  (Waiting up to 3 minutes for notebook page...)");
    let driveReady = false;
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        if (!browser.connected) break;
        const url = page.url();
        // Check if URL is on Colab (not redirected to login)
        if (url.includes("colab.research.google.com") && !url.includes("accounts.google.com")) {
          const loaded = await page.evaluate(() => {
            // Check for any Colab UI element
            return !!(document.querySelector("#top-toolbar") ||
                     document.querySelector("colab-toolbar") ||
                     document.querySelector("[role='navigation']") ||
                     document.title.includes(".ipynb") ||
                     document.title.includes("Colab"));
          }).catch(() => false);
          if (loaded) {
            driveReady = true;
            break;
          }
        }
      } catch {
        if (!browser.connected) break;
      }
    }
    if (driveReady) {
      console.log("  Drive notebook loaded!");
    } else {
      console.log("  Warning: Could not confirm notebook loaded. Extracting cookies anyway...");
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  // 3. Extract ALL cookies via CDP
  if (!browser.connected) {
    console.error("  Error: Browser was closed. Please keep the browser open until setup completes.");
    process.exit(1);
  }
  console.log("  → Extracting cookies (don't close the browser yet!)...");
  const client = await page.createCDPSession();
  const { cookies } = await client.send("Network.getAllCookies");
  await browser.close();

  console.log(`  Found ${cookies.length} cookies total.`);

  if (cookies.length === 0) {
    console.error("  Error: No cookies found.");
    process.exit(1);
  }

  // Upload cookies as JSON
  console.log("  Uploading cookies to keepalive container...\n");
  const cookiePayload = JSON.stringify({ cookies });
  const res = await httpsPostJson(`${baseUrl}/import-cookies`, apiKey, cookiePayload);

  if (res.status === 200) {
    console.log("  Upload successful!\n");
    console.log("  ✓ Setup complete. Google + Colab + Drive cookies are on the keepalive container.");
    console.log("  ✓ You can now use colab_start from Claude to launch Colab sessions.\n");
  } else {
    console.error(`  Upload failed: ${res.status} ${res.data}`);
    process.exit(1);
  }

  // Cleanup
  try {
    const { rmSync } = await import("node:fs");
    rmSync(profileDir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
