import puppeteer from "puppeteer-core";
import { execSync, spawn as cpSpawn } from "node:child_process";

const CHROME_PROFILE_DIR = process.env.CHROME_PROFILE_DIR || "/data/chrome-profile";
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";
const KEEPALIVE_INTERVAL_MS = 60_000;
const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
let xvfbProcess = null;

let browser = null;
let page = null;
let keepaliveTimer = null;
let callbackUrl = null;
let state = "idle"; // idle | starting | running | error

export function getState() {
  return {
    state,
    hasBrowser: !!browser,
    hasPage: !!page,
    keepaliveActive: !!keepaliveTimer,
  };
}

export async function launchBrowser(url, opts = {}) {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-dbus",
    `--user-data-dir=${CHROME_PROFILE_DIR}`,
  ];

  let headless = true;

  if (opts.setup) {
    // Start Xvfb for non-headless Chrome (bypasses Google's headless detection)
    if (!xvfbProcess) {
      xvfbProcess = cpSpawn("Xvfb", [":99", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], {
        stdio: "ignore",
      });
      process.env.DISPLAY = ":99";
      // Wait for Xvfb to be ready
      await new Promise((r) => setTimeout(r, 1000));
    }
    headless = false;
  }

  if (!headless) {
    // Non-headless needs explicit debugging port for Puppeteer to connect
    args.push("--remote-debugging-port=9222");
  }

  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless,
    args,
    protocolTimeout: 120_000,
    pipe: headless,
    timeout: 60_000,
  });

  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  if (url && !opts.setup) {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });
  } else if (url) {
    // In setup mode, navigate without waiting for networkidle
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  return page;
}

export async function startColabSession(notebookUrl, cbUrl) {
  state = "starting";
  callbackUrl = cbUrl;

  try {
    await launchBrowser(notebookUrl);
    console.log("[keepalive] Notebook loaded, waiting for runtime connection...");

    // Wait for runtime to connect (max 120s)
    const connected = await waitForRuntimeConnection(120_000);
    if (!connected) {
      throw new Error("Timed out waiting for Colab runtime connection");
    }
    console.log("[keepalive] Runtime connected");

    // Run all cells (Ctrl+F9)
    await runAllCells();
    console.log("[keepalive] Run All triggered, waiting for tunnel URL...");

    // Wait for tunnel URL in cell output (max 180s)
    const tunnelUrl = await waitForTunnelUrl(180_000);
    if (!tunnelUrl) {
      throw new Error("Timed out waiting for tunnel URL in cell output");
    }
    console.log(`[keepalive] Tunnel URL found: ${tunnelUrl}`);

    // Callback with tunnel URL
    if (callbackUrl) {
      await postCallback({ tunnel_url: tunnelUrl });
      console.log("[keepalive] Callback sent with tunnel URL");
    }

    // Start keepalive loop
    startKeepaliveLoop();
    state = "running";
    console.log("[keepalive] Keepalive mode active");

    return { ok: true, tunnel_url: tunnelUrl };
  } catch (err) {
    state = "error";
    console.error(`[keepalive] Error: ${err.message}`);
    throw err;
  }
}

async function waitForRuntimeConnection(timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const status = await page.evaluate(() => {
        const btn = document.querySelector("colab-connect-button");
        if (!btn) return null;
        // Check shadowRoot for the actual button text
        const inner = btn.shadowRoot?.querySelector("#connect") ||
                      btn.shadowRoot?.querySelector("[id*='connect']") ||
                      btn;
        return inner?.textContent?.trim() || btn.textContent?.trim();
      });

      if (status && /connected/i.test(status) && !/reconnect/i.test(status)) {
        return true;
      }

      // Try clicking connect if available
      if (status && /^connect$/i.test(status)) {
        await page.evaluate(() => {
          const btn = document.querySelector("colab-connect-button");
          if (btn) {
            const inner = btn.shadowRoot?.querySelector("#connect") || btn;
            inner.click();
          }
        });
      }
    } catch {
      // DOM not ready yet
    }

    await sleep(3000);
  }

  return false;
}

