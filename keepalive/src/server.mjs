import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  launchBrowser,
  startColabSession,
  closeBrowser,
  takeScreenshot,
  getState,
} from "./keepalive.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY;
const REMOTE_HTML = readFileSync(join(__dirname, "remote.html"), "utf-8");

function authenticate(req) {
  if (!API_KEY) return true;
  // Accept API key from header or query parameter
  const url = new URL(req.url, `http://localhost:${PORT}`);
  return req.headers["x-api-key"] === API_KEY || url.searchParams.get("key") === API_KEY;
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

  // Remote browser UI — serves HTML, auth via query param
  if (path === "/remote" && method === "GET") {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const key = url.searchParams.get("key");
    if (API_KEY && key !== API_KEY) {
      return json(res, 401, { error: "Unauthorized" });
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(REMOTE_HTML);
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

    if (path === "/setup" && method === "POST") {
      // Launch browser without navigating — user will navigate via DevTools
      await launchBrowser(null, { setup: true });
      return json(res, 200, {
        ok: true,
        message: "Chrome launched with remote debugging on port 9222.",
      });
    }

    // Proxy DevTools JSON endpoints
    if (path.startsWith("/devtools-proxy/") && method === "GET") {
      const devtoolsPath = path.replace("/devtools-proxy", "");
      try {
        const proxyRes = await fetch(`http://127.0.0.1:9222${devtoolsPath}`);
        const text = await proxyRes.text();
        res.writeHead(proxyRes.status, { "Content-Type": proxyRes.headers.get("content-type") || "application/json" });
        return res.end(text);
      } catch (err) {
        return json(res, 502, { error: `DevTools proxy error: ${err.message}` });
      }
    }

    // Navigate to a URL in the setup browser
    if (path === "/navigate" && method === "POST") {
      const body = await readBody(req);
      if (!body.url) return json(res, 400, { error: "url is required" });
      const { navigateTo } = await import("./keepalive.mjs");
      await navigateTo(body.url);
      return json(res, 200, { ok: true, url: body.url });
    }

    // Type text into focused element
    if (path === "/type" && method === "POST") {
      const body = await readBody(req);
      if (!body.text && !body.key) return json(res, 400, { error: "text or key is required" });
      const { typeText, pressKey } = await import("./keepalive.mjs");
      if (body.key) {
        await pressKey(body.key);
      } else {
        await typeText(body.text);
      }
      return json(res, 200, { ok: true });
    }

    // Click at coordinates or selector
    if (path === "/click" && method === "POST") {
      const body = await readBody(req);
      const { clickAt, clickSelector } = await import("./keepalive.mjs");
      if (body.selector) {
        await clickSelector(body.selector);
      } else if (body.x !== undefined && body.y !== undefined) {
        await clickAt(body.x, body.y);
      } else {
        return json(res, 400, { error: "selector or x,y coordinates required" });
      }
      return json(res, 200, { ok: true });
    }

    // Upload Chrome profile (tar.gz)
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

    if (path === "/screenshot" && method === "POST") {
      const png = await takeScreenshot();
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": png.length,
      });
      return res.end(png);
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(`[server] Error handling ${method} ${path}: ${err.message}`);
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
});
