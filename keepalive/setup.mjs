#!/usr/bin/env node
/**
 * Colab Keepalive — One-command Google login setup
 *
 * Usage:
 *   node keepalive/setup.mjs [--url <keepalive-url>] [--key <api-key>]
 *
 * If --url is omitted, reads app name from keepalive/fly.toml → https://<app>.fly.dev
 * If --key is omitted, reads from KEEPALIVE_API_KEY env var
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

// ── Find a Chromium-based browser ──────────────────────────────────

function findBrowser() {
  const candidates =
    process.platform === "win32"
      ? [
          process.env.CHROME,
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
        ]
      : process.platform === "darwin"
        ? [
            process.env.CHROME,
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "/Applications/Arc.app/Contents/MacOS/Arc",
          ]
        : [
            process.env.CHROME,
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
            "microsoft-edge",
          ];

  for (const c of candidates) {
    if (!c) continue;
    if (existsSync(c)) return c;
    // For Linux, try which
    if (process.platform === "linux") {
      try {
        const p = execSync(`which ${c} 2>/dev/null`, { encoding: "utf-8" }).trim();
        if (p) return p;
      } catch { /* not found */ }
    }
  }

  console.error("Error: No Chromium-based browser found.");
  console.error("  Set the CHROME env var to your browser path.");
  process.exit(1);
}

// ── HTTP helpers ───────────────────────────────────────────────────

function httpsPost(url, apiKey, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname,
      method: "POST",
      headers: { "X-Api-Key": apiKey },
    };

    if (body) {
      opts.headers["Content-Type"] = "application/octet-stream";
      opts.headers["Content-Length"] = body.length;
    }

    const req = request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const data = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, data });
      });
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log("\n🐌 Colab Keepalive — Setup\n");

  const opts = parseArgs();
  const baseUrl = resolveUrl(opts);
  const apiKey = resolveKey(opts);
  const browser = findBrowser();
  const profileDir = mkdtempSync(join(tmpdir(), "colab-profile-"));

  console.log(`  Browser: ${browser}`);
  console.log(`  Profile: ${profileDir}\n`);
  console.log("  Opening browser for Google login...");
  console.log("  → Log in to your Google account, then CLOSE the browser.\n");

  // Launch browser and wait for it to close
  const child = spawn(browser, [
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "https://accounts.google.com",
  ], { stdio: "ignore" });

  await new Promise((resolve) => child.on("close", resolve));

  console.log("  Browser closed. Uploading profile...\n");

  // Tar the profile — use Node's built-in approach to avoid Windows tar issues
  const tarFile = join(tmpdir(), "colab-profile.tar.gz");
  // Default/ contains cookies, login data, preferences
  const defaultDir = join(profileDir, "Default");
  if (!existsSync(defaultDir)) {
    console.error("  Error: No Default profile directory found. Did you log in?");
    process.exit(1);
  }

  // Use tar with explicit paths that work cross-platform
  const tarArgs = ["czf", tarFile, "-C", profileDir, "Default"];
  const tarResult = spawn("tar", tarArgs, { stdio: "pipe" });
  await new Promise((resolve) => tarResult.on("close", resolve));

  // Read and upload
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

  // Cleanup
  try {
    execSync(`rm -rf "${profileDir}" "${tarFile}"`, { stdio: "ignore" });
  } catch {
    // Best effort on Windows
    try { execSync(`rmdir /s /q "${profileDir}"`, { shell: true, stdio: "ignore" }); } catch {}
  }
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
