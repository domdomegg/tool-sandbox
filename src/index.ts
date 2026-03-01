import {getQuickJS} from 'quickjs-emscripten';
import type {
	Tool,
	SandboxOptions,
	Sandbox,
	ExecuteResult,
	BeforeToolCallEvent,
	ToolCallSuccessEvent,
	ToolCallErrorEvent,
	Blob,
} from './types.js';

export type {
	Tool,
	SandboxOptions,
	Sandbox,
	ExecuteResult,
	BeforeToolCallEvent,
	ToolCallSuccessEvent,
	ToolCallErrorEvent,
	Blob,
} from './types.js';

export {fromMcpClients, type McpClients} from './mcp.js';

// Lazy-loaded QuickJS instance
let quickJS: Awaited<ReturnType<typeof getQuickJS>> | null = null;

/** Generate a short random ID for blobs (e.g., 'blob_k7m2x9') */
function generateBlobId(): string {
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	let suffix = '';
	for (let i = 0; i < 6; i++) {
		suffix += chars[Math.floor(Math.random() * chars.length)];
	}

	return `blob_${suffix}`;
}

/** Extract blobs from a value, replacing them with refs */
function extractBlobs(
	value: unknown,
	blobStore: Map<string, Blob>,
): unknown {
	if (typeof value === 'object' && value !== null) {
		const v = value as Record<string, unknown>;

		// MCP image/audio content: {type: 'image'|'audio', data: string, mimeType: string}
		if ((v.type === 'image' || v.type === 'audio') && typeof v.data === 'string' && typeof v.mimeType === 'string') {
			const id = generateBlobId();
			const blob: Blob = {id, data: v.data, mimeType: v.mimeType};
			blobStore.set(id, blob);
			return {type: 'blob_ref', id, mimeType: v.mimeType};
		}

		// MCP resource blob (PDFs, etc.): {blob: string, mimeType: string}
		if (typeof v.blob === 'string' && typeof v.mimeType === 'string') {
			const id = generateBlobId();
			const blob: Blob = {id, data: v.blob, mimeType: v.mimeType};
			blobStore.set(id, blob);
			return {type: 'blob_ref', id, mimeType: v.mimeType};
		}

		// Recurse into arrays and objects
		if (Array.isArray(value)) {
			return value.map((item) => extractBlobs(item, blobStore));
		}

		const result: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(v)) {
			result[k] = extractBlobs(val, blobStore);
		}

		return result;
	}

	return value;
}

/** Default maximum result size in characters before truncation */
const DEFAULT_maxResultChars = 40000;

/** Default maximum execution time (~50 seconds) */
const DEFAULT_MAX_POLL_ITERATIONS = 500;

/** Add helpful hints to common error messages */
function augmentErrorMessage(errorStr: string): string {
	// setTimeout/setInterval not available - suggest sleep tool
	if (errorStr.includes("'setTimeout' is not defined") || errorStr.includes("'setInterval' is not defined")) {
		return `${errorStr}. Hint: Use await tool('sleep', {ms: N}) for delays.`;
	}

	return errorStr;
}

