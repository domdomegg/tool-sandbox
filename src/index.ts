import {getQuickJS} from 'quickjs-emscripten';
import type {
	Tool,
	SandboxOptions,
	Sandbox,
	ExecuteResult,
	BeforeToolCallEvent,
	ToolCallSuccessEvent,
	ToolCallErrorEvent,
} from './types.js';

export type {
	Tool,
	SandboxOptions,
	Sandbox,
	ExecuteResult,
	BeforeToolCallEvent,
	ToolCallSuccessEvent,
	ToolCallErrorEvent,
} from './types.js';

export {fromMcpClients, type McpClients} from './mcp.js';

// Lazy-loaded QuickJS instance
let quickJS: Awaited<ReturnType<typeof getQuickJS>> | null = null;

/** Default maximum result size in characters before truncation */
const DEFAULT_maxResultChars = 40000;

/** Default maximum execution time (~50 seconds) */
const DEFAULT_MAX_POLL_ITERATIONS = 500;

/** Generate the execute tool description */
function generateExecuteDescription(toolNames: string[]): string {
	return `Run JavaScript in a sandboxed environment.

Available: tool(name, args), console.log(), store (persistent), store._prev (last result)

IMPORTANT: Call tool('describe_tool', {name}) to get a tool's schema before using it. Do not guess schemas.

Available tools: ${toolNames.join(', ')}

Example (placeholder tool names - use describe_tool for actual schemas):

USER: What's on my on-call calendars in the next 24 hours?

// Execution 1: Get schema first
return await tool('describe_tool', {name: 'calendar__list'});

// Execution 2: Fetch calendars, filter, get events, store and return count
const calendars = await tool('calendar__list', {});
const eventArrays = await Promise.all(calendars.map(cal =>
  tool('calendar__events', {calendarId: cal.id, timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + 86400000).toISOString()})
));
store.events = eventArrays.flat();
return {count: store.events.length};

USER: Which of those are standups?

// Execution 3: Work with stored events, return summary
const standups = store.events.filter(e => e.title.includes('standup'));
return {count: standups.length, titles: standups.map(e => e.title)};

USER: Any of those for tool-sandbox?

// Execution 4: Filter previous result
return store._prev.titles.filter(t => t.includes('tool-sandbox'));

Style: Keep code short and simple. No comments or error handling needed. Return summaries rather than large objects.

Limitations: No fetch/require/import/setTimeout/setInterval (use tools instead).`;
}

