/**
 * Extracts TypeScript code blocks from README.md and typechecks them.
 */
import {test, expect} from 'vitest';
import {
	readFileSync, writeFileSync, mkdirSync, rmSync,
} from 'fs';
import {execSync} from 'child_process';
import {join} from 'path';

const README_PATH = join(__dirname, '..', 'README.md');
const TEMP_DIR = join(__dirname, '..', '.readme-check');

function extractTypeScriptBlocks(markdown: string): {code: string; line: number}[] {
	const blocks: {code: string; line: number}[] = [];
	const lines = markdown.split('\n');

	let inBlock = false;
	let currentBlock = '';
	let blockStartLine = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;

		if (line.startsWith('```typescript') || line.startsWith('```ts')) {
			inBlock = true;
			currentBlock = '';
			blockStartLine = i + 1;
		} else if (inBlock && line.startsWith('```')) {
			inBlock = false;
			blocks.push({code: currentBlock, line: blockStartLine});
		} else if (inBlock) {
			currentBlock += `${line}\n`;
		}
	}

	return blocks;
}

function wrapCodeBlock(code: string, index: number): string {
	const imports: string[] = [];

	if (code.includes('createSandbox') && !code.includes('from \'tool-sandbox\'')) {
		imports.push('import {createSandbox, type Tool} from \'../src/index.js\';');
	}

	if (code.includes('fromMcpClients') && !code.includes('from \'tool-sandbox/mcp\'')) {
		imports.push('import {fromMcpClients} from \'../src/mcp.js\';');
	}

	// Replace tool-sandbox imports with local imports
	const processedCode = code
		.replace(/from ['"]tool-sandbox['"]/g, 'from \'../src/index.js\'')
		.replace(/from ['"]tool-sandbox\/mcp['"]/g, 'from \'../src/mcp.js\'');

	// Wrap in async IIFE if using top-level await
	const hasTopLevelAwait = /^(?!.*(?:async\s+function|async\s*\()).*\bawait\b/m.test(processedCode);
	const wrappedCode = hasTopLevelAwait
		? `${imports.join('\n')}\n\n(async () => {\n${processedCode}\n})();`
		: `${imports.join('\n')}\n\n${processedCode}`;

	return `// README example block ${index + 1}\n// @ts-nocheck - external SDK types not available\n${wrappedCode}`;
}

test('README TypeScript examples typecheck', () => {
	const readme = readFileSync(README_PATH, 'utf-8');
	const blocks = extractTypeScriptBlocks(readme);

	expect(blocks.length).toBeGreaterThan(0);

	// Create temp directory
	rmSync(TEMP_DIR, {recursive: true, force: true});
	mkdirSync(TEMP_DIR, {recursive: true});

	try {
		// Write each block to a file
		for (let i = 0; i < blocks.length; i++) {
			const {code} = blocks[i]!;
			const filename = `block-${i + 1}.ts`;
			const filepath = join(TEMP_DIR, filename);
			const wrapped = wrapCodeBlock(code, i);
			writeFileSync(filepath, wrapped);
		}

		// Create a tsconfig for the temp directory
		const tsconfig = {
			compilerOptions: {
				target: 'ES2022',
				module: 'NodeNext',
				moduleResolution: 'NodeNext',
				strict: true,
				skipLibCheck: true,
				noEmit: true,
				esModuleInterop: true,
				types: ['node'],
				paths: {
					'../src/index.js': ['../src/index.ts'],
					'../src/mcp.js': ['../src/mcp.ts'],
				},
			},
			include: ['*.ts'],
		};
		writeFileSync(join(TEMP_DIR, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));

		// Run tsc - if it throws, the test fails
		execSync('npx tsc --project tsconfig.json', {
			cwd: TEMP_DIR,
			stdio: 'pipe',
		});
	} finally {
		rmSync(TEMP_DIR, {recursive: true, force: true});
	}
});
