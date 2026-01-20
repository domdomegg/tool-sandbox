import {test, expect} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {McpServer, ResourceTemplate} from '@modelcontextprotocol/sdk/server/mcp.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {z} from 'zod';
import {fromMcpClients} from './mcp.js';
import {createSandbox} from './index.js';

/** Create a test MCP server with all supported features */
function createTestServer() {
	const server = new McpServer({name: 'test-server', version: '1.0.0'});

	// Tool with structuredContent and outputSchema
	server.registerTool('add', {
		description: 'Add two numbers',
		inputSchema: {a: z.number(), b: z.number()},
		outputSchema: {sum: z.number()},
	}, async ({a, b}) => ({
		content: [{type: 'text' as const, text: JSON.stringify({sum: a + b})}],
		structuredContent: {sum: a + b},
	}));

	// Tool with text content
	server.registerTool('greet', {
		description: 'Greet someone',
		inputSchema: {name: z.string()},
	}, async ({name}) => ({
		content: [{type: 'text' as const, text: `Hello, ${name}!`}],
	}));

	// Tool that throws an error
	server.registerTool('fail', {
		description: 'Always fails',
		inputSchema: {},
	}, async () => {
		throw new Error('Intentional failure');
	});

	// Prompts
	server.registerPrompt('simple', {
		description: 'A simple prompt',
	}, async () => ({
		messages: [{role: 'user' as const, content: {type: 'text' as const, text: 'Hello!'}}],
	}));

	server.registerPrompt('greeting', {
		description: 'Generate a greeting',
		argsSchema: {name: z.string()},
	}, async ({name}) => ({
		messages: [{role: 'user' as const, content: {type: 'text' as const, text: `Hello, ${name}!`}}],
	}));

	// Resources
	server.registerResource('config', 'test://config', {description: 'Configuration data'}, async () => ({
		contents: [{uri: 'test://config', text: JSON.stringify({setting: 'value'})}],
	}));

	// Resource templates - callback receives (uri, params)
	server.registerResource('file', new ResourceTemplate('test://files/{path}', {list: undefined}), {description: 'Read a file by path'}, async (uri, params) => ({
		contents: [{uri: uri.href, text: `Contents of ${String(params.path)}`}],
	}));

	return server;
}

/** Connect client and server via InMemoryTransport */
async function createConnectedClient(): Promise<Client> {
	const client = new Client({name: 'test-client', version: '1.0.0'}, {capabilities: {}});
	const server = createTestServer();

	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

	await Promise.all([
		client.connect(clientTransport),
		server.server.connect(serverTransport),
	]);

	return client;
}

test('fromMcpClients creates prefixed tools with correct schemas', async () => {
	const client = await createConnectedClient();
	const tools = await fromMcpClients({test: client});

	// Tools are prefixed with client key
	expect(tools.find((t) => t.name === 'test__add')).toBeDefined();
	expect(tools.find((t) => t.name === 'test__prompt__simple')).toBeDefined();
	expect(tools.find((t) => t.name === 'test__resource__config')).toBeDefined();
	expect(tools.find((t) => t.name === 'test__resource__file')).toBeDefined();

	// Prompt arguments become inputSchema properties
	const greetingPrompt = tools.find((t) => t.name === 'test__prompt__greeting');
	expect(greetingPrompt?.inputSchema.properties).toHaveProperty('name');
	expect(greetingPrompt?.inputSchema.required).toContain('name');

	// Resource template parameters become inputSchema properties
	const fileTemplate = tools.find((t) => t.name === 'test__resource__file');
	expect(fileTemplate?.inputSchema.properties).toHaveProperty('path');
});

test('MCP tool with structuredContent can be called from sandbox', async () => {
	const client = await createConnectedClient();
	const mcpTools = await fromMcpClients({test: client});
	const sandbox = await createSandbox({tools: mcpTools});

	const result = await sandbox.execute.handler({
		code: 'return await tool(\'test__add\', {a: 5, b: 3});',
	});

	// structuredContent is preferred by extractContent
	expect(result).toEqual({success: true, result: {sum: 8}});
});

