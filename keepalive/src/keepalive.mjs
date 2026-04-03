import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const CHROME_PROFILE_DIR = process.env.CHROME_PROFILE_DIR || "/data/chrome-profile";
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";
const KEEPALIVE_INTERVAL_MS = 60_000;
const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

let chromeProcess = null;
let xvfbProcess = null;
let keepaliveTimer = null;
let callbackUrl = null;
let state = "idle"; // idle | starting | running | error

export function getState() {
  return {
    state,
    hasBrowser: !!chromeProcess,
    hasPage: !!chromeProcess,
    keepaliveActive: !!keepaliveTimer,
  };
}

// ── CDP helpers ────────────────────────────────────────────────────

async function cdpGet(path) {
  const res = await fetch(`http://127.0.0.1:9222${path}`);
  return res.json();
}

async function cdpConnect(targetId) {
  const wsUrl = `ws://127.0.0.1:9222/devtools/page/${targetId}`;
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let msgId = 0;
  const pending = new Map();

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)(data);
      pending.delete(data.id);
    }
  };

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  return { ws, send };
}

// ── Browser management ─────────────────────────────────────────────

function ensureXvfb() {
  if (!xvfbProcess) {
    xvfbProcess = spawn("Xvfb", [":99", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], {
      stdio: "ignore",
    });
  }
}

export async function launchBrowser(url) {
  ensureXvfb();
  await sleep(500);

  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-dbus",
    "--remote-debugging-port=9222",
    "--remote-debugging-address=127.0.0.1",
    "--window-size=1280,800",
    `--user-data-dir=${CHROME_PROFILE_DIR}`,
  ];

  if (url) args.push(url);

  chromeProcess = spawn(CHROME_PATH, args, {
    stdio: "ignore",
    env: { ...process.env, DISPLAY: ":99" },
  });

  chromeProcess.on("close", () => { chromeProcess = null; });

  // Wait for DevTools to be ready
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      await cdpGet("/json/version");
      console.log("[keepalive] Chrome DevTools ready");
      return;
    } catch { /* not ready yet */ }
  }
  throw new Error("Chrome failed to start within 30s");
}

export async function startColabSession(notebookUrl, cbUrl) {
  state = "starting";
  callbackUrl = cbUrl;

  try {
    await launchBrowser(notebookUrl);
    console.log("[keepalive] Notebook loading, waiting for runtime connection...");

    // Get the page target
    await sleep(5000); // Wait for page to start loading
    const targets = await cdpGet("/json");
    const pageTarget = targets.find((t) => t.type === "page");
    if (!pageTarget) throw new Error("No page target found");

    const { ws, send } = await cdpConnect(pageTarget.id);

    // Enable required domains
    await send("Runtime.enable");
    await send("Page.enable");

    // Wait for runtime to connect (max 120s)
    const connected = await waitForRuntimeConnection(send, 120_000);
    if (!connected) {
      ws.close();
      throw new Error("Timed out waiting for Colab runtime connection");
    }
    console.log("[keepalive] Runtime connected");

    // Run all cells (Ctrl+F9)
    await runAllCells(send);
    console.log("[keepalive] Run All triggered, waiting for tunnel URL...");

    // Wait for tunnel URL in cell output (max 180s)
    const tunnelUrl = await waitForTunnelUrl(send, 180_000);
    if (!tunnelUrl) {
      ws.close();
      throw new Error("Timed out waiting for tunnel URL in cell output");
    }
    console.log(`[keepalive] Tunnel URL found: ${tunnelUrl}`);

    // Callback with tunnel URL
    if (callbackUrl) {
      await postCallback({ tunnel_url: tunnelUrl });
      console.log("[keepalive] Callback sent with tunnel URL");
    }

    // Start keepalive loop
    startKeepaliveLoop(send);
    state = "running";
    console.log("[keepalive] Keepalive mode active");

    return { ok: true, tunnel_url: tunnelUrl };
  } catch (err) {
    state = "error";
    console.error(`[keepalive] Error: ${err.message}`);
    throw err;
  }
}

