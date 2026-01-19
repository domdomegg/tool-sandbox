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

// Lazy-loaded QuickJS instance
let quickJS: Awaited<ReturnType<typeof getQuickJS>> | null = null;

/** Maximum result size in characters before truncation */
const MAX_RESULT_CHARS = 40000;

/** Maximum execution time (~50 seconds) */
const MAX_POLL_ITERATIONS = 500;

/** Generate the execute tool description */
function generateExecuteDescription(toolNames: string[]): string {
	return `Run JavaScript in a sandboxed environment.

## Available APIs

- \`tool(name, args)\` - Call a tool and await its result
- \`console.log(...)\` - Debug output
- \`store\` - Persistent object that survives across executions
- \`store._prev\` - Read-only result from previous execution

Note: \`tool('describe', { name: 'toolName' })\` returns a tool's schema.

## Available tools

${toolNames.join(', ')}

## Patterns

### Sequential tool calls
\`\`\`javascript
const users = await tool('api__getUsers', {});
const enriched = await Promise.all(
  users.map(u => tool('api__enrich', { id: u.id }))
);
return enriched;
\`\`\`

### Storing intermediate results
\`\`\`javascript
store.users = await tool('api__getUsers', {});
return store.users.length;
\`\`\`

### Error handling
\`\`\`javascript
try {
  return await tool('api__riskyCall', {});
} catch (err) {
  return { error: err.message, fallback: 'default' };
}
\`\`\`

## Limitations

- No \`fetch\`, \`require\`, \`import\` (use tools instead)
- No \`setTimeout\`/\`setInterval\`
- Results over 40KB are truncated
- Execution times out after ~50 seconds`;
}

/** Create a sandbox instance */
export async function createSandbox(options: SandboxOptions): Promise<Sandbox> {
	const tools = [...options.tools];
	let store: Record<string, unknown> = {};
	let prevResult: unknown;

	// Add built-in describe tool
	const describeTool: Tool = {
		name: 'describe',
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
				console.log('[sandbox]', ...strings);
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
					const startTime = Date.now();
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
						const duration = Date.now() - startTime;
						const successEvent: ToolCallSuccessEvent = {
							toolName,
							args,
							result: beforeEvent.returnValue,
							duration,
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
						const duration = Date.now() - startTime;

						const successEvent: ToolCallSuccessEvent = {
							toolName, args, result, duration,
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
						const duration = Date.now() - startTime;
						const error = err instanceof Error ? err : new Error(String(err));

						const errorEvent: ToolCallErrorEvent = {
							toolName, args, error, duration,
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

				if (pollIterations >= MAX_POLL_ITERATIONS) {
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
				if (resultStr.length > MAX_RESULT_CHARS) {
					return {
						success: true,
						result: value,
						error: `Result truncated (${resultStr.length} > ${MAX_RESULT_CHARS} chars)`,
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
	const executeTool: Tool = {
		name: 'execute',
		description: generateExecuteDescription(tools.map((t) => t.name)),
		inputSchema: {
			type: 'object',
			properties: {code: {type: 'string', description: 'JavaScript code to execute'}},
			required: ['code'],
		},
		async handler(args) {
			const {code} = args as {code: string};
			return executeCode(code);
		},
	};

	const sandbox: Sandbox = {
		get tools() {
			return tools;
		},
		store,
		execute: executeTool,
		addTool(tool: Tool) {
			tools.push(tool);
			// Update execute tool description
			executeTool.description = generateExecuteDescription(tools.map((t) => t.name));
		},
		removeTool(name: string) {
			const index = tools.findIndex((t) => t.name === name);
			if (index !== -1) {
				tools.splice(index, 1);
				executeTool.description = generateExecuteDescription(tools.map((t) => t.name));
			}
		},
	};

	return sandbox;
}
