import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {Tool, JsonSchema} from './types.js';

export type {Tool, JsonSchema} from './types.js';

/** MCP clients by prefix */
export type McpClients = Record<string, Client>;

/**
 * Convert MCP clients to Tool[].
 *
 * Fetches tools, prompts, and resources from each client and wraps them as Tool objects.
 * Tool names are prefixed with the client key (e.g., 'gmail__send').
 */
export async function fromMcpClients(clients: McpClients): Promise<Tool[]> {
	const tools: Tool[] = [];

	// Process each client sequentially (they may share connections)
	for (const [prefix, client] of Object.entries(clients)) {
		// Fetch tools
		try {
			// eslint-disable-next-line no-await-in-loop -- Clients processed sequentially
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
						// Extract text content if present
						if (Array.isArray(result.content) && result.content.length > 0) {
							const first = result.content[0];
							if (first && 'text' in first) {
								try {
									return JSON.parse(first.text as string);
								} catch {
									return first.text;
								}
							}
						}

						return result.content;
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

		// Fetch prompts
		try {
			// eslint-disable-next-line no-await-in-loop -- Clients processed sequentially
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
						const result = await client.getPrompt({
							name: prompt.name,
							arguments: args as Record<string, string>,
						});
						return result;
					},
				});
			}
		} catch {
			// Client may not support prompts
		}

		// Fetch resources
		try {
			// eslint-disable-next-line no-await-in-loop -- Clients processed sequentially
			const {resources} = await client.listResources();
			for (const resource of resources) {
				tools.push({
					name: `${prefix}__resource__${resource.name}`,
					description: resource.description || `Read resource: ${resource.name}`,
					inputSchema: {
						type: 'object',
						properties: {},
					},
					async handler() {
						const result = await client.readResource({uri: resource.uri});
						return result;
					},
				});
			}
		} catch {
			// Client may not support resources
		}
	}

	return tools;
}