/** Create a sandbox instance */
export async function createSandbox(options: SandboxOptions): Promise<Sandbox> {
	const tools = [...options.tools];
	const maxResultChars = options.experimental_maxResultChars ?? DEFAULT_maxResultChars;
	const maxPollIterations = options.experimental_maxPollIterations ?? DEFAULT_MAX_POLL_ITERATIONS;
	let store: Record<string, unknown> = {};
	let prevResult: unknown;

	// Validate no duplicate tool names
	const names = new Set<string>();
	for (const tool of tools) {
		if (names.has(tool.name)) {
			throw new Error(`Duplicate tool name: ${tool.name}`);
		}

		names.add(tool.name);
	}

	// Add built-in describe tool
	const describeTool: Tool = {
		name: 'describe_tool',
		description: 'Get a tool\'s schema by name',
		inputSchema: {
			type: 'object',
			properties: {name: {type: 'string'}},
			required: ['name'],
		},
		async handler(args) {
			const {name} = args as {name: string};
			const tool = tools.find((t) => t.name === name);
			if (!tool) {
				return {error: `Tool not found: ${name}`};
			}

			return {
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
				outputSchema: tool.outputSchema,
			};
		},
	};
	tools.push(describeTool);

	// Add built-in list_tools tool
	const listToolsTool: Tool = {
		name: 'list_tools',
		description: 'List all available tools',
		inputSchema: {type: 'object', properties: {}},
		async handler() {
			return tools.map((t) => ({name: t.name, description: t.description}));
		},
	};
	tools.push(listToolsTool);

	// Add built-in sleep tool
	const sleepTool: Tool = {
		name: 'sleep',
		description: 'Wait for the specified number of milliseconds',
		inputSchema: {type: 'object', properties: {ms: {type: 'number'}}, required: ['ms']},
		async handler(args) {
			const {ms} = args as {ms: number};
			await new Promise((resolve) => {
				setTimeout(resolve, ms);
			});
			return {slept: ms};
		},
	};
	tools.push(sleepTool);

	// Execute code in the sandbox
	async function executeCode(code: string): Promise<ExecuteResult> {
		quickJS ||= await getQuickJS();

		const vm = quickJS.newContext();
		const pendingPromises: Promise<void>[] = [];

		try {
			// Add console.log
			const consoleObj = vm.newObject();
			const logFn = vm.newFunction('log', (...args) => {
				const strings = args.map((h) => {
					const val = vm.dump(h);
					return typeof val === 'string' ? val : JSON.stringify(val);
				});
				console.log('[tool-sandbox]', ...strings);
			});
			vm.setProp(consoleObj, 'log', logFn);
			vm.setProp(vm.global, 'console', consoleObj);
			logFn.dispose();
			consoleObj.dispose();

			// Initialize store with _prev as read-only
			const prevJson = JSON.stringify(prevResult ?? null);
			const storeJson = JSON.stringify(store);
			const storeInitCode = `
        globalThis.store = ${storeJson};
        Object.defineProperty(globalThis.store, '_prev', {
          value: ${prevJson},
          writable: false,
          configurable: false,
          enumerable: true
        });
        globalThis.store;
      `;
			const storeResult = vm.evalCode(storeInitCode);
			if (storeResult.error) {
				storeResult.error.dispose();
				throw new Error('Failed to initialize store');
			}

			const storeHandle = storeResult.value;

			// Queue for serializing promise resolutions
			let resolveQueue: Promise<void> = Promise.resolve();

			// Add tool() function
			const toolFn = vm.newFunction('tool', (toolNameHandle, argsHandle) => {
				const toolName = vm.getString(toolNameHandle);
				const argsValue = vm.dump(argsHandle);
				const args = typeof argsValue === 'string'
					? JSON.parse(argsValue) as Record<string, unknown>
					: (argsValue as Record<string, unknown>) ?? {};

				const promise = vm.newPromise();

				const asyncWork = (async () => {
					const tool = tools.find((t) => t.name === toolName);

					if (!tool) {
						resolveQueue = resolveQueue.then(() => {
							const errHandle = vm.newError(`Tool not found: ${toolName}`);
							promise.reject(errHandle);
							errHandle.dispose();
							vm.runtime.executePendingJobs();
						});
						return;
					}

					// Before tool call event
					const beforeEvent: BeforeToolCallEvent = {toolName, args};
					try {
						options.onBeforeToolCall?.(beforeEvent);
					} catch (err) {
						resolveQueue = resolveQueue.then(() => {
							const errHandle = vm.newError(err instanceof Error ? err.message : String(err));
							promise.reject(errHandle);
							errHandle.dispose();
							vm.runtime.executePendingJobs();
						});
						return;
					}

					// Check if returnValue was set
					if ('returnValue' in beforeEvent) {
						const successEvent: ToolCallSuccessEvent = {
							toolName,
							args,
							result: beforeEvent.returnValue,
						};
						options.onToolCallSuccess?.(successEvent);

						resolveQueue = resolveQueue.then(() => {
							const jsonStr = JSON.stringify(successEvent.result);
							const resultHandle = vm.evalCode(`(${jsonStr})`);
							if (resultHandle.error) {
								const str = vm.newString(jsonStr);
								promise.resolve(str);
								str.dispose();
								resultHandle.error.dispose();
							} else {
								promise.resolve(resultHandle.value);
								resultHandle.value.dispose();
							}

							vm.runtime.executePendingJobs();
						});
						return;
					}

					// Call the tool with potentially modified args
					try {
						const result = await tool.handler(beforeEvent.args);

						const successEvent: ToolCallSuccessEvent = {
							toolName, args, result,
						};
						options.onToolCallSuccess?.(successEvent);

						resolveQueue = resolveQueue.then(() => {
							const jsonStr = JSON.stringify(successEvent.result);
							const resultHandle = vm.evalCode(`(${jsonStr})`);
							if (resultHandle.error) {
								const str = vm.newString(jsonStr);
								promise.resolve(str);
								str.dispose();
								resultHandle.error.dispose();
							} else {
								promise.resolve(resultHandle.value);
								resultHandle.value.dispose();
							}

							vm.runtime.executePendingJobs();
						});
					} catch (err) {
						const error = err instanceof Error ? err : new Error(String(err));

						const errorEvent: ToolCallErrorEvent = {
							toolName, args, error,
						};
						options.onToolCallError?.(errorEvent);

						// Check if result was set (recovery)
						if ('result' in errorEvent) {
							resolveQueue = resolveQueue.then(() => {
								const jsonStr = JSON.stringify(errorEvent.result);
								const resultHandle = vm.evalCode(`(${jsonStr})`);
								if (resultHandle.error) {
									const str = vm.newString(jsonStr);
									promise.resolve(str);
									str.dispose();
									resultHandle.error.dispose();
								} else {
									promise.resolve(resultHandle.value);
									resultHandle.value.dispose();
								}

								vm.runtime.executePendingJobs();
							});
						} else {
							resolveQueue = resolveQueue.then(() => {
								const errHandle = vm.newError(error.message);
								promise.reject(errHandle);
								errHandle.dispose();
								vm.runtime.executePendingJobs();
							});
						}
					}
				})();

				pendingPromises.push(asyncWork.then(async () => resolveQueue));
				return promise.handle;
			});
			vm.setProp(vm.global, 'tool', toolFn);
			toolFn.dispose();

			// Wrap code in async IIFE
			const wrappedCode = `(async () => { ${code} })()`;
			const result = vm.evalCode(wrappedCode);

			if (result.error) {
				const error = vm.dump(result.error);
				result.error.dispose();
				storeHandle.dispose();
				const errorStr = typeof error === 'object' && error !== null
					? (error as {message?: string}).message || JSON.stringify(error)
					: String(error);
				return {success: false, error: errorStr};
			}

			// Poll until promise resolves
			const promiseHandle = result.value;
			let promiseState = vm.getPromiseState(promiseHandle);
			let pollIterations = 0;

			const sleep = async (ms: number) => new Promise<void>((resolve) => {
				setTimeout(resolve, ms);
			});

			while (promiseState.type === 'pending') {
				if (pendingPromises.length > 0) {
					// eslint-disable-next-line no-await-in-loop -- Intentional polling
					await Promise.race([Promise.all(pendingPromises), sleep(100)]);
				} else {
					// eslint-disable-next-line no-await-in-loop -- Intentional polling
					await sleep(10);
				}

				vm.runtime.executePendingJobs();
				promiseState = vm.getPromiseState(promiseHandle);
				pollIterations += 1;

				if (pollIterations >= maxPollIterations) {
					promiseHandle.dispose();
					storeHandle.dispose();
					return {success: false, error: 'Execution timed out'};
				}
			}

			if (promiseState.type === 'fulfilled') {
				const value = vm.dump(promiseState.value);
				promiseState.value.dispose();
				promiseHandle.dispose();

				// Read back store
				const updatedStore = vm.dump(storeHandle) as Record<string, unknown>;
				storeHandle.dispose();
				delete updatedStore._prev;
				store = updatedStore;
				prevResult = value;

				// Truncate if needed
				const resultStr = JSON.stringify(value) ?? '';
				if (resultStr.length > maxResultChars) {
					return {
						success: true,
						result: value,
						error: `Result truncated (${resultStr.length} > ${maxResultChars} chars)`,
					};
				}

				return {success: true, result: value};
			}

			if (promiseState.type === 'rejected') {
				const error = vm.dump(promiseState.error);
				promiseState.error.dispose();
				promiseHandle.dispose();
				storeHandle.dispose();
				const errorStr = typeof error === 'object' && error !== null
					? (error as {message?: string}).message || JSON.stringify(error)
					: String(error);
				return {success: false, error: errorStr};
			}

			promiseHandle.dispose();
			storeHandle.dispose();
			return {success: false, error: 'Promise did not resolve'};
		} finally {
			vm.dispose();
		}
	}

	// Create execute tool
	const executeTool: Sandbox['execute'] = {
		name: 'execute',
		description: generateExecuteDescription(tools.map((t) => t.name)),
		inputSchema: {
			type: 'object',
			properties: {code: {type: 'string', description: 'JavaScript code to execute'}},
			required: ['code'],
		},
		outputSchema: {
			type: 'object',
			properties: {
				success: {type: 'boolean'},
				result: {description: 'Return value from the executed code'},
				error: {type: 'string', description: 'Error message if execution failed'},
			},
			required: ['success'],
		},
		async handler(args) {
			const {code} = args as {code: string};
			return executeCode(code);
		},
	};

	const sandbox: Sandbox = {
		tools,
		get store() {
			return store;
		},
		set store(value) {
			store = value;
		},
		execute: executeTool,
		addTool(tool: Tool) {
			if (tools.some((t) => t.name === tool.name)) {
				throw new Error(`Duplicate tool name: ${tool.name}`);
			}

			tools.push(tool);
			executeTool.description = generateExecuteDescription(tools.map((t) => t.name));
		},
		removeTool(name: string) {
			const index = tools.findIndex((t) => t.name === name);
			if (index === -1) {
				throw new Error(`Tool not found: ${name}`);
			}

			tools.splice(index, 1);
			executeTool.description = generateExecuteDescription(tools.map((t) => t.name));
		},
	};

	return sandbox;
}
