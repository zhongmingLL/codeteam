export type MessageContentPart =
	| { kind: "text"; text: string }
	| { kind: "code"; text: string; lang?: string };

export function splitMessageContent(content: string): MessageContentPart[] {
	const parts: MessageContentPart[] = [];
	const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null = fence.exec(content);
	while (match !== null) {
		if (match.index > lastIndex) parts.push({ kind: "text", text: content.slice(lastIndex, match.index) });
		parts.push({ kind: "code", text: match[2], ...(match[1].trim() === "" ? {} : { lang: match[1].trim() }) });
		lastIndex = fence.lastIndex;
		match = fence.exec(content);
	}
	if (lastIndex < content.length) parts.push({ kind: "text", text: content.slice(lastIndex) });
	return parts;
}

export function MessageContent({ content }: { content: string }) {
	const parts = splitMessageContent(content);
	return (
		<div className="st-message-content">
			{parts.map((part, index) =>
				part.kind === "code" ? (
					<pre className="st-code-block" key={`code-${index}`}>
						<code>{part.text}</code>
					</pre>
				) : (
					<span className="st-message-text" key={`text-${index}`}>
						{part.text}
					</span>
				),
			)}
		</div>
	);
}
