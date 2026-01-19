/** JSON Schema for tool input/output */
export type JsonSchema = {
	type: 'object';
	properties?: Record<string, unknown>;
	required?: string[];
};

/** Tool definition - matches MCP SDK Tool interface with handler */
export type Tool = {
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
	/** Set to skip the tool call and return this value instead */
	returnValue?: unknown;
};

/** Event fired after a successful tool call */
export type ToolCallSuccessEvent = {
	toolName: string;
	args: unknown;
	/** Mutable - modify to change the result */
	result: unknown;
	duration: number;
};

/** Event fired after a failed tool call */
export type ToolCallErrorEvent = {
	toolName: string;
	args: unknown;
	error: Error;
	duration: number;
	/** Set to recover and return this instead of throwing */
	result?: unknown;
};

/** Options for createSandbox */
export type SandboxOptions = {
	tools: Tool[];
	onBeforeToolCall?: (event: BeforeToolCallEvent) => void;
	onToolCallSuccess?: (event: ToolCallSuccessEvent) => void;
	onToolCallError?: (event: ToolCallErrorEvent) => void;
};

/** Result from executing code */
export type ExecuteResult = {
	success: boolean;
	result?: unknown;
	error?: string;
};

/** Sandbox instance */
export type Sandbox = {
	/** Current tools (read-only, use addTool/removeTool to modify) */
	readonly tools: readonly Tool[];
	/** Persistent store - read/write from host and sandbox */
	store: Record<string, unknown>;
	/** Tool object for executing code */
	readonly execute: Tool;
	/** Add a tool */
	addTool(tool: Tool): void;
	/** Remove a tool by name */
	removeTool(name: string): void;
};
