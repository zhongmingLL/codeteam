import { useNewThreadDialog } from "@/domains/thread/dialog-store";
import { useThreadStore } from "@/domains/thread/store";

export function HomePage() {
	const threads = useThreadStore((state) => state.threads);
	const showDialog = useNewThreadDialog((state) => state.show);

	return (
		<section className="st-hero">
			<h1>{threads.length === 0 ? "开始一段对话" : "选择一个对话继续"}</h1>
			<p>
				{threads.length === 0
					? "每个对话都有真实的项目路径、消息记录和 agent 状态。"
					: "从左侧选择对话，或者新建一个。"}
			</p>
			<button type="button" className="st-button" onClick={() => showDialog()}>
				+ 新对话
			</button>
		</section>
	);
}
