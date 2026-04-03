# colab-mcp-proxy

A Cloudflare Workers MCP server that proxies tool calls from claude.ai to a Google Colab GPU runtime.

```
claude.ai (Custom Connector)
  ↓ Streamable HTTP + OAuth 2.1
Cloudflare Workers (MCP Server + OAuth Provider)
  ↓ HTTPS
Google Colab (Flask executor + cloudflared tunnel)
```

With the optional **keepalive** integration, a fly.io container running headless Chrome keeps the Colab runtime alive by simulating UI interactions, and automatically starts the notebook and extracts the tunnel URL:

```
Claude → colab_start(notebook_url)
           ↓
    CF Worker
      1. fly.io Machines API → keepalive container start
      2. Pass notebook_url + callback_url
           ↓
    fly.io container (Headless Chrome + Puppeteer)
      1. Open Colab notebook (with persisted Google login cookies)
      2. Wait for runtime connection
      3. Run all cells (Flask + cloudflared)
      4. Extract trycloudflare.com tunnel URL from output
      5. POST tunnel URL to CF Worker callback → stored in COLAB_KV
      6. Keepalive mode (60s interval: UI click/key simulation)
      7. On disconnect → notify CF Worker → cleanup
           ↓
    CF Worker → return tunnel URL to Claude
    colab_exec, colab_python, etc. now work
```

## Setup

### 1. Create GitHub OAuth App

Go to https://github.com/settings/developers → New OAuth App:

- **Homepage URL**: `https://<your-worker>.workers.dev`
- **Callback URL**: `https://<your-worker>.workers.dev/callback`

### 2. Deploy CF Worker

```bash
npm install

# Create KV namespaces
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create COLAB_KV

# Update wrangler.jsonc with the returned KV IDs

# Set secrets
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY   # any random string
npx wrangler secret put ALLOWED_USERS            # comma-separated GitHub usernames (optional)

# Deploy
npm run deploy
```

### 3. Start Colab Executor (Manual Mode)

Paste the following cells into a Google Colab notebook:

<details>
<summary>Cell 1: Install dependencies</summary>

```python
!pip install flask
!wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared
!chmod +x /usr/local/bin/cloudflared
```

</details>

<details>
<summary>Cell 2: Flask executor</summary>

```python
import subprocess, threading, json, base64, os
from flask import Flask, request, jsonify

app = Flask(__name__)

@app.route("/status", methods=["GET"])
def status():
    gpu = subprocess.run(
        ["nvidia-smi", "--query-gpu=name,memory.total,memory.used,memory.free", "--format=csv,noheader"],
        capture_output=True, text=True,
    )
    mem = subprocess.run(["free", "-h"], capture_output=True, text=True)
    py = subprocess.run(["python3", "--version"], capture_output=True, text=True)
    return jsonify({"status": "connected", "gpu": gpu.stdout.strip() if gpu.returncode == 0 else "No GPU", "memory": mem.stdout.strip(), "python": py.stdout.strip()})

@app.route("/exec", methods=["POST"])
def exec_cmd():
    data = request.json
    try:
        r = subprocess.run(data["command"], shell=True, capture_output=True, text=True, timeout=data.get("timeout", 300))
        return jsonify({"stdout": r.stdout, "stderr": r.stderr, "returncode": r.returncode})
    except subprocess.TimeoutExpired:
        return jsonify({"error": "timeout"}), 408

@app.route("/python", methods=["POST"])
def exec_python():
    data = request.json
    with open("/tmp/_exec.py", "w") as f:
        f.write(data["code"])
    try:
        r = subprocess.run(["python3", "/tmp/_exec.py"], capture_output=True, text=True, timeout=data.get("timeout", 300))
        return jsonify({"stdout": r.stdout, "stderr": r.stderr, "returncode": r.returncode})
    except subprocess.TimeoutExpired:
        return jsonify({"error": "timeout"}), 408

@app.route("/upload", methods=["POST"])
def upload():
    data = request.json
    os.makedirs(os.path.dirname(data["path"]), exist_ok=True)
    with open(data["path"], "wb") as f:
        f.write(base64.b64decode(data["content"]))
    return jsonify({"status": "ok", "path": data["path"], "size": os.path.getsize(data["path"])})

@app.route("/download", methods=["POST"])
def download():
    data = request.json
    with open(data["path"], "rb") as f:
        content = base64.b64encode(f.read()).decode()
    return jsonify({"path": data["path"], "content_base64": content, "size": os.path.getsize(data["path"])})

threading.Thread(target=lambda: app.run(host="0.0.0.0", port=5000), daemon=True).start()
print("Flask server started on port 5000")
```

</details>

<details>
<summary>Cell 3: Start cloudflared tunnel</summary>

