import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import {
  launchBrowser,
  startColabSession,
  closeBrowser,
  takeScreenshot,
  getState,
} from "./keepalive.mjs";

let setupChromeProcess = null;
let setupXvfbProcess = null;

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY;

function authenticate(req) {
  if (!API_KEY) return true;
  return req.headers["x-api-key"] === API_KEY;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  // Health check — no auth required
  if (path === "/health" && method === "GET") {
    return json(res, 200, { ok: true });
  }

  // All other endpoints require authentication
  if (!authenticate(req)) {
    return json(res, 401, { error: "Unauthorized" });
  }

  try {
    if (path === "/status" && method === "GET") {
      return json(res, 200, getState());
    }

    if (path === "/start" && method === "POST") {
      const body = await readBody(req);
      if (!body.notebook_url) {
        return json(res, 400, { error: "notebook_url is required" });
      }

      // Run async — respond immediately, result comes via callback
      startColabSession(body.notebook_url, body.callback_url).catch((err) => {
        console.error(`[server] startColabSession failed: ${err.message}`);
      });

      return json(res, 202, { status: "starting", message: "Colab session starting" });
    }

    if (path === "/stop" && method === "POST") {
      await closeBrowser();
      return json(res, 200, { ok: true, message: "Stopped" });
    }

    // Launch raw Chromium for login (no Puppeteer = no automation flags)
    // Connect from local Chrome via: fly proxy 9222:9222 → chrome://inspect
    if (path === "/setup-login" && method === "POST") {
      // Stop any existing setup chrome
      if (setupChromeProcess) {
        setupChromeProcess.kill();
        setupChromeProcess = null;
      }

      // Start Xvfb
      if (!setupXvfbProcess) {
        setupXvfbProcess = spawn("Xvfb", [":99", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], {
          stdio: "ignore",
        });
        await new Promise((r) => setTimeout(r, 1000));
      }

      const profileDir = process.env.CHROME_PROFILE_DIR || "/data/chrome-profile";
      const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";

      setupChromeProcess = spawn(chromePath, [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--remote-debugging-port=9222",
        "--remote-debugging-address=0.0.0.0",
        `--user-data-dir=${profileDir}`,
        "https://accounts.google.com",
      ], {
        stdio: "ignore",
        env: { ...process.env, DISPLAY: ":99" },
      });

      // socat to forward 0.0.0.0:9222 → 127.0.0.1:9222
      await new Promise((r) => setTimeout(r, 2000)); // wait for Chrome to start
      const socat = spawn("socat", [
        "TCP-LISTEN:9223,fork,reuseaddr,bind=0.0.0.0",
        "TCP:127.0.0.1:9222",
      ], { stdio: "ignore" });
      socat.unref();

      setupChromeProcess.on("close", () => {
        socat.kill();
        setupChromeProcess = null;
        if (setupXvfbProcess) {
          setupXvfbProcess.kill();
          setupXvfbProcess = null;
        }
      });

      return json(res, 200, {
        ok: true,
        message: "Chrome launched. Run 'fly proxy 9222:9223' and connect via chrome://inspect (add localhost:9222)",
      });
    }

    // Stop setup chrome
    if (path === "/setup-stop" && method === "POST") {
      if (setupChromeProcess) {
        setupChromeProcess.kill();
        setupChromeProcess = null;
      }
      if (setupXvfbProcess) {
        setupXvfbProcess.kill();
        setupXvfbProcess = null;
      }
      return json(res, 200, { ok: true, message: "Setup chrome stopped" });
    }

    // Upload Chrome profile (tar.gz) — used by setup.mjs
    if (path === "/upload-profile" && method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buf = Buffer.concat(chunks);

      const profileDir = process.env.CHROME_PROFILE_DIR || "/data/chrome-profile";
      const tmpFile = "/tmp/profile.tar.gz";

      const { writeFileSync, rmSync, mkdirSync } = await import("node:fs");
      const { execSync } = await import("node:child_process");

      writeFileSync(tmpFile, buf);
      rmSync(profileDir, { recursive: true, force: true });
      mkdirSync(profileDir, { recursive: true });
      execSync(`tar xzf ${tmpFile} -C ${profileDir}`);
      rmSync(tmpFile);

      return json(res, 200, { ok: true, message: "Profile uploaded and extracted" });
    }

    // Import cookies JSON — save to disk for injection at launch time
    if (path === "/import-cookies" && method === "POST") {
      const body = await readBody(req);
      if (!body.cookies || !Array.isArray(body.cookies)) {
        return json(res, 400, { error: "cookies array is required" });
      }

      const { writeFileSync, mkdirSync } = await import("node:fs");
      const cookiesDir = process.env.CHROME_PROFILE_DIR || "/data/chrome-profile";
      mkdirSync(cookiesDir, { recursive: true });
      writeFileSync(`${cookiesDir}/google-cookies.json`, JSON.stringify(body.cookies));

      return json(res, 200, { ok: true, message: `Saved ${body.cookies.length} cookies` });
    }

    if (path === "/screenshot" && method === "POST") {
      const png = await takeScreenshot();
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": png.length,
      });
      return res.end(png);
    }

    // Proxy DevTools HTTP endpoints (for chrome://inspect discovery)
    if (path.startsWith("/cdp/") && method === "GET") {
      const targetPath = path.replace("/cdp", "");
      try {
        const proxyRes = await new Promise((resolve, reject) => {
          const r = httpRequest({
            hostname: "127.0.0.1",
            port: 9222,
            path: targetPath,
            method: "GET",
          }, resolve);
          r.on("error", reject);
          r.end();
        });
        let body = "";
        for await (const chunk of proxyRes) body += chunk;
        // Rewrite WebSocket URLs to go through our proxy
        const host = req.headers.host;
        const rewritten = body.replace(/ws:\/\/127\.0\.0\.1:9222/g, `wss://${host}/cdp`);
        res.writeHead(proxyRes.statusCode, {
          "Content-Type": proxyRes.headers["content-type"] || "application/json",
        });
        return res.end(rewritten);
      } catch {
        return json(res, 502, { error: "DevTools not available" });
      }
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(`[server] Error handling ${method} ${path}: ${err.message}`);
    json(res, 500, { error: err.message });
  }
});

