import { ControlPlaneError } from "./errors.ts";
import type { Stage, StageChangeKind } from "./types.ts";

const ALLOWED_TRANSITIONS: Record<Stage, readonly Stage[]> = {
	intake: ["plan", "done"],
	plan: ["implement", "done"],
	implement: ["review", "plan"],
	review: ["verify", "implement"],
	verify: ["done", "implement"],
	done: [],
};

export function canAdvance(from: Stage, to: Stage): boolean {
	return ALLOWED_TRANSITIONS[from].includes(to);
}

export class Workflow {
	private current: Stage;

	constructor(initial: Stage = "intake") {
		this.current = initial;
	}

	get stage(): Stage {
		return this.current;
	}

	advance(to: Stage): Stage {
		if (!canAdvance(this.current, to)) {
			throw new ControlPlaneError("illegal_transition", `illegal stage transition ${this.current} -> ${to}`);
		}
		this.current = to;
		return this.current;
	}

	requestChange(kind: StageChangeKind): Stage {
		if (this.current === "done") {
			throw new ControlPlaneError("illegal_transition", `cannot request ${kind} from done`);
		}
		this.current = "plan";
		return this.current;
	}
}
