import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type CodeBlock = {
	index: number;
	language: string;
	code: string;
};

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((block) => {
			if (!block || typeof block !== "object" || !("type" in block)) return "";
			const typed = block as Record<string, unknown>;

			if (typed.type === "text" && typeof typed.text === "string") return typed.text;
			if (typed.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function extractCodeBlocks(markdown: string): CodeBlock[] {
	const blocks: CodeBlock[] = [];
	const fence = /```([^\n`]*)\n([\s\S]*?)\n```/g;
	let match: RegExpExecArray | null;

	while ((match = fence.exec(markdown)) !== null) {
		const language = match[1].trim();
		const code = match[2];
		if (!code.trim()) continue;
		blocks.push({ index: blocks.length + 1, language, code });
	}

	return blocks;
}

function preview(text: string, maxLength = 72): string {
	const firstLine = text.trim().split("\n").find(Boolean)?.trim() ?? "code block";
	return firstLine.length > maxLength ? `${firstLine.slice(0, maxLength - 1)}…` : firstLine;
}

function runClipboardCommand(command: string, args: string[], text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args);
		let stderr = "";
		let settled = false;

		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});

		child.on("error", (error) => {
			if (!settled) {
				settled = true;
				reject(error);
			}
		});

		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
		});

		child.stdin.end(text);
	});
}

async function copyToClipboard(text: string): Promise<string> {
	const candidates: Array<{ command: string; args: string[] }> = [];

	if (process.platform === "darwin") candidates.push({ command: "pbcopy", args: [] });
	if (process.platform === "win32") candidates.push({ command: "clip.exe", args: [] });

	candidates.push(
		{ command: "wl-copy", args: [] },
		{ command: "xclip", args: ["-selection", "clipboard"] },
		{ command: "xsel", args: ["--clipboard", "--input"] },
		{ command: "termux-clipboard-set", args: [] },
	);

	const errors: string[] = [];
	for (const candidate of candidates) {
		try {
			await runClipboardCommand(candidate.command, candidate.args, text);
			return candidate.command;
		} catch (error) {
			errors.push(`${candidate.command}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	throw new Error(`No clipboard command worked. Tried: ${errors.join("; ")}`);
}

async function writeSelectionToFile(fileName: string, text: string, cwd: string): Promise<string> {
	const resolved = path.isAbsolute(fileName) ? fileName : path.resolve(cwd, fileName);
	await mkdir(path.dirname(resolved), { recursive: true });
	await writeFile(resolved, text, "utf8");
	return resolved;
}

function parseResponseNumber(args: string): number | undefined {
	const trimmed = args.trim();
	if (!trimmed) return 1;
	if (!/^\d+$/.test(trimmed)) return undefined;
	const value = Number(trimmed);
	return value >= 1 ? value : undefined;
}

export default function copyExtension(pi: ExtensionAPI) {
	pi.registerCommand("ccopy", {
		description: "Claude-style copy: pick full assistant response or code blocks",
		getArgumentCompletions: (prefix) => {
			const values = ["1", "2", "3", "4", "5"];
			const filtered = values.filter((value) => value.startsWith(prefix.trim()));
			return filtered.map((value) => ({ value, label: `/ccopy ${value}` }));
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const responseNumber = parseResponseNumber(args);
			if (!responseNumber) {
				ctx.ui.notify("Usage: /copy [assistant-response-number]", "warning");
				return;
			}

			const assistantMessages = ctx.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.message)
				.filter((message) => message.role === "assistant");

			const message = assistantMessages[assistantMessages.length - responseNumber];
			if (!message) {
				ctx.ui.notify(`No assistant response #${responseNumber} found`, "info");
				return;
			}

			const fullResponse = textFromContent(message.content).trim();
			if (!fullResponse) {
				ctx.ui.notify("Assistant response has no copyable text", "info");
				return;
			}

			const blocks = extractCodeBlocks(fullResponse);
			let selectedText = fullResponse;
			let selectedLabel = "full response";
			let shouldWrite = false;

			if (ctx.hasUI && blocks.length > 0) {
				const options = [
					"Copy full response",
					"Write full response to file…",
					...blocks.flatMap((block) => {
						const label = `code block ${block.index}${block.language ? ` (${block.language})` : ""}: ${preview(block.code)}`;
						return [`Copy ${label}`, `Write ${label} to file…`];
					}),
				];

				const choice = await ctx.ui.select(`Copy assistant response #${responseNumber}`, options);
				if (!choice) return;

				if (choice === "Copy full response") {
					selectedText = fullResponse;
					selectedLabel = "full response";
				} else if (choice === "Write full response to file…") {
					selectedText = fullResponse;
					selectedLabel = "full response";
					shouldWrite = true;
				} else {
					const block = blocks.find((candidate) => choice.includes(`code block ${candidate.index}`));
					if (!block) return;
					selectedText = block.code;
					selectedLabel = `code block ${block.index}`;
					shouldWrite = choice.startsWith("Write ");
				}
			}

			if (shouldWrite) {
				const defaultName = selectedLabel === "full response" ? "assistant-response.md" : `assistant-${selectedLabel.replace(/\s+/g, "-")}.txt`;
				const fileName = await ctx.ui.input("Write selection to file", defaultName);
				if (!fileName) return;
				const writtenPath = await writeSelectionToFile(fileName, selectedText, ctx.cwd);
				ctx.ui.notify(`Wrote ${selectedLabel} to ${writtenPath}`, "info");
				return;
			}

			try {
				const command = await copyToClipboard(selectedText);
				ctx.ui.notify(`Copied ${selectedLabel} to clipboard (${command})`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
