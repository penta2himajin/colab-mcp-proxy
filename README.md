# colab-mcp-proxy

A Cloudflare Workers MCP server that proxies tool calls from claude.ai to a Google Colab GPU runtime.

```
claude.ai (Custom Connector)
  ↓ Streamable HTTP + OAuth 2.1
Cloudflare Workers (MCP Server + OAuth Provider)
  ↓ HTTPS
Google Colab (Flask executor + cloudflared tunnel)
```

## Setup

### 1. Create GitHub OAuth App

Go to https://github.com/settings/developers → New OAuth App:

- **Homepage URL**: `https://<your-worker>.workers.dev`
- **Callback URL**: `https://<your-worker>.workers.dev/callback`

### 2. Deploy

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

### 3. Start Colab Executor

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

## Tools

| Tool | Description |
|------|-------------|
| `colab_status` | Get Colab runtime status (GPU, memory) |
| `colab_exec` | Execute a shell command |
| `colab_python` | Execute Python code with GPU access |
| `colab_upload` | Upload a file (base64) |
| `colab_download` | Download a file (base64) |
| `colab_register` | Register/update the Colab tunnel URL |

## Environment Variables (Secrets)

| Name | Required | Description |
|------|----------|-------------|
| `GITHUB_CLIENT_ID` | Yes | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | Yes | GitHub OAuth App client secret |
| `COOKIE_ENCRYPTION_KEY` | Yes | Random string for cookie signing |
| `ALLOWED_USERS` | No | Comma-separated GitHub usernames to restrict access |

## License

MIT
