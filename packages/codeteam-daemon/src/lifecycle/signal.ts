export interface ProcessSignalSender {
	send(target: number, signal: "SIGTERM"): void;
}

export class RealProcessSignalSender implements ProcessSignalSender {
	send(target: number, signal: "SIGTERM"): void {
		process.kill(target, signal);
	}
}
