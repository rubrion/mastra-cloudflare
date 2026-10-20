// Mastra Memory on D1. Built lazily: D1 table setup is I/O, which Workers only
// allow inside a request, never at module load. Tables are created on first use.
import { D1Store } from '@mastra/cloudflare-d1';
import { Memory } from '@mastra/memory';

export interface D1MemoryOptions {
	/** Messages recalled into each prompt; the one memory setting charged per turn. */
	lastMessages?: number;
	/** Store id, for Mastra's logs. */
	id?: string;
}

/**
 * A getter for a D1-backed Memory, with no vector store or embedder to pay
 * for. Pass the getter as an agent's `memory`.
 *
 *     const memory = d1Memory(() => env.MEMORY, { lastMessages: 8 });
 */
export function d1Memory(binding: () => D1Database, { lastMessages = 10, id = 'mastra-memory' }: D1MemoryOptions = {}) {
	let memory: Memory | undefined;
	return () =>
		(memory ??= new Memory({
			storage: new D1Store({ id, binding: binding() }),
			vector: false,
			options: { lastMessages, semanticRecall: false, generateTitle: false },
		}));
}