async function runAllCells() {
  // Try Ctrl+F9 (Run All shortcut)
  await page.keyboard.down("Control");
  await page.keyboard.press("F9");
  await page.keyboard.up("Control");

  // Wait a moment for the action to register
  await sleep(2000);
}

async function waitForTunnelUrl(timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const url = await page.evaluate((regex) => {
        // Search all cell outputs for tunnel URL
        const outputs = document.querySelectorAll(
          ".output_text, .output_stream, .cell-output-text, [class*='output']"
        );
        for (const el of outputs) {
          const text = el.textContent || "";
          const match = text.match(new RegExp(regex));
          if (match) return match[0];
        }
        return null;
      }, TUNNEL_URL_REGEX.source);

      if (url) return url;
    } catch {
      // Page might be navigating
    }

    await sleep(5000);
  }

  return null;
}

function startKeepaliveLoop() {
  if (keepaliveTimer) clearInterval(keepaliveTimer);

  keepaliveTimer = setInterval(async () => {
    try {
      await tick();
    } catch (err) {
      console.error(`[keepalive] Tick error: ${err.message}`);
    }
  }, KEEPALIVE_INTERVAL_MS);
}

async function tick() {
  if (!page || page.isClosed()) {
    console.log("[keepalive] Page closed, stopping");
    await handleDisconnect();
    return;
  }

  try {
    const disconnected = await page.evaluate(() => {
      // Click colab-connect-button to maintain connection
      const btn = document.querySelector("colab-connect-button");
      if (btn) {
        const inner = btn.shadowRoot?.querySelector("#connect") || btn;
        const text = inner?.textContent?.trim() || "";

        // If it says "Connect" (not "Connected"), runtime is disconnected
        if (/^connect$/i.test(text) || /reconnect/i.test(text)) {
          return true;
        }

        inner.click();
      }

      // Simulate UI interaction to prevent idle timeout
      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: 100, clientY: 100 })
      );
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Shift", bubbles: true })
      );
      document.body.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Shift", bubbles: true })
      );

      return false;
    });

    if (disconnected) {
      console.log("[keepalive] Runtime disconnected detected");
      await handleDisconnect();
    }
  } catch (err) {
    console.error(`[keepalive] Tick evaluate error: ${err.message}`);
  }
}

async function handleDisconnect() {
  if (callbackUrl) {
    try {
      await postCallback({ disconnected: true });
    } catch {
      // Best effort
    }
  }
  await closeBrowser();
  state = "idle";
}

async function postCallback(body) {
  const res = await fetch(callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`[keepalive] Callback failed: ${res.status} ${await res.text()}`);
  }
}

export async function closeBrowser() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  if (browser) {
    try {
      await browser.close();
    } catch {
      // Already closed
    }
    browser = null;
    page = null;
  }
  if (xvfbProcess) {
    xvfbProcess.kill();
    xvfbProcess = null;
  }
  state = "idle";
}

export async function takeScreenshot() {
  if (!page || page.isClosed()) {
    throw new Error("No active page");
  }
  return await page.screenshot({ type: "png" });
}

export async function navigateTo(url) {
  if (!page || page.isClosed()) throw new Error("No active page");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
}

export async function typeText(text) {
  if (!page || page.isClosed()) throw new Error("No active page");
  await page.keyboard.type(text, { delay: 50 });
}

export async function pressKey(key) {
  if (!page || page.isClosed()) throw new Error("No active page");
  await page.keyboard.press(key);
}

export async function clickAt(x, y) {
  if (!page || page.isClosed()) throw new Error("No active page");
  await page.mouse.click(x, y);
}

export async function clickSelector(selector) {
  if (!page || page.isClosed()) throw new Error("No active page");
  await page.click(selector);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
