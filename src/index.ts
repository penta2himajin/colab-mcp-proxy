import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";

// Context from the auth process, encrypted & stored in the auth token
// and provided to the DurableMCP as this.props
type Props = {
	login: string;
	name: string;
	email: string;
	accessToken: string;
};

// ── fly.io Machines API helpers ─────────────────────────────────────

const FLYIO_API_BASE = "https://api.machines.dev/v1";

async function flyApiCall(
	env: Env,
	path: string,
	method: "GET" | "POST" = "GET",
	body?: unknown,
): Promise<Response> {
	return fetch(`${FLYIO_API_BASE}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${env.FLYIO_API_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
	});
}

async function getKeepaliveUrl(env: Env): Promise<string> {
	return `https://${env.FLYIO_APP_NAME}.fly.dev`;
}

async function keepaliveApiCall(
	env: Env,
	path: string,
	method: "GET" | "POST" = "GET",
	body?: unknown,
): Promise<Response> {
	const baseUrl = await getKeepaliveUrl(env);
	return fetch(`${baseUrl}${path}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			"X-Api-Key": env.KEEPALIVE_API_KEY,
		},
		body: body ? JSON.stringify(body) : undefined,
	});
}

async function ensureMachineStarted(env: Env): Promise<{ ok: boolean; error?: string }> {
	const listRes = await flyApiCall(env, `/apps/${env.FLYIO_APP_NAME}/machines`);
	if (!listRes.ok) {
		return { ok: false, error: `Failed to list machines: ${listRes.status}` };
	}

	const machines = (await listRes.json()) as Array<{ id: string; state: string }>;
	if (machines.length === 0) {
		return {
			ok: false,
			error: "No machines found. Please deploy the keepalive container first with 'fly deploy'.",
		};
	}

	const machine = machines[0];
	if (machine.state !== "started") {
		const startRes = await flyApiCall(
			env,
			`/apps/${env.FLYIO_APP_NAME}/machines/${machine.id}/start`,
			"POST",
		);
		if (!startRes.ok && startRes.status !== 200) {
			return { ok: false, error: `Failed to start machine: ${startRes.status}` };
		}
	}

	return { ok: true };
}

async function waitForHealth(env: Env, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	const baseUrl = await getKeepaliveUrl(env);

	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${baseUrl}/health`, {
				signal: AbortSignal.timeout(5000),
			});
			if (res.ok) return true;
		} catch {
			// Not ready yet
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	return false;
}

async function stopMachine(env: Env): Promise<void> {
	const listRes = await flyApiCall(env, `/apps/${env.FLYIO_APP_NAME}/machines`);
	if (!listRes.ok) return;

	const machines = (await listRes.json()) as Array<{ id: string; state: string }>;
	for (const machine of machines) {
		if (machine.state === "started") {
			await flyApiCall(
				env,
				`/apps/${env.FLYIO_APP_NAME}/machines/${machine.id}/stop`,
				"POST",
			);
		}
	}
}

// ── MCP Server ──────────────────────────────────────────────────────

export class ColabMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Colab MCP Proxy",
		version: "1.0.0",
	});

	async init() {
		const allowedUsers = (this.env.ALLOWED_USERS || "").split(",").map((s) => s.trim()).filter(Boolean);
		if (allowedUsers.length > 0 && !allowedUsers.includes(this.props!.login)) {
			return; // Unauthorized user — expose no tools
		}

		this.server.tool(
			"colab_status",
			"Get the status of the Colab system. Shows tunnel URL readiness, keepalive state, and runtime info (GPU, memory). Call this after colab_start to check when the runtime is ready.",
			{},
			async () => {
				const tunnelUrl = await this.env.COLAB_KV.get("colab_tunnel_url");
				const keepaliveStatus = await (async () => {
					try {
						const res = await keepaliveApiCall(this.env, "/status", "GET");
						if (res.ok) return await res.json();
					} catch { /* container may be stopped */ }
					return null;
				})();

				if (!tunnelUrl) {
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								tunnel_connected: false,
								message: "No tunnel URL registered yet. If colab_start was called, the runtime is still starting up.",
								keepalive: keepaliveStatus,
							}, null, 2),
						}],
					};
				}

				// Tunnel URL exists — try to get runtime status
				const result = await this.callColab("/status", "GET");
				return {
					content: [{
						type: "text",
						text: JSON.stringify({
							tunnel_connected: true,
							tunnel_url: tunnelUrl,
							keepalive: keepaliveStatus,
							runtime: result,
						}, null, 2),
					}],
				};
			},
		);

		this.server.tool(
			"colab_exec",
			"Execute a shell command on the Google Colab runtime",
			{
				command: z.string().describe("Shell command to execute"),
				timeout: z.number().optional().describe("Timeout in seconds (default: 300)"),
			},
			async ({ command, timeout }) => {
				const result = await this.callColab("/exec", "POST", {
					command,
					timeout: timeout || 300,
				});
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
			},
		);

		this.server.tool(
			"colab_python",
			"Execute Python code on the Google Colab runtime with GPU access",
			{
				code: z.string().describe("Python code to execute"),
				timeout: z.number().optional().describe("Timeout in seconds (default: 300)"),
			},
			async ({ code, timeout }) => {
				const result = await this.callColab("/python", "POST", {
					code,
					timeout: timeout || 300,
				});
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
			},
		);

		this.server.tool(
			"colab_upload",
			"Upload a file to the Colab runtime (base64 encoded content)",
			{
				path: z.string().describe("Destination path on Colab (e.g., /content/model.py)"),
				content_base64: z.string().describe("File content encoded in base64"),
			},
			async ({ path, content_base64 }) => {
				const result = await this.callColab("/upload", "POST", {
					path,
					content: content_base64,
				});
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
			},
		);

		this.server.tool(
			"colab_download",
			"Download a file from the Colab runtime (returns base64 encoded content)",
			{
				path: z.string().describe("File path on Colab to download"),
			},
			async ({ path }) => {
				const result = await this.callColab("/download", "POST", { path });
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
			},
		);

		this.server.tool(
			"colab_register",
			"Manually register or update the Colab tunnel URL. Normally colab_start handles this automatically. Use this only when manually setting up the tunnel.",
			{
				tunnel_url: z.string().url().describe("The cloudflared tunnel URL of the Colab executor"),
			},
			async ({ tunnel_url }) => {
				await this.env.COLAB_KV.put("colab_tunnel_url", tunnel_url);
				return {
					content: [{ type: "text", text: `Colab tunnel URL registered: ${tunnel_url}` }],
				};
			},
		);

		this.server.tool(
			"colab_start",
			"Start a Colab runtime via the fly.io keepalive container. Opens the notebook, runs all cells, extracts the tunnel URL, and begins keepalive to prevent idle timeout.",
			{
				notebook_url: z.string().url().describe("Google Colab notebook URL to open"),
			},
			async ({ notebook_url }) => {
				try {
					// 1. Ensure fly.io machine is started
					const machineResult = await ensureMachineStarted(this.env);
					if (!machineResult.ok) {
						return {
							content: [{ type: "text", text: `Error: ${machineResult.error}` }],
						};
					}

					// 2. Wait for container health
					const healthy = await waitForHealth(this.env, 30_000);
					if (!healthy) {
						return {
							content: [{
								type: "text",
								text: "Error: Keepalive container failed to become healthy within 30 seconds.",
							}],
						};
					}

					// 3. Get the worker's own URL for callback
					const workerUrl = `https://colab-mcp-proxy.penta2himajin.workers.dev`;
					const callbackUrl = `${workerUrl}/internal/register-tunnel`;

					// 4. Clear any stale tunnel URL
					await this.env.COLAB_KV.delete("colab_tunnel_url");

					// 5. Tell keepalive container to start the session (async — returns 202)
					const startRes = await keepaliveApiCall(this.env, "/start", "POST", {
						notebook_url,
						callback_url: callbackUrl,
					});

					if (!startRes.ok) {
						const errText = await startRes.text();
						return {
							content: [{
								type: "text",
								text: `Error starting keepalive session: ${startRes.status} ${errText}`,
							}],
						};
					}

					// 6. Return immediately — use colab_status to check when ready
					return {
						content: [{
							type: "text",
							text: "Colab session starting. The keepalive container is now opening the notebook, connecting the runtime, and running all cells.\n\nUse colab_status to check when the tunnel URL is ready (typically 1-3 minutes).\nUse keepalive_screenshot to see the current browser state if needed.",
						}],
					};
				} catch (e: unknown) {
					const message = e instanceof Error ? e.message : String(e);
					return {
						content: [{ type: "text", text: `Error in colab_start: ${message}` }],
					};
				}
			},
		);

		this.server.tool(
			"colab_stop",
			"Stop the Colab keepalive session, clean up the tunnel URL, and stop the fly.io machine.",
			{},
			async () => {
				try {
					// 1. Tell keepalive container to stop
					try {
						await keepaliveApiCall(this.env, "/stop", "POST");
					} catch {
						// Container might already be stopped
					}

					// 2. Clean up KV
					await this.env.COLAB_KV.delete("colab_tunnel_url");
					await this.env.COLAB_KV.delete("ping_failures");

					// 3. Stop the fly.io machine
					await stopMachine(this.env);

					return {
						content: [{ type: "text", text: "Colab keepalive stopped and cleaned up." }],
					};
				} catch (e: unknown) {
					const message = e instanceof Error ? e.message : String(e);
					return {
						content: [{ type: "text", text: `Error in colab_stop: ${message}` }],
					};
				}
			},
		);

		this.server.tool(
			"keepalive_screenshot",
			"Take a screenshot of the keepalive container's browser for debugging.",
			{},
			async () => {
				try {
					const res = await keepaliveApiCall(this.env, "/screenshot", "POST");
					if (!res.ok) {
						return {
							content: [{
								type: "text",
								text: `Screenshot failed: ${res.status} ${await res.text()}`,
							}],
						};
					}

					const arrayBuf = await res.arrayBuffer();
					const base64 = btoa(
						String.fromCharCode(...new Uint8Array(arrayBuf)),
					);

					return {
						content: [{
							type: "image",
							data: base64,
							mimeType: "image/png",
						}],
					};
				} catch (e: unknown) {
					const message = e instanceof Error ? e.message : String(e);
					return {
						content: [{ type: "text", text: `Screenshot error: ${message}` }],
					};
				}
			},
		);
	}

	private async callColab(
		path: string,
		method: "GET" | "POST",
		body?: Record<string, unknown>,
	): Promise<unknown> {
		const tunnelUrl = await this.env.COLAB_KV.get("colab_tunnel_url");
		if (!tunnelUrl) {
			return {
				error:
					"No Colab runtime connected. Use colab_start to start a Colab session, or colab_register to manually register a tunnel URL.",
			};
		}

		try {
			const response = await fetch(`${tunnelUrl}${path}`, {
				method,
				headers: { "Content-Type": "application/json" },
				body: body ? JSON.stringify(body) : undefined,
			});

			if (!response.ok) {
				return {
					error: `Colab returned HTTP ${response.status}: ${await response.text()}`,
				};
			}

			return await response.json();
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			return {
				error: `Failed to connect to Colab: ${message}. The runtime may have disconnected.`,
			};
		}
	}
}