```python
import subprocess, re, time

proc = subprocess.Popen(
    ["/usr/local/bin/cloudflared", "tunnel", "--url", "http://localhost:5000", "--no-autoupdate"],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
)

tunnel_url = None
for _ in range(30):
    line = proc.stderr.readline()
    if "trycloudflare.com" in line:
        m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
        if m:
            tunnel_url = m.group(0)
            break
    time.sleep(1)

if tunnel_url:
    print(f"Tunnel URL: {tunnel_url}")
    print("Register this URL via the colab_register tool in claude.ai")
else:
    print("ERROR: Failed to get tunnel URL")
```

</details>

### 4. Connect from claude.ai

1. Settings → Connectors → Add custom connector
2. Remote MCP server URL: `https://<your-worker>.workers.dev/mcp`
3. Authenticate with GitHub
4. Use `colab_register` tool to register the tunnel URL

---

## Keepalive Setup (Automatic Mode)

The keepalive integration uses a fly.io container with headless Chrome to automatically open the Colab notebook, run the cells, extract the tunnel URL, and keep the runtime alive.

### 1. Deploy the keepalive container

```bash
# Install flyctl: https://fly.io/docs/flyctl/install/
cd keepalive

# Create the app (don't deploy yet)
fly launch --no-deploy

# Create a persistent volume for Chrome profile data
fly volumes create chrome_data --region nrt --size 1

# Generate an API key for the container
export KEEPALIVE_API_KEY=$(openssl rand -hex 16)
echo "KEEPALIVE_API_KEY=$KEEPALIVE_API_KEY"  # Save this!

# Set the secret on fly.io
fly secrets set API_KEY=$KEEPALIVE_API_KEY

# Deploy
fly deploy
```

### 2. Initial Google login

The keepalive container needs Google login cookies to access Colab. Do this once:

```bash
# Start Chrome in setup mode with remote debugging
curl -X POST https://colab-keepalive.fly.dev/setup \
  -H "X-Api-Key: $KEEPALIVE_API_KEY"

# Proxy the Chrome DevTools port to your local machine
fly proxy 9222:9222

# In your local Chrome browser:
# 1. Go to chrome://inspect
# 2. Click "Configure..." and add localhost:9222
# 3. Wait for the remote Chrome tab to appear
# 4. Click "inspect" on the accounts.google.com tab
# 5. Log in to your Google account in the remote browser
# 6. Close the inspector when done

# Stop the setup browser
curl -X POST https://colab-keepalive.fly.dev/stop \
  -H "X-Api-Key: $KEEPALIVE_API_KEY"
```

### 3. Add secrets to CF Worker

```bash
npx wrangler secret put FLYIO_API_TOKEN      # fly.io personal access token
npx wrangler secret put FLYIO_APP_NAME        # "colab-keepalive" (or your app name)
npx wrangler secret put KEEPALIVE_API_KEY     # Same key generated above

npm run deploy
```

### 4. Usage

Once set up, use `colab_start` in Claude to automatically launch the Colab runtime:

```
Use colab_start with the notebook URL to start the runtime.
```

Claude will:
1. Start the fly.io keepalive container
2. Open the notebook in headless Chrome
3. Run all cells
4. Extract and register the tunnel URL
5. Begin keepalive to prevent idle timeout

Use `colab_stop` to manually shut down the keepalive and Colab session.

Use `keepalive_screenshot` to debug — it returns a screenshot of the headless browser.

## Tools

| Tool | Description |
|------|-------------|
| `colab_start` | Start Colab runtime via fly.io keepalive (automatic setup) |
| `colab_stop` | Stop the keepalive session and clean up |
| `colab_status` | Get Colab runtime status (GPU, memory) |
| `colab_exec` | Execute a shell command |
| `colab_python` | Execute Python code with GPU access |
| `colab_upload` | Upload a file (base64) |
| `colab_download` | Download a file (base64) |
| `colab_register` | Manually register/update the Colab tunnel URL |
| `keepalive_screenshot` | Screenshot of the keepalive browser (debug) |

## Environment Variables (Secrets)

| Name | Required | Description |
|------|----------|-------------|
| `GITHUB_CLIENT_ID` | Yes | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | Yes | GitHub OAuth App client secret |
| `COOKIE_ENCRYPTION_KEY` | Yes | Random string for cookie signing |
| `ALLOWED_USERS` | No | Comma-separated GitHub usernames to restrict access |
| `FLYIO_API_TOKEN` | For keepalive | fly.io personal access token |
| `FLYIO_APP_NAME` | For keepalive | fly.io app name (e.g., "colab-keepalive") |
| `KEEPALIVE_API_KEY` | For keepalive | Shared API key for keepalive container auth |

## License

MIT
