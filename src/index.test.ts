import {test, expect, vi} from 'vitest';
import {createSandbox, type Tool} from './index';

const addTool: Tool = {
	name: 'add',
	description: 'Add two numbers',
	inputSchema: {
		type: 'object',
		properties: {a: {type: 'number'}, b: {type: 'number'}},
		required: ['a', 'b'],
	},
	async handler(args) {
		const {a, b} = args as {a: number; b: number};
		return a + b;
	},
};

const echoTool: Tool = {
	name: 'echo',
	description: 'Echo back the input',
	inputSchema: {
		type: 'object',
		properties: {message: {type: 'string'}},
	},
	async handler(args) {
		const {message} = args as {message: string};
		return {echoed: message};
	},
};

test('executes simple code', async () => {
	const sandbox = await createSandbox({tools: []});
	const result = await sandbox.execute.handler({code: 'return 1 + 1'});
	expect(result).toEqual({success: true, result: 2});
});

test('calls a tool', async () => {
	const sandbox = await createSandbox({tools: [addTool]});
	const result = await sandbox.execute.handler({
		code: 'return await tool(\'add\', { a: 2, b: 3 });',
	});
	expect(result).toEqual({success: true, result: 5});
});

test('calls multiple tools', async () => {
	const sandbox = await createSandbox({tools: [addTool, echoTool]});
	const result = await sandbox.execute.handler({
		code: `
      const sum = await tool('add', { a: 10, b: 20 });
      const echo = await tool('echo', { message: 'hello' });
      return { sum, echo };
    `,
	});
	expect(result).toEqual({
		success: true,
		result: {sum: 30, echo: {echoed: 'hello'}},
	});
});

test('persists store across executions', async () => {
	const sandbox = await createSandbox({tools: []});

	await sandbox.execute.handler({code: 'store.counter = 123'});
	const result = await sandbox.execute.handler({
		code: `
      store.counter += 42;
      return store.counter;
    `,
	});

	expect(result).toEqual({success: true, result: 165});
	expect(sandbox.store).toEqual({counter: 165});
});

test('provides _prev with previous result', async () => {
	const sandbox = await createSandbox({tools: []});

	await sandbox.execute.handler({code: 'return 42'});
	const result = await sandbox.execute.handler({code: 'return store._prev * store._prev;'});

	expect(result).toEqual({success: true, result: 1764});
});

test('handles tool not found', async () => {
	const sandbox = await createSandbox({tools: []});
	const result = await sandbox.execute.handler({
		code: 'return await tool(\'nonexistent\', {})',
	});
	expect(result).toEqual({
		success: false,
		error: 'Tool not found: nonexistent',
	});
});

test('handles tool errors', async () => {
	const failingTool: Tool = {
		name: 'fail',
		description: 'Always fails',
		inputSchema: {type: 'object'},
		async handler() {
			throw new Error('Intentional failure');
		},
	};

	const sandbox = await createSandbox({tools: [failingTool]});
	const result = await sandbox.execute.handler({
		code: 'return await tool(\'fail\', {})',
	});
	expect(result).toEqual({
		success: false,
		error: 'Intentional failure',
	});
});

test('handles syntax errors', async () => {
	const sandbox = await createSandbox({tools: []});
	const result = await sandbox.execute.handler({code: 'return {'});
	expect(result.success).toBe(false);
	expect(result.error).toMatchInlineSnapshot('"expecting \';\'"');
});

test('onBeforeToolCall can modify args', async () => {
	const handler = vi.fn(async (args) => args);
	const tool: Tool = {
		name: 'test',
		description: 'Test tool',
		inputSchema: {type: 'object'},
		handler,
	};

	const sandbox = await createSandbox({
		tools: [tool],
		onBeforeToolCall(event) {
			event.args = {...event.args as object, injected: true};
		},
	});

	await sandbox.execute.handler({
		code: 'return await tool(\'test\', { original: true })',
	});

	expect(handler).toHaveBeenCalledWith({original: true, injected: true});
});

test('onBeforeToolCall can short-circuit with returnValue', async () => {
	const handler = vi.fn(async () => 'should not be called');
	const tool: Tool = {
		name: 'test',
		description: 'Test tool',
		inputSchema: {type: 'object'},
		handler,
	};

	const sandbox = await createSandbox({
		tools: [tool],
		onBeforeToolCall(event) {
			event.returnValue = {cached: true};
		},
	});

	const result = await sandbox.execute.handler({
		code: 'return await tool(\'test\', {})',
	});

	expect(handler).not.toHaveBeenCalled();
	expect(result).toEqual({success: true, result: {cached: true}});
});

test('onBeforeToolCall can block with error', async () => {
	const sandbox = await createSandbox({
		tools: [addTool],
		onBeforeToolCall(event) {
			if (event.toolName === 'add') {
				throw new Error('Blocked');
			}
		},
	});

	const result = await sandbox.execute.handler({
		code: 'return await tool(\'add\', { a: 1, b: 2 })',
	});

	expect(result).toEqual({success: false, error: 'Blocked'});
});

test('onToolCallSuccess can modify result', async () => {
	const sandbox = await createSandbox({
		tools: [addTool],
		onToolCallSuccess(event) {
			event.result = (event.result as number) * 10;
		},
	});

	const result = await sandbox.execute.handler({
		code: 'return await tool(\'add\', { a: 1, b: 2 })',
	});

	expect(result).toEqual({success: true, result: 30});
});

