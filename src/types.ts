/** JSON Schema for tool input/output */
export type JsonSchema = {
	/** Allow additional JSON Schema fields (additionalProperties, $schema, etc.) */
	[key: string]: unknown;
	type: 'object';
	properties?: Record<string, unknown>;
	required?: string[];
};

/** Tool definition - matches MCP SDK Tool interface with handler */
export type Tool = {
	/** Allow additional fields (annotations, etc.) */
	[key: string]: unknown;
	name: string;
	title?: string;
	description?: string;
	inputSchema: JsonSchema;
	outputSchema?: JsonSchema;
	handler: (args: unknown) => Promise<unknown>;
};

/** Event fired before a tool is called */
export type BeforeToolCallEvent = {
	toolName: string;
	args: unknown;
	/** Mutable - set to skip the tool call and return this value instead */
	returnValue?: unknown;
};

/** Event fired after a successful tool call */
export type ToolCallSuccessEvent = {
	toolName: string;
	args: unknown;
	/** Mutable - modify to change the result */
	result: unknown;
};

/** Event fired after a failed tool call */
export type ToolCallErrorEvent = {
	toolName: string;
	args: unknown;
	error: Error;
	/** Mutable - set to recover and return this instead of throwing */
	result?: unknown;
};

/** A dynamic source of tools, consulted when a name is not in the static `tools` list.
 *  Lets the sandbox forward tool calls without enumerating every tool upfront —
 *  useful when the source is a large or slow-to-list upstream (e.g. an MCP
 *  aggregator), where an upfront listing would cost more than the execution. */
export type ToolSource = {
	/** Call a tool by name. Throw to reject the call. */
	call(name: string, args: Record<string, unknown>): Promise<unknown>;
	/** List available tools (returned by the list_tools built-in, after the static tools). */
	list(): Promise<{name: string; description?: string | undefined}[]>;
	/** Describe a tool's schema (returned by the describe_tool built-in). */
	describe(name: string): Promise<unknown>;
};

/** Options for createSandbox */
export type SandboxOptions = {
	tools: Tool[];
	/** Dynamic tool source, consulted for names not in `tools`. */
	toolSource?: ToolSource;
	onBeforeToolCall?: (event: BeforeToolCallEvent) => void;
	onToolCallSuccess?: (event: ToolCallSuccessEvent) => void;
	onToolCallError?: (event: ToolCallErrorEvent) => void;
	/** Max result size in chars before truncation (default: 40000) */
	experimental_maxResultChars?: number;
	/** Max poll iterations before timeout, ~100ms each (default: 500) */
	experimental_maxPollIterations?: number;
};

/** Blob content extracted from tool results (images, PDFs, etc.) */
export type Blob = {
	id: string;
	data: string;
	mimeType: string;
};

/** Result from executing code */
export type ExecuteResult = {
	success: boolean;
	result?: unknown;
	error?: string;
	/** Blobs extracted from tool results during execution */
	blobs: Blob[];
};

/** Sandbox instance */
export type Sandbox = {
	/** Current tools (read-only, use addTool/removeTool to modify) */
	readonly tools: readonly Tool[];
	/** Persistent store - read/write from host and sandbox */
	store: Record<string, unknown>;
	/** Tool object for executing code */
	readonly execute: Omit<Tool, 'handler'> & {
		description: string;
		outputSchema: JsonSchema;
		handler: (args: {code: string}) => Promise<ExecuteResult>;
	};
	/** Add a tool */
	addTool(tool: Tool): void;
	/** Remove a tool by name */
	removeTool(name: string): void;
};
