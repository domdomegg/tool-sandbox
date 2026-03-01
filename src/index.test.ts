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
	expect(result).toEqual({success: true, blobs: [], result: 2});
});

test('calls a tool', async () => {
	const sandbox = await createSandbox({tools: [addTool]});
	const result = await sandbox.execute.handler({
		code: 'return await tool(\'add\', { a: 2, b: 3 });',
	});
	expect(result).toEqual({success: true, blobs: [], result: 5});
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
		blobs: [],
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

	expect(result).toEqual({success: true, blobs: [], result: 165});
	expect(sandbox.store).toEqual({counter: 165});
});

test('provides _prev with previous result', async () => {
	const sandbox = await createSandbox({tools: []});

	await sandbox.execute.handler({code: 'return 42'});
	const result = await sandbox.execute.handler({code: 'return store._prev * store._prev;'});

	expect(result).toEqual({success: true, blobs: [], result: 1764});
});

test('handles tool not found', async () => {
	const sandbox = await createSandbox({tools: []});
	const result = await sandbox.execute.handler({
		code: 'return await tool(\'nonexistent\', {})',
	});
	expect(result).toEqual({
		success: false,
		blobs: [],
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
		blobs: [],
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
	expect(result).toEqual({success: true, blobs: [], result: {cached: true}});
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

	expect(result).toEqual({success: false, blobs: [], error: 'Blocked'});
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

	expect(result).toEqual({success: true, blobs: [], result: 30});
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

	expect(result).toEqual({success: true, blobs: [], result: {recovered: true}});
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

	expect(result).toEqual({success: true, blobs: [], result: 12});
});

test('removeTool works', async () => {
	const sandbox = await createSandbox({tools: [addTool]});
	sandbox.removeTool('add');

	const result = await sandbox.execute.handler({
		code: 'return await tool(\'add\', { a: 1, b: 1 })',
	});

	expect(result).toEqual({success: false, blobs: [], error: 'Tool not found: add'});
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


test('sleep tool works', async () => {
	const sandbox = await createSandbox({tools: []});

	const start = Date.now();
	const result = await sandbox.execute.handler({code: 'await tool(\'sleep\', {ms: 50}); return "done";'});
	const elapsed = Date.now() - start;

	expect(result).toEqual({success: true, blobs: [], result: 'done'});
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
	expect(toolList.map((t) => t.name)).toContain('get_blob');
});

test.each(['fetch', 'require', 'setTimeout', 'setInterval'])('%s is not available in sandbox', async (name) => {
	const sandbox = await createSandbox({tools: []});
	const result = await sandbox.execute.handler({code: `return typeof ${name}`});
	expect(result).toEqual({success: true, blobs: [], result: 'undefined'});
});

test('setTimeout error includes helpful hint about sleep tool', async () => {
	const sandbox = await createSandbox({tools: []});
	const result = await sandbox.execute.handler({code: 'setTimeout(() => {}, 100)'});
	expect(result.success).toBe(false);
	expect(result.error).toContain("'setTimeout' is not defined");
	expect(result.error).toContain("sleep");
});

test('sandbox has expected globals', async () => {
	const sandbox = await createSandbox({tools: []});
	const result = await sandbox.execute.handler({
		code: `
			const names = Object.getOwnPropertyNames(globalThis).sort();
			return Object.fromEntries(names.map(n => [n, typeof globalThis[n]]));
		`,
	});
	expect(result.success).toBe(true);
	expect(result.result).toMatchInlineSnapshot(`
		{
		  "AggregateError": "function",
		  "Array": "function",
		  "ArrayBuffer": "function",
		  "BigInt": "function",
		  "BigInt64Array": "function",
		  "BigUint64Array": "function",
		  "Boolean": "function",
		  "DataView": "function",
		  "Date": "function",
		  "Error": "function",
		  "EvalError": "function",
		  "Float32Array": "function",
		  "Float64Array": "function",
		  "Function": "function",
		  "Infinity": "number",
		  "Int16Array": "function",
		  "Int32Array": "function",
		  "Int8Array": "function",
		  "InternalError": "function",
		  "JSON": "object",
		  "Map": "function",
		  "Math": "object",
		  "NaN": "number",
		  "Number": "function",
		  "Object": "function",
		  "Promise": "function",
		  "Proxy": "function",
		  "RangeError": "function",
		  "ReferenceError": "function",
		  "Reflect": "object",
		  "RegExp": "function",
		  "Set": "function",
		  "SharedArrayBuffer": "function",
		  "String": "function",
		  "Symbol": "function",
		  "SyntaxError": "function",
		  "TypeError": "function",
		  "URIError": "function",
		  "Uint16Array": "function",
		  "Uint32Array": "function",
		  "Uint8Array": "function",
		  "Uint8ClampedArray": "function",
		  "WeakMap": "function",
		  "WeakSet": "function",
		  "atob": "function",
		  "btoa": "function",
		  "decodeURI": "function",
		  "decodeURIComponent": "function",
		  "encodeURI": "function",
		  "encodeURIComponent": "function",
		  "escape": "function",
		  "eval": "function",
		  "globalThis": "object",
		  "isFinite": "function",
		  "isNaN": "function",
		  "parseFloat": "function",
		  "parseInt": "function",
		  "store": "object",
		  "tool": "function",
		  "undefined": "undefined",
		  "unescape": "function",
		}
	`);
});

test('dynamic import is not available in sandbox', async () => {
	const sandbox = await createSandbox({tools: []});
	const result = await sandbox.execute.handler({code: 'return import("foo")'});
	expect(result.success).toBe(false);
});

test('atob decodes base64', async () => {
	const sandbox = await createSandbox({tools: []});
	const result = await sandbox.execute.handler({code: 'return atob("SGVsbG8gV29ybGQ=")'});
	expect(result).toEqual({success: true, blobs: [], result: 'Hello World'});
});

test('btoa encodes to base64', async () => {
	const sandbox = await createSandbox({tools: []});
	const result = await sandbox.execute.handler({code: 'return btoa("Hello World")'});
	expect(result).toEqual({success: true, blobs: [], result: 'SGVsbG8gV29ybGQ='});
});

test('atob and btoa roundtrip', async () => {
	const sandbox = await createSandbox({tools: []});
	const result = await sandbox.execute.handler({code: 'return atob(btoa("test string 123"))'});
	expect(result).toEqual({success: true, blobs: [], result: 'test string 123'});
});

test('sandbox.store can be set from host', async () => {
	const sandbox = await createSandbox({tools: []});

	sandbox.store = {preset: 'adam'};
	const result = await sandbox.execute.handler({code: 'return store.preset'});

	expect(result).toEqual({success: true, blobs: [], result: 'adam'});
});

test('blob extraction works for image content', async () => {
	const imageTool: Tool = {
		name: 'screenshot',
		description: 'Returns a fake image',
		inputSchema: {type: 'object'},
		async handler() {
			return {type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ', mimeType: 'image/png'};
		},
	};

	const sandbox = await createSandbox({tools: [imageTool]});
	const result = await sandbox.execute.handler({
		code: 'return await tool(\'screenshot\', {})',
	});

	expect(result.success).toBe(true);
	// Result should have the ref, not the full data
	const ref = result.result as {type: string; id: string; mimeType: string};
	expect(ref.type).toBe('blob_ref');
	expect(ref.id).toMatch(/^blob_[a-z0-9]{6}$/);
	expect(ref.mimeType).toBe('image/png');
	// Blob should be extracted
	expect(result.blobs).toHaveLength(1);
	expect(result.blobs[0].id).toBe(ref.id);
	expect(result.blobs[0].data).toBe('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ');
	expect(result.blobs[0].mimeType).toBe('image/png');
});

test('get_blob tool retrieves extracted blob data', async () => {
	const imageTool: Tool = {
		name: 'screenshot',
		description: 'Returns a fake image',
		inputSchema: {type: 'object'},
		async handler() {
			return {type: 'image', data: 'base64data1234567890abcdef', mimeType: 'image/jpeg'};
		},
	};

	const sandbox = await createSandbox({tools: [imageTool]});
	const result = await sandbox.execute.handler({
		code: `
			const ref = await tool('screenshot', {});
			const blob = await tool('get_blob', {id: ref.id});
			return {ref, blob};
		`,
	});

	expect(result.success).toBe(true);
	const res = result.result as {ref: {id: string}; blob: {id: string; data: string; mimeType: string}};
	expect(res.ref.id).toMatch(/^blob_[a-z0-9]{6}$/);
	expect(res.blob.data).toBe('base64data1234567890abcdef');
	expect(res.blob.mimeType).toBe('image/jpeg');
});

test('get_blob returns error for unknown id', async () => {
	const sandbox = await createSandbox({tools: []});
	const result = await sandbox.execute.handler({
		code: 'return await tool(\'get_blob\', {id: \'nonexistent\'})',
	});

	expect(result.success).toBe(true);
	expect((result.result as {error: string}).error).toBe('Blob not found: nonexistent');
});

test('multiple blobs are extracted from nested results', async () => {
	const imageTool: Tool = {
		name: 'screenshot',
		description: 'Returns a fake image',
		inputSchema: {type: 'object'},
		async handler() {
			return [{type: 'text', text: 'dimensions'}, {type: 'image', data: 'imagedatabase64encodedstring', mimeType: 'image/png'}];
		},
	};

	const sandbox = await createSandbox({tools: [imageTool]});
	const result = await sandbox.execute.handler({
		code: `
			const ss1 = await tool('screenshot', {});
			const ss2 = await tool('screenshot', {});
			return {screenshots: [ss1, ss2]};
		`,
	});

	expect(result.success).toBe(true);
	expect(result.blobs).toHaveLength(2);
	expect(result.blobs[0].id).toMatch(/^blob_[a-z0-9]{6}$/);
	expect(result.blobs[1].id).toMatch(/^blob_[a-z0-9]{6}$/);
	// IDs should be unique
	expect(result.blobs[0].id).not.toBe(result.blobs[1].id);
});

test('blob extraction works for audio content', async () => {
	const audioTool: Tool = {
		name: 'record',
		description: 'Returns fake audio',
		inputSchema: {type: 'object'},
		async handler() {
			return {type: 'audio', data: 'UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAA', mimeType: 'audio/wav'};
		},
	};

	const sandbox = await createSandbox({tools: [audioTool]});
	const result = await sandbox.execute.handler({
		code: 'return await tool(\'record\', {})',
	});

	expect(result.success).toBe(true);
	const ref = result.result as {type: string; id: string; mimeType: string};
	expect(ref.type).toBe('blob_ref');
	expect(ref.id).toMatch(/^blob_[a-z0-9]{6}$/);
	expect(ref.mimeType).toBe('audio/wav');
	expect(result.blobs).toHaveLength(1);
	expect(result.blobs[0].data).toBe('UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAA');
	expect(result.blobs[0].mimeType).toBe('audio/wav');
});

test('blob extraction works for resource blobs (PDFs)', async () => {
	const pdfTool: Tool = {
		name: 'export_pdf',
		description: 'Returns a fake PDF',
		inputSchema: {type: 'object'},
		async handler() {
			return {blob: 'JVBERi0xLjQKJeLjz9MKMSAwIG9iag', mimeType: 'application/pdf'};
		},
	};

	const sandbox = await createSandbox({tools: [pdfTool]});
	const result = await sandbox.execute.handler({
		code: 'return await tool(\'export_pdf\', {})',
	});

	expect(result.success).toBe(true);
	const ref = result.result as {type: string; id: string; mimeType: string};
	expect(ref.type).toBe('blob_ref');
	expect(ref.id).toMatch(/^blob_[a-z0-9]{6}$/);
	expect(ref.mimeType).toBe('application/pdf');
	expect(result.blobs).toHaveLength(1);
	expect(result.blobs[0].data).toBe('JVBERi0xLjQKJeLjz9MKMSAwIG9iag');
	expect(result.blobs[0].mimeType).toBe('application/pdf');
});

test('Promise.race with tool calls works correctly', async () => {
	// This tests that abandoned tool calls from Promise.race don't cause errors
	const sandbox = await createSandbox({tools: []});

	// Race a fast sleep against a slow sleep - fast one should win
	const result = await sandbox.execute.handler({
		code: `
			const result = await Promise.race([
				tool('sleep', {ms: 50}).then(() => 'fast'),
				tool('sleep', {ms: 200}).then(() => 'slow')
			]);
			return result;
		`,
	});

	expect(result.success).toBe(true);
	expect(result.result).toBe('fast');
});

test('Promise.race with tool calls - abandoned promise resolves after main', async () => {
	// More explicit test: the slow tool should still complete without error
	// even though the main promise has already resolved
	let slowCallCompleted = false;

	const slowTool: Tool = {
		name: 'slow_tool',
		description: 'A slow tool for testing',
		inputSchema: {type: 'object', properties: {}},
		async handler() {
			await new Promise((resolve) => setTimeout(resolve, 150));
			slowCallCompleted = true;
			return {done: true};
		},
	};

	const fastTool: Tool = {
		name: 'fast_tool',
		description: 'A fast tool for testing',
		inputSchema: {type: 'object', properties: {}},
		async handler() {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return {done: true};
		},
	};

	const sandbox = await createSandbox({tools: [slowTool, fastTool]});

	const result = await sandbox.execute.handler({
		code: `
			const result = await Promise.race([
				tool('fast_tool', {}).then(() => 'fast'),
				tool('slow_tool', {}).then(() => 'slow')
			]);
			return result;
		`,
	});

	expect(result.success).toBe(true);
	expect(result.result).toBe('fast');

	// Wait for slow tool to complete
	await new Promise((resolve) => setTimeout(resolve, 200));
	expect(slowCallCompleted).toBe(true);
});

test('Promise.race with very slow abandoned tool does not block forever', async () => {
	// If a tool takes a very long time and gets abandoned via Promise.race,
	// we should not wait forever for it to complete
	const sandbox = await createSandbox({tools: []});

	const start = Date.now();
	const result = await sandbox.execute.handler({
		code: `
			const result = await Promise.race([
				tool('sleep', {ms: 10}).then(() => 'fast'),
				tool('sleep', {ms: 50000}).then(() => 'very slow')  // 50 seconds!
			]);
			return result;
		`,
	});
	const elapsed = Date.now() - start;

	expect(result.success).toBe(true);
	expect(result.result).toBe('fast');
	// Should complete in well under 50 seconds - the 1 second cleanup timeout + overhead
	expect(elapsed).toBeLessThan(3000);
});

test('Promise.race abandoned promise .then() callbacks do NOT affect store', async () => {
	// When main promise fulfills, we stop running callbacks for abandoned promises
	// This prevents side effects from Promise.race losers
	const sandbox = await createSandbox({tools: []});

	const result = await sandbox.execute.handler({
		code: `
			store.modified = false;
			const result = await Promise.race([
				tool('sleep', {ms: 10}).then(() => 'fast'),
				tool('sleep', {ms: 100}).then(() => { store.modified = true; return 'slow'; })
			]);
			return result;
		`,
	});

	expect(result.success).toBe(true);
	expect(result.result).toBe('fast');
	// The slow promise's .then() should NOT have run - we exited before it completed
	expect(sandbox.store.modified).toBe(false);
});
