import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { get } from "node:http";

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
  const path = `/devtools/page/${targetId}`;
  const { createConnection } = await import("node:net");
  const crypto = await import("node:crypto");

  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = createConnection(9222, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:9222\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `\r\n`
      );
    });

    let msgId = 0;
    const pending = new Map();
    let upgraded = false;
    let buffer = Buffer.alloc(0);

    function processFrame(buf) {
      // Minimal WebSocket frame parser (text frames only, no masking from server)
      if (buf.length < 2) return { frame: null, rest: buf };
      const secondByte = buf[1] & 0x7f;
      let payloadLen = secondByte;
      let offset = 2;
      if (secondByte === 126) {
        if (buf.length < 4) return { frame: null, rest: buf };
        payloadLen = buf.readUInt16BE(2);
        offset = 4;
      } else if (secondByte === 127) {
        if (buf.length < 10) return { frame: null, rest: buf };
        payloadLen = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (buf.length < offset + payloadLen) return { frame: null, rest: buf };
      const payload = buf.slice(offset, offset + payloadLen).toString("utf-8");
      return { frame: payload, rest: buf.slice(offset + payloadLen) };
    }

    function sendWs(data) {
      const payload = Buffer.from(JSON.stringify(data));
      const header = [];
      header.push(0x81); // text frame, fin
      const mask = crypto.randomBytes(4);
      if (payload.length < 126) {
        header.push(0x80 | payload.length);
      } else if (payload.length < 65536) {
        header.push(0x80 | 126);
        header.push((payload.length >> 8) & 0xff);
        header.push(payload.length & 0xff);
      } else {
        header.push(0x80 | 127);
        const lenBuf = Buffer.alloc(8);
        lenBuf.writeBigUInt64BE(BigInt(payload.length));
        header.push(...lenBuf);
      }
      header.push(...mask);
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        masked[i] = payload[i] ^ mask[i % 4];
      }
      socket.write(Buffer.concat([Buffer.from(header), masked]));
    }

    function send(method, params = {}) {
      return new Promise((resolve, rej) => {
        const id = ++msgId;
        pending.set(id, resolve);
        sendWs({ id, method, params });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            rej(new Error(`CDP timeout: ${method}`));
          }
        }, 30000);
      });
    }

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!upgraded) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        // Check for 101 Switching Protocols
        const header = buffer.slice(0, headerEnd).toString();
        if (!header.includes("101")) {
          reject(new Error("WebSocket upgrade failed"));
          socket.destroy();
          return;
        }
        upgraded = true;
        buffer = buffer.slice(headerEnd + 4);
        resolve({
          ws: { close: () => socket.destroy() },
          send,
        });
      }

      // Process WebSocket frames
      while (buffer.length > 0) {
        const { frame, rest } = processFrame(buffer);
        if (!frame) break;
        buffer = rest;
        try {
          const data = JSON.parse(frame);
          if (data.id && pending.has(data.id)) {
            pending.get(data.id)(data);
            pending.delete(data.id);
          }
        } catch { /* ignore non-JSON or events */ }
      }
    });

    socket.on("error", reject);
  });
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
    "--disable-popup-blocking",
    "--disable-blink-features=AutomationControlled",
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
    const connected = await waitForRuntimeConnection(send, 300_000);
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

      // Log page state and errors periodically
      if (Date.now() % 20000 < 2100) {
        const urlCheck = await send("Runtime.evaluate", {
          expression: `JSON.stringify({
            url: location.href.slice(0, 100),
            title: document.title,
            errorEls: [...document.querySelectorAll('[class*="error"], [role="alert"]')].map(e => e.textContent?.trim()?.slice(0, 200)),
            dialogEls: [...document.querySelectorAll('dialog, [role="dialog"], md-dialog, mwc-dialog')].map(e => e.textContent?.trim()?.slice(0, 200)),
          })`,
          returnByValue: true,
        }).catch(() => null);
        console.log(`[keepalive] Page state: ${urlCheck?.result?.result?.value || "unknown"}`);
      }

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

      // "Connecting" — runtime is being allocated, just wait
      if (status && /connecting/i.test(status)) {
        // Do nothing, wait for allocation
        await sleep(2000);
        continue;
      }

      // "Connect\n           T4" or "Reconnect\n           T4" — click to start runtime
      if (status && /connect/i.test(status) && !/connecting|connected/i.test(status)) {
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
      // Check for OAuth popup tab and auto-approve
      try {
        const targets = await cdpGet("/json");
        const oauthPage = targets.find((t) =>
          t.type === "page" && t.url &&
          (t.url.includes("accounts.google.com/o/oauth2") ||
           t.url.includes("accounts.google.com/signin/oauth"))
        );
        if (oauthPage) {
          console.log(`[keepalive] Found OAuth popup: ${oauthPage.url}`);
          const { ws: oauthWs, send: oauthSend } = await cdpConnect(oauthPage.id);
          await oauthSend("Runtime.enable");
          // Wait for page to load
          await sleep(3000);
          // Click "Allow" / "許可" button
          const clickResult = await oauthSend("Runtime.evaluate", {
            expression: `(() => {
              const btns = document.querySelectorAll('button, [role="button"]');
              for (const btn of btns) {
                const text = btn.textContent?.trim();
                if (/Allow|許可|Continue|続行|次へ|Next|Sign in/i.test(text)) {
                  btn.click();
                  return 'clicked:' + text;
                }
              }
              // Also try submit buttons
              const submit = document.querySelector('input[type="submit"], button[type="submit"]');
              if (submit) { submit.click(); return 'clicked:submit'; }
              return null;
            })()`,
            returnByValue: true,
          });
          const cv = clickResult?.result?.result?.value;
          if (cv) console.log(`[keepalive] OAuth popup: ${cv}`);
          oauthWs.close();
        }
      } catch (err) {
        // OAuth popup handling is best-effort
      }

      // Dismiss Drive permission dialog if present (md-text-button with dialogaction="ok")
      await send("Runtime.evaluate", {
        expression: `(() => {
          // Colab uses <md-text-button dialogaction="ok"> for Drive permission
          const mdBtns = document.querySelectorAll('md-text-button[dialogaction="ok"]');
          for (const btn of mdBtns) {
            btn.click();
            return 'clicked:md-text-button:' + btn.textContent?.trim();
          }
          // Fallback: any button with Drive/Connect/Allow text
          const allBtns = document.querySelectorAll('button, [role="button"], mwc-button, md-text-button, md-filled-button');
          for (const btn of allBtns) {
            const text = btn.textContent?.trim();
            if (/Connect to Google Drive|接続|許可|Allow/i.test(text)) {
              btn.click();
              return 'clicked:' + text;
            }
          }
          return null;
        })()`,
        returnByValue: true,
      }).then(r => {
        const v = r?.result?.result?.value;
        if (v) console.log(`[keepalive] Dismissed dialog: ${v}`);
      }).catch(() => {});

      const result = await send("Runtime.evaluate", {
        expression: `(() => {
          const bodyText = document.body?.innerText || "";
          const match = bodyText.match(/https:\\/\\/[a-z0-9-]+\\.trycloudflare\\.com/);
          return match ? match[0] : null;
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
  try {
    await send("Page.enable");
    const result = await send("Page.captureScreenshot", { format: "png" });
    return Buffer.from(result.result.data, "base64");
  } finally {
    ws.close();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
