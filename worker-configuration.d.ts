/* eslint-disable */
// Custom Env type for colab-mcp-proxy
declare namespace Cloudflare {
	interface Env {
		OAUTH_KV: KVNamespace;
		COLAB_KV: KVNamespace;
		GITHUB_CLIENT_ID: string;
		GITHUB_CLIENT_SECRET: string;
		COOKIE_ENCRYPTION_KEY: string;
		ALLOWED_USERS: string;
		MCP_OBJECT: DurableObjectNamespace<import("./src/index").ColabMCP>;
		FLYIO_API_TOKEN: string;
		FLYIO_APP_NAME: string;
		KEEPALIVE_API_KEY: string;
	}
}
interface Env extends Cloudflare.Env {}
