import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {Tool, JsonSchema} from './types.js';

/** MCP clients keyed by prefix */
export type McpClients = Record<string, Client>;

/** Extract content from MCP result, preferring structuredContent */
function extractContent(result: unknown): unknown {
	const r = result as {structuredContent?: unknown; content?: unknown[]; isError?: boolean};

	// Check for error response
	if (r.isError) {
		const errorText = Array.isArray(r.content) && r.content.length > 0
			? (r.content[0] as {text?: string}).text || 'Unknown error'
			: 'Unknown error';
		throw new Error(errorText);
	}

	// Prefer structuredContent if available
	if (r.structuredContent !== undefined) {
		return r.structuredContent;
	}

	// Fall back to extracting from content array
	if (Array.isArray(r.content) && r.content.length > 0) {
		const first = r.content[0] as {text?: string};
		if (first && 'text' in first && typeof first.text === 'string') {
			try {
				return JSON.parse(first.text);
			} catch {
				return first.text;
			}
		}
	}

	return r.content ?? result;
}

/** Process a single MCP client and return its tools */
async function processClient(prefix: string, client: Client): Promise<Tool[]> {
	const tools: Tool[] = [];

	// Fetch tools
	try {
		const {tools: mcpTools} = await client.listTools();
		for (const mcpTool of mcpTools) {
			const tool: Tool = {
				name: `${prefix}__${mcpTool.name}`,
				inputSchema: mcpTool.inputSchema as Tool['inputSchema'],
				async handler(args) {
					const result = await client.callTool({
						name: mcpTool.name,
						arguments: args as Record<string, unknown>,
					});
					return extractContent(result);
				},
			};
			if (mcpTool.title) {
				tool.title = mcpTool.title;
			}

			if (mcpTool.description) {
				tool.description = mcpTool.description;
			}

			if (mcpTool.outputSchema) {
				tool.outputSchema = mcpTool.outputSchema as JsonSchema;
			}

			tools.push(tool);
		}
	} catch {
		// Client may not support tools
	}

	// Fetch prompts (with arguments for parameterized prompts)
	try {
		const {prompts} = await client.listPrompts();
		for (const prompt of prompts) {
			tools.push({
				name: `${prefix}__prompt__${prompt.name}`,
				description: prompt.description || `Get prompt: ${prompt.name}`,
				inputSchema: {
					type: 'object',
					properties: Object.fromEntries((prompt.arguments || []).map((arg) => [
						arg.name,
						{type: 'string', description: arg.description},
					])),
					required: (prompt.arguments || []).filter((a) => a.required).map((a) => a.name),
				},
				async handler(args) {
					return client.getPrompt({
						name: prompt.name,
						arguments: args as Record<string, string>,
					});
				},
			});
		}
	} catch {
		// Client may not support prompts
	}

	// Fetch resources
	try {
		const {resources} = await client.listResources();
		for (const resource of resources) {
			tools.push({
				name: `${prefix}__resource__${resource.name}`,
				description: resource.description || `Read resource: ${resource.name}`,
				inputSchema: {type: 'object', properties: {}},
				async handler() {
					return client.readResource({uri: resource.uri});
				},
			});
		}
	} catch {
		// Client may not support resources
	}

	// Fetch resource templates (parameterized resources)
	try {
		const {resourceTemplates} = await client.listResourceTemplates();
		for (const template of resourceTemplates) {
			// Extract parameters from URI template (e.g., "file:///{path}" -> ["path"])
			const params = [...template.uriTemplate.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).filter((p): p is string => p !== undefined);
			tools.push({
				name: `${prefix}__resource__${template.name}`,
				description: template.description || `Read resource: ${template.name}`,
				inputSchema: {
					type: 'object',
					properties: Object.fromEntries(params.map((p) => [p, {type: 'string'}])),
					required: params,
				},
				async handler(args) {
					// Substitute parameters into URI template
					let uri = template.uriTemplate;
					for (const [key, value] of Object.entries(args as Record<string, string>)) {
						uri = uri.replace(`{${key}}`, encodeURIComponent(value));
					}

					return client.readResource({uri});
				},
			});
		}
	} catch {
		// Client may not support resource templates
	}

	return tools;
}

/**
 * Convert MCP clients to Tool[].
 *
 * Fetches tools, prompts, resources, and resource templates from each client
 * and wraps them as Tool objects. Names are prefixed with the client key.
 *
 * Supported: tools, prompts (with arguments), resources, resource templates.
 * Not supported: sampling, elicitation, roots, notifications.
 */
export async function fromMcpClients(clients: McpClients): Promise<Tool[]> {
	const results = await Promise.all(Object.entries(clients).map(async ([prefix, client]) => processClient(prefix, client)));
	return results.flat();
}
