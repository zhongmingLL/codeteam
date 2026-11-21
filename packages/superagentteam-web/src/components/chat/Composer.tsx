import { useEffect, useRef, useState } from "react";

import type { AgentView } from "@/domains/agent/api";

export interface ComposerProps {
	threadId: string;
	onSend: (content: string, idempotencyKey: string, targetAgentIds?: string[]) => Promise<void>;
	agents?: AgentView[];
	disabled?: boolean;
	disabledReason?: string;
}

function draftKey(threadId: string): string {
	return `superagentteam:draft:${threadId}`;
}

function readDraft(threadId: string): string {
	try {
		return window.sessionStorage.getItem(draftKey(threadId)) ?? "";
	} catch {
		return "";
	}
}

function writeDraft(threadId: string, content: string): void {
	try {
		if (content === "") window.sessionStorage.removeItem(draftKey(threadId));
		else window.sessionStorage.setItem(draftKey(threadId), content);
	} catch {
		// Storage can be unavailable in privacy modes; the in-memory draft still works.
	}
}

export function Composer({ threadId, onSend, agents = [], disabled = false, disabledReason }: ComposerProps) {
	const [content, setContent] = useState(() => readDraft(threadId));
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [targetAgentId, setTargetAgentId] = useState("");
	const idempotencyKey = useRef<string | null>(null);
	const keyedContent = useRef<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const enabledAgents = agents.filter((agent) => agent.enabled);
	const selectedTarget = enabledAgents.some((agent) => agent.id === targetAgentId) ? targetAgentId : "";

	useEffect(() => {
		writeDraft(threadId, content);
	}, [threadId, content]);

	useEffect(() => {
		const element = textareaRef.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
	}, [content]);

	const submit = async (): Promise<void> => {
		const text = content.trim();
		if (text === "" || sending || disabled) return;

		if (idempotencyKey.current === null || keyedContent.current !== text) {
			idempotencyKey.current = crypto.randomUUID();
			keyedContent.current = text;
		}

		setSending(true);
		setError(undefined);
		try {
			if (selectedTarget === "") await onSend(text, idempotencyKey.current);
			else await onSend(text, idempotencyKey.current, [selectedTarget]);
			idempotencyKey.current = null;
			keyedContent.current = null;
			setContent("");
			writeDraft(threadId, "");
		} catch (caught) {
			setError(caught instanceof Error ? `发送失败：${caught.message}。草稿已保留，可重试。` : "发送失败，草稿已保留。");
		} finally {
			setSending(false);
		}
	};

	if (disabled) {
		return (
			<div className="st-composer is-disabled">
				<p className="st-composer-note">{disabledReason ?? "当前对话不能发送消息。"}</p>
			</div>
		);
	}

	return (
		<div className="st-composer">
			{error ? (
				<p className="st-error" role="alert">
					{error}
				</p>
			) : null}
			{enabledAgents.length > 0 ? (
				<div className="st-composer-target">
					<label htmlFor={`st-target-${threadId}`}>发给</label>
					<select
						id={`st-target-${threadId}`}
						aria-label="收件人"
						value={selectedTarget}
						onChange={(event) => setTargetAgentId(event.target.value)}
						disabled={sending}
					>
						<option value="">自动</option>
						{enabledAgents.map((agent) => (
							<option value={agent.id} key={agent.id}>
								{agent.displayName}
							</option>
						))}
					</select>
				</div>
			) : null}
			<div className="st-composer-row">
				<textarea
					ref={textareaRef}
					value={content}
					onChange={(event) => setContent(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							void submit();
						}
					}}
					placeholder="输入消息，Enter 发送，Shift+Enter 换行"
					aria-label="消息内容"
					rows={1}
					readOnly={sending}
				/>
				<button
					type="button"
					className="st-button st-send-button"
					onClick={() => void submit()}
					disabled={sending || content.trim() === ""}
				>
					{sending ? "发送中…" : "发送"}
				</button>
			</div>
			<p className="st-composer-hint">
				发给：{selectedTarget === "" ? "自动" : (enabledAgents.find((agent) => agent.id === selectedTarget)?.displayName ?? "自动")} ·
				Enter 发送 · Shift+Enter 换行
			</p>
		</div>
	);
}
