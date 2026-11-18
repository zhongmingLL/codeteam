export async function routeParallel<T, R>(
	items: readonly T[],
	invoke: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
	return Promise.allSettled(items.map((item, index) => invoke(item, index)));
}

export async function routeSerial<T, R>(
	items: readonly T[],
	invoke: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = [];
	for (const [index, item] of items.entries()) results.push(await invoke(item, index));
	return results;
}
