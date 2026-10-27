export { appendBootRecord, type BootEvent, type BootRecord, nextBootSequence, readBootLedger } from "./boot-ledger.ts";
export {
	applyControlMigrations,
	configureControlDatabase,
	CONTROL_DATABASE_FILE,
	type ControlDatabase,
	ControlError,
	type ControlErrorCode,
	CONTROL_MIGRATIONS,
	CONTROL_TABLE_NAMES,
	type ControlMigration,
	DEFAULT_CONTROL_BUSY_TIMEOUT_MS,
	getControlSchemaVersion,
	type OpenControlDatabaseOptions,
	openControlDatabase,
	resolveControlBusyTimeoutMs,
	resolveControlDataDir,
	verifyControlSchema,
} from "./control/index.ts";
export {
	type DaemonBoot,
	type DaemonHandle,
	type DaemonHealth,
	type StartDaemonOptions,
	startDaemon,
} from "./daemon.ts";
export { DaemonError, type DaemonErrorCode } from "./errors.ts";
export { acquireFence, type FenceRecord, isProcessAlive, readFence, releaseFence } from "./fence.ts";
export { type InstallationIdentity, resolveInstallation } from "./installation.ts";
export { type DaemonPaths, resolveDaemonPaths } from "./paths.ts";
export { type DaemonState, type DaemonStateFile, readStateFile, writeStateFile } from "./state.ts";
