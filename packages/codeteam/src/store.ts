import type { Handoff, Run, Task } from "./types.ts";

export interface ControlSnapshot {
	tasks: Task[];
	runs: Run[];
	handoffs: Handoff[];
}

export interface ControlStore {
	saveTask(task: Task): void;
	saveRun(run: Run): void;
	saveHandoff(handoff: Handoff): void;
	loadSnapshot(): ControlSnapshot;
}
