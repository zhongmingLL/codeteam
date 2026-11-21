import { useEffect, useRef, useState } from "react";

import { useThreadStore } from "@/domains/thread/store";
import type { ThreadView } from "@/domains/thread/api";

export interface NewThreadDialogProps {
	open: boolean;
	onClose: () => void;
	onCreated: (thread: ThreadView) => void;
}

export function NewThreadDialog({ open, onClose, onCreated }: NewThreadDialogProps) {
	const create = useThreadStore((state) => state.create);
	const [title, setTitle] = useState("");
	const [projectPath, setProjectPath] = useState("");
	const [error, setError] = useState<string | undefined>();
	const [submitting, setSubmitting] = useState(false);
	const idempotencyKey = useRef<string | null>(null);
	const projectInput = useRef<HTMLInputElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const previousFocus = useRef<HTMLElement | null>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		if (!open) return;
		previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setTitle("");
		setProjectPath("");
		setError(undefined);
		setSubmitting(false);
		idempotencyKey.current = null;
		const timer = setTimeout(() => projectInput.current?.focus(), 0);
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				onCloseRef.current();
				return;
			}
			if (event.key !== "Tab" || !dialogRef.current) return;
			const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
				'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
			);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => {
			clearTimeout(timer);
			window.removeEventListener("keydown", onKey);
			previousFocus.current?.focus();
		};
	}, [open]);

	if (!open) return null;

	const submit = async (event: React.FormEvent): Promise<void> => {
		event.preventDefault();
		const trimmedPath = projectPath.trim();
		if (trimmedPath === "") {
			setError("请填写项目路径（daemon 需要一个真实目录）");
			return;
		}
		idempotencyKey.current ??= crypto.randomUUID();
		setSubmitting(true);
		setError(undefined);
		try {
			const thread = await create({
				projectPath: trimmedPath,
				...(title.trim() === "" ? {} : { title: title.trim() }),
				idempotencyKey: idempotencyKey.current,
			});
			onCreated(thread);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "创建对话失败");
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="st-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
			<div
				ref={dialogRef}
				className="st-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="st-new-thread-title"
			>
				<h2 id="st-new-thread-title">新对话</h2>
				<form onSubmit={(event) => void submit(event)}>
					<label className="st-field">
						<span>项目路径</span>
						<input
							ref={projectInput}
							value={projectPath}
							onChange={(event) => setProjectPath(event.target.value)}
							placeholder="/path/to/project"
							autoComplete="off"
						/>
					</label>
					<label className="st-field">
						<span>对话名（可选）</span>
						<input
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							placeholder="不填就用第一句话或项目名"
							autoComplete="off"
						/>
					</label>
					{error ? <p className="st-error">{error}</p> : null}
					<div className="st-dialog-actions">
						<button type="button" className="st-button st-button-secondary" onClick={onClose} disabled={submitting}>
							取消
						</button>
						<button type="submit" className="st-button" disabled={submitting}>
							{submitting ? "创建中…" : "创建"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
