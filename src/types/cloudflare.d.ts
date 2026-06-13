// Augments the Cloudflare Workers env binding with this Worker's bindings.
//
// `@cloudflare/workers-types` declares `export const env: Cloudflare.Env`
// from the `cloudflare:workers` module with an empty `Cloudflare.Env`; we
// merge our bindings in here. The binding is populated at request time, so
// consumers read it lazily (inside functions), never at module load.
declare global {
  namespace Cloudflare {
    interface Env {
      /** D1 database for Mastra agent memory (threads/messages). */
      DB: D1Database;
      /** Mastra model-router id, e.g. openai/gpt-4o-mini. */
      MODEL?: string;
      /** OpenAI-compatible API key (also reachable via process.env). */
      OPENAI_API_KEY?: string;
      /** OpenAI-compatible base URL — point at any compatible endpoint. */
      OPENAI_BASE_URL?: string;
    }
  }
}

export {};
