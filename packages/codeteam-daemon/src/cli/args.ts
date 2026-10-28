import { ControlError } from "../control/errors.ts";

export interface ParsedArgs {
	readonly positionals: string[];
	readonly values: Map<string, string[]>;
	readonly flags: Set<string>;
}

export function parseArgs(argv: readonly string[], booleanFlags: readonly string[] = []): ParsedArgs {
	const positionals: string[] = [];
	const values = new Map<string, string[]>();
	const flags = new Set<string>();
	const booleans = new Set(booleanFlags);
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--") {
			positionals.push(...argv.slice(index + 1));
			break;
		}
		if (!arg.startsWith("--") || arg === "--") {
			positionals.push(arg);
			continue;
		}
		const equals = arg.indexOf("=");
		const name = (equals >= 0 ? arg.slice(2, equals) : arg.slice(2)).trim();
		if (name === "") throw new ControlError("invalid_input", "option name must not be empty");
		if (equals >= 0) {
			addValue(values, name, arg.slice(equals + 1));
			continue;
		}
		if (booleans.has(name)) {
			flags.add(name);
			continue;
		}
		const next = argv[index + 1];
		if (next !== undefined && !next.startsWith("--")) {
			addValue(values, name, next);
			index += 1;
		} else {
			flags.add(name);
		}
	}
	return { positionals, values, flags };
}

function addValue(values: Map<string, string[]>, name: string, value: string): void {
	const existing = values.get(name);
	if (existing) existing.push(value);
	else values.set(name, [value]);
}

export function option(args: ParsedArgs, name: string): string | undefined {
	return args.values.get(name)?.[0];
}

export function options(args: ParsedArgs, name: string): string[] {
	return args.values.get(name) ?? [];
}

export function requireOption(args: ParsedArgs, name: string): string {
	const value = option(args, name);
	if (value === undefined || value.trim() === "") {
		throw new ControlError("invalid_input", `--${name} is required`);
	}
	return value;
}

export function numberOption(args: ParsedArgs, name: string): number | undefined {
	const value = option(args, name);
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new ControlError("invalid_input", `--${name} must be a non-negative integer`);
	}
	return parsed;
}

export function flag(args: ParsedArgs, name: string): boolean {
	return args.flags.has(name);
}
