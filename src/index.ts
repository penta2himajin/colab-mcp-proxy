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
			"Get the status of the connected Google Colab runtime (GPU info, memory, etc.)",
			{},
			async () => {
				const result = await this.callColab("/status", "GET");
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
			"Register or update the Colab tunnel URL. Run this after starting the Colab executor.",
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
					"No Colab runtime connected. Please start the Colab executor notebook and register the tunnel URL using colab_register.",
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

export default new OAuthProvider({
	apiHandler: ColabMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});