test('onToolCallError can recover', async () => {
	const failingTool: Tool = {
		name: 'fail',
		description: 'Always fails',
		inputSchema: {type: 'object'},
		async handler() {
			throw new Error('Intentional failure');
		},
	};

	const sandbox = await createSandbox({
		tools: [failingTool],
		onToolCallError(event) {
			event.result = {recovered: true};
		},
	});

	const result = await sandbox.execute.handler({
		code: 'return await tool(\'fail\', {})',
	});

	expect(result).toEqual({success: true, result: {recovered: true}});
});

test('built-in describe_tool works', async () => {
	const sandbox = await createSandbox({tools: [addTool]});
	const result = await sandbox.execute.handler({
		code: 'return await tool(\'describe_tool\', { name: \'add\' })',
	});

	expect(result.success).toBe(true);
	expect((result.result as {name: string}).name).toBe('add');
	expect((result.result as {description: string}).description).toBe('Add two numbers');
});

test('describe_tool returns error for unknown tool', async () => {
	const sandbox = await createSandbox({tools: []});
	const result = await sandbox.execute.handler({
		code: 'return await tool(\'describe_tool\', { name: \'unknown\' })',
	});

	expect(result.success).toBe(true);
	expect((result.result as {error: string}).error).toBe('Tool not found: unknown');
});

test('addTool works', async () => {
	const sandbox = await createSandbox({tools: []});
	sandbox.addTool(addTool);

	const result = await sandbox.execute.handler({
		code: 'return await tool(\'add\', { a: 5, b: 7 })',
	});

	expect(result).toEqual({success: true, result: 12});
});

test('removeTool works', async () => {
	const sandbox = await createSandbox({tools: [addTool]});
	sandbox.removeTool('add');

	const result = await sandbox.execute.handler({
		code: 'return await tool(\'add\', { a: 1, b: 1 })',
	});

	expect(result).toEqual({success: false, error: 'Tool not found: add'});
});

test('throws on duplicate tool names at creation', async () => {
	await expect(createSandbox({tools: [addTool, addTool]}))
		.rejects.toThrow('Duplicate tool name: add');
});

test('addTool throws on duplicate name', async () => {
	const sandbox = await createSandbox({tools: [addTool]});
	expect(() => {
		sandbox.addTool(addTool);
	}).toThrow('Duplicate tool name: add');
});

test('removeTool throws on nonexistent tool', async () => {
	const sandbox = await createSandbox({tools: []});
	expect(() => {
		sandbox.removeTool('nonexistent');
	}).toThrow('Tool not found: nonexistent');
});

test('execute tool has correct metadata', async () => {
	const sandbox = await createSandbox({tools: [addTool]});

	expect(sandbox.execute.name).toBe('execute');
	expect(sandbox.execute.inputSchema).toEqual({
		type: 'object',
		properties: {code: {type: 'string', description: 'JavaScript code to execute'}},
		required: ['code'],
	});
	expect(sandbox.execute.description).toContain('add');
	expect(sandbox.execute.description).toContain('describe_tool');
});

test('console.log works', async () => {
	const consoleSpy = vi.spyOn(console, 'log');
	const sandbox = await createSandbox({tools: []});

	await sandbox.execute.handler({code: 'console.log("hello", "world")'});

	expect(consoleSpy).toHaveBeenCalledWith('[tool-sandbox]', 'hello', 'world');
	consoleSpy.mockRestore();
});

test('sleep tool works', async () => {
	const sandbox = await createSandbox({tools: []});

	const start = Date.now();
	const result = await sandbox.execute.handler({code: 'await tool(\'sleep\', {ms: 50}); return "done";'});
	const elapsed = Date.now() - start;

	expect(result).toEqual({success: true, result: 'done'});
	expect(elapsed).toBeGreaterThanOrEqual(45);
});

test('list_tools works', async () => {
	const sandbox = await createSandbox({tools: []});

	const result = await sandbox.execute.handler({
		code: 'return await tool(\'list_tools\', {});',
	});

	expect(result.success).toBe(true);
	const toolList = result.result as {name: string}[];
	expect(toolList.map((t) => t.name)).toContain('describe_tool');
	expect(toolList.map((t) => t.name)).toContain('list_tools');
	expect(toolList.map((t) => t.name)).toContain('sleep');
});

test.each(['fetch', 'require', 'setTimeout', 'setInterval'])('%s is not available in sandbox', async (name) => {
	const sandbox = await createSandbox({tools: []});
	const result = await sandbox.execute.handler({code: `return typeof ${name}`});
	expect(result).toEqual({success: true, result: 'undefined'});
});

test('dynamic import is not available in sandbox', async () => {
	const sandbox = await createSandbox({tools: []});
	const result = await sandbox.execute.handler({code: 'return import("foo")'});
	expect(result.success).toBe(false);
});

test('sandbox.store can be set from host', async () => {
	const sandbox = await createSandbox({tools: []});

	sandbox.store = {preset: 'adam'};
	const result = await sandbox.execute.handler({code: 'return store.preset'});

	expect(result).toEqual({success: true, result: 'adam'});
});
