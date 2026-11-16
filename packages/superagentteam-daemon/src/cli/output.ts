export function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function writeLine(text = ""): void {
	process.stdout.write(`${text}\n`);
}

export interface TableColumn<T> {
	readonly header: string;
	readonly value: (row: T) => string;
}

export function writeTable<T>(rows: readonly T[], columns: readonly TableColumn<T>[]): void {
	if (rows.length === 0) {
		writeLine("(empty)");
		return;
	}
	const widths = columns.map((column) =>
		Math.max(column.header.length, ...rows.map((row) => column.value(row).length)),
	);
	const render = (cells: readonly string[]): string =>
		cells
			.map((cell, index) => cell.padEnd(widths[index]!))
			.join("  ")
			.trimEnd();
	writeLine(render(columns.map((column) => column.header)));
	for (const row of rows) writeLine(render(columns.map((column) => column.value(row))));
}
