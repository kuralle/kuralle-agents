/**
 * Tiny in-memory CRUD store. Each mock-service owns one of these
 * indexed by `id`. Per-process, not per-session — fine for templates.
 */
export class MockStore<T extends { id: string }> {
	private map = new Map<string, T>();

	constructor(seed: T[]) {
		for (const item of seed) this.map.set(item.id, structuredClone(item));
	}

	get(id: string): T | null {
		return this.map.get(id) ?? null;
	}
	list(): T[] {
		return Array.from(this.map.values());
	}
	find(pred: (item: T) => boolean): T | null {
		for (const item of this.map.values()) if (pred(item)) return item;
		return null;
	}
	update(id: string, patch: Partial<T>): T | null {
		const cur = this.map.get(id);
		if (!cur) return null;
		const next = { ...cur, ...patch, id } as T;
		this.map.set(id, next);
		return next;
	}
}