/** Generate the execute tool description */
function generateExecuteDescription(toolNames: string[]): string {
	return `Run JavaScript in a sandboxed environment.

Available: tool(name, args), store (persistent), store._prev (last result), atob/btoa, and standard JS built-ins (JSON, Math, Date, Promise, etc.). No logs are captured — use return to pass data back.

Binary data (images, audio, PDFs) from tools is automatically extracted. Tool results containing these will have the data replaced with refs like {type: 'blob_ref', id: 'blob_k7m2x9', mimeType: 'image/png'}. The actual content is returned separately. If you need the raw base64 data (e.g., to crop, resize, or pass to another tool), use tool('get_blob', {id}) which returns {id, data, mimeType}. Note: blobs are only available within the same execution - save to store if needed later.

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
	const blobStore = new Map<string, Blob>();

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

	// Add built-in get_blob tool
	const getBlobTool: Tool = {
		name: 'get_blob',
		description: 'Get raw blob data by ID. Use this to access base64 data for images/audio/PDFs that were extracted from tool results. Blobs are only available within the current execution - save to store if needed across executions.',
		inputSchema: {type: 'object', properties: {id: {type: 'string'}}, required: ['id']},
		async handler(args) {
			const {id} = args as {id: string};
			const blob = blobStore.get(id);
			if (!blob) {
				return {error: `Blob not found: ${id}`};
			}

			return blob;
		},
	};
	tools.push(getBlobTool);

	// Execute code in the sandbox
	async function executeCode(code: string): Promise<ExecuteResult> {
		quickJS ||= await getQuickJS();

		const vm = quickJS.newContext();
		const pendingPromises: Promise<void>[] = [];
		let vmDisposed = false; // Track if VM has been disposed to prevent operations on disposed VM
		let mainPromiseFulfilled = false; // Track when main promise is done - interrupt further execution
		// Track pending QuickJS promises so we can force-resolve them before VM disposal
		// This is needed for Promise.race scenarios where abandoned promises would otherwise leak
		const pendingQjsPromises: Array<{promise: ReturnType<typeof vm.newPromise>; settled: boolean}> = [];
		// Mutable ref to main promise handle - used by resolve callbacks to check if main promise is done
		const mainPromiseRef: {handle: ReturnType<typeof vm.newPromise>['handle'] | null} = {handle: null};

		// Set up interrupt handler to stop execution after main promise fulfills
		// This prevents abandoned Promise.race callbacks from running
		vm.runtime.setInterruptHandler(() => mainPromiseFulfilled);

		// Helper to check main promise state and set flag if it's done
		// Called after each executePendingJobs to detect when Promise.race resolves
		const checkMainPromiseDone = () => {
			if (mainPromiseFulfilled || !mainPromiseRef.handle) return;
			const state = vm.getPromiseState(mainPromiseRef.handle);
			if (state.type !== 'pending') {
				mainPromiseFulfilled = true;
			}
		};

		// Clear blob store for this execution
		blobStore.clear();

		try {
			// Add atob/btoa for base64 encoding/decoding
			const atobFn = vm.newFunction('atob', (strHandle) => {
				const str = vm.getString(strHandle);
				return vm.newString(Buffer.from(str, 'base64').toString('utf8'));
			});
			vm.setProp(vm.global, 'atob', atobFn);
			atobFn.dispose();

			const btoaFn = vm.newFunction('btoa', (strHandle) => {
				const str = vm.getString(strHandle);
				return vm.newString(Buffer.from(str, 'utf8').toString('base64'));
			});
			vm.setProp(vm.global, 'btoa', btoaFn);
			btoaFn.dispose();

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
				const promiseEntry = {promise, settled: false};
				pendingQjsPromises.push(promiseEntry);

				const asyncWork = (async () => {
					const tool = tools.find((t) => t.name === toolName);

					if (!tool) {
						resolveQueue = resolveQueue.then(() => {
							if (vmDisposed || mainPromiseFulfilled) return; // Skip if main promise done or VM disposed
							const errHandle = vm.newError(`Tool not found: ${toolName}`);
							promise.reject(errHandle);
							errHandle.dispose();
							promiseEntry.settled = true;
							vm.runtime.executePendingJobs();
							checkMainPromiseDone();
						});
						return;
					}

					// Before tool call event
					const beforeEvent: BeforeToolCallEvent = {toolName, args};
					try {
						options.onBeforeToolCall?.(beforeEvent);
					} catch (err) {
						resolveQueue = resolveQueue.then(() => {
							if (vmDisposed || mainPromiseFulfilled) return; // Skip if main promise done or VM disposed
							const errHandle = vm.newError(err instanceof Error ? err.message : String(err));
							promise.reject(errHandle);
							errHandle.dispose();
							promiseEntry.settled = true;
							vm.runtime.executePendingJobs();
							checkMainPromiseDone();
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

						// Extract blobs from result before passing to VM
						const transformedResult = extractBlobs(successEvent.result, blobStore);

						resolveQueue = resolveQueue.then(() => {
							if (vmDisposed || mainPromiseFulfilled) return; // Skip if main promise done or VM disposed
							const jsonStr = JSON.stringify(transformedResult);
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

							promiseEntry.settled = true;
							vm.runtime.executePendingJobs();
							checkMainPromiseDone();
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

						// Extract blobs from result before passing to VM
						const transformedResult = extractBlobs(successEvent.result, blobStore);

						resolveQueue = resolveQueue.then(() => {
							if (vmDisposed || mainPromiseFulfilled) return; // Skip if main promise done or VM disposed
							const jsonStr = JSON.stringify(transformedResult);
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

							promiseEntry.settled = true;
							vm.runtime.executePendingJobs();
							checkMainPromiseDone();
						});
					} catch (err) {
						const error = err instanceof Error ? err : new Error(String(err));

						const errorEvent: ToolCallErrorEvent = {
							toolName, args, error,
						};
						options.onToolCallError?.(errorEvent);

						// Check if result was set (recovery)
						if ('result' in errorEvent) {
							// Extract blobs from recovered result before passing to VM
							const transformedResult = extractBlobs(errorEvent.result, blobStore);

							resolveQueue = resolveQueue.then(() => {
								if (vmDisposed || mainPromiseFulfilled) return; // Skip if main promise done or VM disposed
								const jsonStr = JSON.stringify(transformedResult);
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

								promiseEntry.settled = true;
								vm.runtime.executePendingJobs();
								checkMainPromiseDone();
							});
						} else {
							resolveQueue = resolveQueue.then(() => {
								if (vmDisposed || mainPromiseFulfilled) return; // Skip if main promise done or VM disposed
								const errHandle = vm.newError(error.message);
								promise.reject(errHandle);
								errHandle.dispose();
								promiseEntry.settled = true;
								vm.runtime.executePendingJobs();
								checkMainPromiseDone();
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
				return {success: false, error: augmentErrorMessage(errorStr), blobs: Array.from(blobStore.values())};
			}

			// Poll until promise resolves
			const promiseHandle = result.value;
			mainPromiseRef.handle = promiseHandle;
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
					return {success: false, error: 'Execution timed out', blobs: Array.from(blobStore.values())};
				}
			}

			if (promiseState.type === 'fulfilled') {
				// Signal interrupt handler to stop any further execution (abandoned Promise.race callbacks)
				mainPromiseFulfilled = true;
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
						blobs: Array.from(blobStore.values()),
					};
				}

				return {success: true, result: value, blobs: Array.from(blobStore.values())};
			}

			if (promiseState.type === 'rejected') {
				// Signal interrupt handler to stop any further execution (abandoned Promise.race callbacks)
				mainPromiseFulfilled = true;
				const error = vm.dump(promiseState.error);
				promiseState.error.dispose();
				promiseHandle.dispose();
				storeHandle.dispose();
				const errorStr = typeof error === 'object' && error !== null
					? (error as {message?: string}).message || JSON.stringify(error)
					: String(error);
				return {success: false, error: augmentErrorMessage(errorStr), blobs: Array.from(blobStore.values())};
			}

			promiseHandle.dispose();
			storeHandle.dispose();
			return {success: false, error: 'Promise did not resolve', blobs: Array.from(blobStore.values())};
		} finally {
			// Mark VM as disposed so any late callbacks skip their resolution
			vmDisposed = true;

			// Just dispose - don't bother settling promises
			// QuickJS may complain but let's see if it actually breaks anything
			try {
				vm.dispose();
			} catch (e) {
				// Ignore disposal errors - VM is done anyway
				console.warn('[tool-sandbox] VM disposal warning:', e);
			}
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
				blobs: {type: 'array', description: 'Extracted binary blobs (images, etc.)'},
			},
			required: ['success', 'blobs'],
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
