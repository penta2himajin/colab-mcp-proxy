import { createServer } from "node:http";
import {
  launchBrowser,
  startColabSession,
  closeBrowser,
  takeScreenshot,
  getState,
} from "./keepalive.mjs";

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