// Proxy DevTools WebSocket connections
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (!url.pathname.startsWith("/cdp/")) {
    socket.destroy();
    return;
  }

  // Auth check via query param
  const key = url.searchParams.get("key");
  if (API_KEY && key !== API_KEY && req.headers["x-api-key"] !== API_KEY) {
    socket.destroy();
    return;
  }

  const targetPath = url.pathname.replace("/cdp", "");
  const target = createConnection({ host: "127.0.0.1", port: 9222 }, () => {
    // Forward the HTTP upgrade request to Chrome DevTools
    const upgradeReq = `GET ${targetPath} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:9222\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${req.headers["sec-websocket-key"]}\r\n` +
      `Sec-WebSocket-Version: ${req.headers["sec-websocket-version"]}\r\n` +
      `\r\n`;
    target.write(upgradeReq);
    if (head.length) target.write(head);
  });

  // Once target responds with upgrade, pipe both directions
  let headerParsed = false;
  let buffer = Buffer.alloc(0);
  target.on("data", (chunk) => {
    if (headerParsed) {
      socket.write(chunk);
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      // Forward the upgrade response to the client
      socket.write(buffer.slice(0, headerEnd + 4));
      const remaining = buffer.slice(headerEnd + 4);
      if (remaining.length) socket.write(remaining);
      headerParsed = true;
      // Now pipe bidirectionally
      socket.pipe(target);
    }
  });

  target.on("error", () => socket.destroy());
  socket.on("error", () => target.destroy());
  target.on("close", () => socket.destroy());
  socket.on("close", () => target.destroy());
});

server.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
});