const oauthProvider = new OAuthProvider({
	apiHandler: ColabMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});

// ── Internal endpoint handlers ──────────────────────────────────────

async function handleInternalEndpoint(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const url = new URL(request.url);

	// Only handle /internal/* paths
	if (!url.pathname.startsWith("/internal/")) return null;

	// Authenticate with KEEPALIVE_API_KEY
	if (request.headers.get("X-Api-Key") !== env.KEEPALIVE_API_KEY) {
		return new Response(JSON.stringify({ error: "Unauthorized" }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		});
	}

	if (url.pathname === "/internal/register-tunnel" && request.method === "POST") {
		const body = (await request.json()) as { tunnel_url?: string };
		if (body.tunnel_url) {
			await env.COLAB_KV.put("colab_tunnel_url", body.tunnel_url);
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: "tunnel_url required" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}

	if (url.pathname === "/internal/deregister-tunnel" && request.method === "POST") {
		await env.COLAB_KV.delete("colab_tunnel_url");
		return new Response(JSON.stringify({ ok: true }), {
			headers: { "Content-Type": "application/json" },
		});
	}

	return new Response(JSON.stringify({ error: "Not found" }), {
		status: 404,
		headers: { "Content-Type": "application/json" },
	});
}

// ── Export ───────────────────────────────────────────────────────────

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		// Handle internal endpoints before OAuth
		const internalResponse = await handleInternalEndpoint(request, env);
		if (internalResponse) return internalResponse;

		return oauthProvider.fetch(request, env, ctx);
	},

	async scheduled(
		_controller: ScheduledController,
		env: Env,
		_ctx: ExecutionContext,
	) {
		const tunnelUrl = await env.COLAB_KV.get("colab_tunnel_url");
		if (!tunnelUrl) return;

		try {
			const res = await fetch(`${tunnelUrl}/status`, {
				signal: AbortSignal.timeout(10_000),
			});

			if (res.ok) {
				// Reset failure counter on success
				await env.COLAB_KV.delete("ping_failures");
				return;
			}
		} catch {
			// Connection failed
		}

		// Increment failure counter
		const failuresStr = await env.COLAB_KV.get("ping_failures");
		const failures = (failuresStr ? parseInt(failuresStr, 10) : 0) + 1;

		if (failures >= 5) {
			// 5 consecutive failures — clean up
			console.log("Colab ping failed 5 times, cleaning up");
			await env.COLAB_KV.delete("colab_tunnel_url");
			await env.COLAB_KV.delete("ping_failures");

			// Best-effort: stop keepalive container and machine
			try {
				await keepaliveApiCall(env, "/stop", "POST");
			} catch {
				// Ignore
			}
			try {
				await stopMachine(env);
			} catch {
				// Ignore
			}
		} else {
			await env.COLAB_KV.put("ping_failures", String(failures));
		}
	},
};
