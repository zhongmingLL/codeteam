import type {
	Coverage,
	EvidenceKind,
	ReadResult,
	RecallResult,
	RetrievalTrigger,
	RetrievalTriggerInput,
	TriggerRecallResult,
} from "./contract.ts";
import type { MemoryDatabase } from "./database.ts";
import { MemoryRecall, type MemoryRecallOptions } from "./recall.ts";
import { retrieveForTrigger } from "./triggers.ts";

export class MemoryService {
	readonly recall: MemoryRecall;

	constructor(memory: MemoryDatabase, options: MemoryRecallOptions = {}) {
		this.recall = new MemoryRecall(memory, options);
	}

	coverage(): Coverage {
		return this.recall.coverage();
	}

	search(options: { query: string; kinds?: readonly EvidenceKind[]; limit?: number }): RecallResult {
		return this.recall.search(options);
	}

	read(anchor: string): ReadResult {
		return this.recall.read(anchor);
	}

	retrieveForTrigger(trigger: RetrievalTrigger, input: RetrievalTriggerInput = {}): TriggerRecallResult {
		return retrieveForTrigger(trigger, input, (options) => this.recall.search(options));
	}
}
