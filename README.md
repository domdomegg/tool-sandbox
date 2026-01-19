# tool-sandbox

Execute untrusted code safely with tool access. Built for AI agents using MCP, Claude, GPT, and other LLMs.

<!-- Video demo placeholder: Add a GIF or video showing the sandbox in action -->

## Why?

When building AI agents, you often want them to write and execute code. But running arbitrary code is dangerous. tool-sandbox solves this by:

- Running code in a secure QuickJS WASM sandbox (no filesystem, network, or Node.js APIs)
- Giving code access to tools you define (API calls, database queries, etc.)
- Providing a simple interface that works with any LLM

This is the same approach described in [Anthropic's "Code Execution with MCP" blog post](https://www.anthropic.com/engineering/code-execution-with-mcp) - code execution reduces context usage by 98.7% compared to having the LLM make tool calls directly.

## Quick Start

```bash
npm install tool-sandbox
```

```typescript
import {createSandbox} from 'tool-sandbox';

// Create a sandbox with your tools
const sandbox = await createSandbox({
  tools: [
    {
      name: 'add',
      description: 'Add two numbers',
      inputSchema: {type: 'object', properties: {a: {type: 'number'}, b: {type: 'number'}}},
      handler: async (args) => args.a + args.b,
    },
  ],
});

// Execute code
const result = await sandbox.execute.handler({
  code: `
    const sum = await tool('add', {a: 2, b: 3});
    return sum * 2;
  `
});
// { success: true, result: 10 }
```

## Using with LLMs

`sandbox.execute` is a Tool object you can pass directly to LLM APIs:

```typescript
// Anthropic
const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-20250514',
  tools: [{
    name: sandbox.execute.name,
    description: sandbox.execute.description,
    input_schema: sandbox.execute.inputSchema,
  }],
  messages: [{role: 'user', content: 'Calculate 2+3 and double it'}],
});

// Handle tool calls
for (const block of response.content) {
  if (block.type === 'tool_use' && block.name === 'execute') {
    const result = await sandbox.execute.handler(block.input);
    // Send result back to Claude...
  }
}
```

```typescript
// OpenAI
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  tools: [{
    type: 'function',
    function: {
      name: sandbox.execute.name,
      description: sandbox.execute.description,
      parameters: sandbox.execute.inputSchema,
    },
  }],
  messages: [{role: 'user', content: 'Calculate 2+3 and double it'}],
});
```

## Using with MCP

If you're using the [Model Context Protocol](https://modelcontextprotocol.io/), you can automatically convert MCP clients to tools:

```bash
npm install @modelcontextprotocol/sdk
```

```typescript
import {createSandbox} from 'tool-sandbox';
import {fromMcpClients} from 'tool-sandbox/mcp';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

// Connect to MCP servers
const transport = new StdioClientTransport({command: 'npx', args: ['-y', '@anthropic/mcp-gmail']});
const client = new Client({name: 'my-app', version: '1.0.0'});
await client.connect(transport);

// Convert to tools
const tools = await fromMcpClients({gmail: client});

// Create sandbox with MCP tools
const sandbox = await createSandbox({tools});
```

## Sandbox Environment

Inside the sandbox, code has access to:

| API | Description |
|-----|-------------|
| `tool(name, args)` | Call a tool and await its result |
| `console.log(...)` | Debug output (visible to host) |
| `store` | Persistent object across executions |
| `store._prev` | Result from previous execution |

```javascript
// Example sandbox code
const users = await tool('api__getUsers', {limit: 10});
store.cachedUsers = users;
console.log('Fetched', users.length, 'users');
return users;
```

The built-in `describe` tool returns a tool's schema:

```javascript
const schema = await tool('describe', {name: 'api__getUsers'});
// { name: 'api__getUsers', description: '...', inputSchema: {...} }
```

## Event Handlers

Intercept and modify tool calls:

```typescript
const sandbox = await createSandbox({
  tools,
  onBeforeToolCall(event) {
    // Modify args, block calls, or return cached values
    if (cache.has(event.toolName, event.args)) {
      event.returnValue = cache.get(event.toolName, event.args);
    }
  },
  onToolCallSuccess(event) {
    // Modify results, log calls
    cache.set(event.toolName, event.args, event.result);
  },
  onToolCallError(event) {
    // Recover from errors
    event.result = {fallback: true};
  },
});
```

## API Reference

### `createSandbox(options)`

Creates a sandbox instance.

**Options:**
- `tools: Tool[]` - Array of tools available in the sandbox
- `onBeforeToolCall?: (event) => void` - Called before each tool invocation
- `onToolCallSuccess?: (event) => void` - Called after successful tool invocation
- `onToolCallError?: (event) => void` - Called after failed tool invocation

**Returns:** `Sandbox` instance

### Sandbox

- `execute: Tool` - Tool object for executing code (pass to LLM, call `.handler({code})`)
- `tools: Tool[]` - Current tools (read-only)
- `store: Record<string, unknown>` - Persistent store
- `addTool(tool)` - Add a tool at runtime
- `removeTool(name)` - Remove a tool by name

### Tool

```typescript
type Tool = {
  name: string;
  description?: string;
  inputSchema: {type: 'object'; properties?: Record<string, unknown>; required?: string[]};
  handler: (args: unknown) => Promise<unknown>;
}
```

## Security

The sandbox uses [QuickJS](https://bellard.org/quickjs/) compiled to WebAssembly. Code runs in a completely isolated environment with:

- No access to filesystem, network, or Node.js APIs
- No `require`, `import`, `fetch`, `setTimeout`, etc.
- Tool calls are the only way to interact with the outside world

The sandbox cannot break out - it can only call tools you explicitly provide.

## Contributing

Pull requests are welcomed on GitHub! To get started:

1. Install Git and Node.js
2. Clone the repository
3. Install dependencies with `npm install`
4. Run `npm run test` to run tests
5. Build with `npm run build`

## Releases

Versions follow the [semantic versioning spec](https://semver.org/).

To release:

1. Use `npm version <major | minor | patch>` to bump the version
2. Run `git push --follow-tags` to push with tags
3. Wait for GitHub Actions to publish to the NPM registry.