test('MCP tool returning text can be called from sandbox', async () => {
	const client = await createConnectedClient();
	const mcpTools = await fromMcpClients({test: client});
	const sandbox = await createSandbox({tools: mcpTools});

	const result = await sandbox.execute.handler({
		code: 'return await tool(\'test__greet\', {name: \'Alice\'});',
	});

	expect(result).toEqual({success: true, result: 'Hello, Alice!'});
});

test('MCP prompt can be called from sandbox', async () => {
	const client = await createConnectedClient();
	const mcpTools = await fromMcpClients({test: client});
	const sandbox = await createSandbox({tools: mcpTools});

	const result = await sandbox.execute.handler({
		code: 'return await tool(\'test__prompt__simple\', {});',
	});

	expect(result).toMatchObject({
		success: true,
		result: {messages: [{role: 'user', content: {type: 'text', text: 'Hello!'}}]},
	});
});

test('MCP prompt with arguments can be called from sandbox', async () => {
	const client = await createConnectedClient();
	const mcpTools = await fromMcpClients({test: client});
	const sandbox = await createSandbox({tools: mcpTools});

	const result = await sandbox.execute.handler({
		code: 'return await tool(\'test__prompt__greeting\', {name: \'Alice\'});',
	});

	expect(result).toMatchObject({
		success: true,
		result: {messages: [{role: 'user', content: {type: 'text', text: 'Hello, Alice!'}}]},
	});
});

test('MCP resource can be called from sandbox', async () => {
	const client = await createConnectedClient();
	const mcpTools = await fromMcpClients({test: client});
	const sandbox = await createSandbox({tools: mcpTools});

	const result = await sandbox.execute.handler({
		code: 'return await tool(\'test__resource__config\', {});',
	});

	expect(result).toMatchObject({
		success: true,
		result: {contents: [{uri: 'test://config', text: '{"setting":"value"}'}]},
	});
});

test('MCP resource template can be called from sandbox', async () => {
	const client = await createConnectedClient();
	const mcpTools = await fromMcpClients({test: client});
	const sandbox = await createSandbox({tools: mcpTools});

	const result = await sandbox.execute.handler({
		code: 'return await tool(\'test__resource__file\', {path: \'readme.md\'});',
	});

	// Check that the result contains the expected file content
	expect(result).toMatchObject({success: true});
	const contents = (result as {result: {contents: {text: string}[]}}).result?.contents;
	expect(contents?.[0]?.text).toBe('Contents of readme.md');
});

test('MCP tool error is handled in sandbox', async () => {
	const client = await createConnectedClient();
	const mcpTools = await fromMcpClients({test: client});
	const sandbox = await createSandbox({tools: mcpTools});

	const result = await sandbox.execute.handler({
		code: 'return await tool(\'test__fail\', {});',
	});

	expect(result).toMatchObject({success: false});
	expect(result.error).toContain('Intentional failure');
});

test('describe_tool works with MCP tools', async () => {
	const client = await createConnectedClient();
	const mcpTools = await fromMcpClients({test: client});
	const sandbox = await createSandbox({tools: mcpTools});

	const result = await sandbox.execute.handler({
		code: 'return await tool(\'describe_tool\', {name: \'test__add\'});',
	});

	expect(result.success).toBe(true);
	expect(result.result).toMatchObject({
		name: 'test__add',
		description: 'Add two numbers',
	});
});

test('multiple MCP clients are processed in parallel', async () => {
	const client1 = await createConnectedClient();
	const client2 = await createConnectedClient();

	const tools = await fromMcpClients({
		first: client1,
		second: client2,
	});

	// Should have tools from both clients
	expect(tools.find((t) => t.name === 'first__add')).toBeDefined();
	expect(tools.find((t) => t.name === 'second__add')).toBeDefined();
});
