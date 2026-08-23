import {test, expect, vi} from 'vitest';
import {createSandbox, type Tool, type ToolSource} from './index';

const staticTool: Tool = {
	name: 'local_double',
	description: 'Double a number',
	inputSchema: {
		type: 'object',
		properties: {n: {type: 'number'}},
		required: ['n'],
	},
	async handler(args) {
		const {n} = args as {n: number};
		return n * 2;
	},
};

const makeSource = (): ToolSource & {calls: string[]} => {
	const calls: string[] = [];
	return {
		calls,
		async call(name, args) {
			calls.push(`call:${name}`);
			if (name === 'remote_add') {
				const {a, b} = args as {a: number; b: number};
				return a + b;
			}

			throw new Error(`Tool not found: ${name}`);
		},
		async list() {
			calls.push('list');
			return [{name: 'remote_add', description: 'Add two numbers'}];
		},
		async describe(name) {
			calls.push(`describe:${name}`);
			if (name === 'remote_add') {
				return {name, description: 'Add two numbers', inputSchema: {type: 'object'}};
			}

			return {error: `Tool not found: ${name}`};
		},
	};
};

test('forwards unknown tool names to the toolSource', async () => {
	const toolSource = makeSource();
	const sandbox = await createSandbox({tools: [staticTool], toolSource});
	const result = await sandbox.execute.handler({
		code: 'return await tool(\'remote_add\', { a: 2, b: 3 });',
	});
	expect(result).toEqual({success: true, blobs: [], result: 5});
	expect(toolSource.calls).toEqual(['call:remote_add']);
});

test('static tools take precedence over the toolSource', async () => {
	const toolSource = makeSource();
	const sandbox = await createSandbox({tools: [staticTool], toolSource});
	const result = await sandbox.execute.handler({
		code: 'return await tool(\'local_double\', { n: 4 });',
	});
	expect(result).toEqual({success: true, blobs: [], result: 8});
	expect(toolSource.calls).toEqual([]);
});

test('makes no toolSource requests when code calls no tools', async () => {
	const toolSource = makeSource();
	const sandbox = await createSandbox({tools: [], toolSource});
	const result = await sandbox.execute.handler({code: 'return 2 + 2'});
	expect(result).toEqual({success: true, blobs: [], result: 4});
	expect(toolSource.calls).toEqual([]);
});

test('toolSource errors surface in the sandbox', async () => {
	const toolSource = makeSource();
	const sandbox = await createSandbox({tools: [], toolSource});
	const result = await sandbox.execute.handler({
		code: 'return await tool(\'missing_tool\', {});',
	});
	expect(result.success).toBe(false);
	expect(result.error).toContain('Tool not found: missing_tool');
});

test('list_tools includes toolSource tools after built-ins', async () => {
	const toolSource = makeSource();
	const sandbox = await createSandbox({tools: [staticTool], toolSource});
	const result = await sandbox.execute.handler({code: 'return await tool(\'list_tools\', {});'});
	expect(result.success).toBe(true);
	const names = (result.result as {name: string}[]).map((t) => t.name);
	expect(names).toContain('local_double');
	expect(names).toContain('remote_add');
	expect(toolSource.calls).toEqual(['list']);
});

test('describe_tool falls back to the toolSource', async () => {
	const toolSource = makeSource();
	const sandbox = await createSandbox({tools: [], toolSource});
	const result = await sandbox.execute.handler({
		code: 'return await tool(\'describe_tool\', { name: \'remote_add\' });',
	});
	expect(result).toEqual({
		success: true,
		blobs: [],
		result: {name: 'remote_add', description: 'Add two numbers', inputSchema: {type: 'object'}},
	});
});

test('tool call events fire for toolSource calls', async () => {
	const toolSource = makeSource();
	const onBeforeToolCall = vi.fn();
	const onToolCallSuccess = vi.fn();
	const sandbox = await createSandbox({
		tools: [], toolSource, onBeforeToolCall, onToolCallSuccess,
	});
	await sandbox.execute.handler({
		code: 'return await tool(\'remote_add\', { a: 1, b: 2 });',
	});
	expect(onBeforeToolCall).toHaveBeenCalledWith(expect.objectContaining({toolName: 'remote_add'}));
	expect(onToolCallSuccess).toHaveBeenCalledWith(expect.objectContaining({toolName: 'remote_add', result: 3}));
});