async function waitForRuntimeConnection(send, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const result = await send("Runtime.evaluate", {
        expression: `(() => {
          const btn = document.querySelector("colab-connect-button");
          if (!btn) return null;
          const inner = btn.shadowRoot?.querySelector("#connect") ||
                        btn.shadowRoot?.querySelector("[id*='connect']") || btn;
          return inner?.textContent?.trim() || btn.textContent?.trim();
        })()`,
        returnByValue: true,
      });

      const status = result?.result?.result?.value;
      console.log(`[keepalive] Runtime check: ${JSON.stringify(status)}`);

      if (status && /connected/i.test(status) && !/reconnect/i.test(status)) {
        return true;
      }

      // If connect button text is empty/missing, notebook UI may be loaded with runtime already connected
      if (!status || status === "") {
        const check = await send("Runtime.evaluate", {
          expression: `(() => {
            // Colab notebook loaded = has cells visible
            const cells = document.querySelectorAll('.cell, [class*="cell-"]');
            if (cells.length > 0) return "cells_found:" + cells.length;
            return null;
          })()`,
          returnByValue: true,
        });
        const v = check?.result?.result?.value;
        if (v && v.startsWith("cells_found")) {
          console.log(`[keepalive] Notebook loaded (${v}), assuming runtime connected`);
          return true;
        }
      }

      // "Connect\n           T4" or similar — click to start runtime
      if (status && /connect/i.test(status) && !/connected/i.test(status)) {
        await send("Runtime.evaluate", {
          expression: `(() => {
            const btn = document.querySelector("colab-connect-button");
            if (btn) {
              const inner = btn.shadowRoot?.querySelector("#connect") || btn;
              inner.click();
            }
          })()`,
        });
      }
    } catch {
      // Page may not be ready
    }

    await sleep(2000);
  }

  return false;
}

async function runAllCells(send) {
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: 2, // Ctrl
    windowsVirtualKeyCode: 120, // F9
    key: "F9",
    code: "F9",
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 2,
    windowsVirtualKeyCode: 120,
    key: "F9",
    code: "F9",
  });
  await sleep(2000);
}

async function waitForTunnelUrl(send, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const result = await send("Runtime.evaluate", {
        expression: `(() => {
          const outputs = document.querySelectorAll(
            ".output_text, .output_stream, .cell-output-text, [class*='output']"
          );
          for (const el of outputs) {
            const match = el.textContent.match(/https:\\/\\/[a-z0-9-]+\\.trycloudflare\\.com/);
            if (match) return match[0];
          }
          return null;
        })()`,
        returnByValue: true,
      });

      const tunnelMatch = result?.result?.result?.value;
      if (tunnelMatch) return tunnelMatch;
    } catch {
      // Page might be navigating
    }

    await sleep(2000);
  }

  return null;
}

function startKeepaliveLoop(send) {
  if (keepaliveTimer) clearInterval(keepaliveTimer);

  keepaliveTimer = setInterval(async () => {
    try {
      await tick(send);
    } catch (err) {
      console.error(`[keepalive] Tick error: ${err.message}`);
    }
  }, KEEPALIVE_INTERVAL_MS);
}

async function tick(send) {
  if (!chromeProcess) {
    console.log("[keepalive] Chrome process gone, stopping");
    await handleDisconnect();
    return;
  }

  try {
    const result = await send("Runtime.evaluate", {
      expression: `(() => {
        const btn = document.querySelector("colab-connect-button");
        if (btn) {
          const inner = btn.shadowRoot?.querySelector("#connect") || btn;
          const text = inner?.textContent?.trim() || "";
          if (/^connect$/i.test(text) || /reconnect/i.test(text)) return true;
          inner.click();
        }
        document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 100, clientY: 100 }));
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
        document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
        return false;
      })()`,
      returnByValue: true,
    });

    if (result?.result?.result?.value === true) { // CDP: {id, result: {result: {value}}}
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
    } catch { /* Best effort */ }
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
  if (chromeProcess) {
    chromeProcess.kill();
    chromeProcess = null;
  }
  if (xvfbProcess) {
    xvfbProcess.kill();
    xvfbProcess = null;
  }
  state = "idle";
}

export async function takeScreenshot() {
  if (!chromeProcess) throw new Error("No active browser");

  const targets = await cdpGet("/json");
  const pageTarget = targets.find((t) => t.type === "page");
  if (!pageTarget) throw new Error("No page target");

  const { ws, send } = await cdpConnect(pageTarget.id);
  const result = await send("Page.captureScreenshot", { format: "png" });
  ws.close();

  return Buffer.from(result?.result?.data, "base64");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
