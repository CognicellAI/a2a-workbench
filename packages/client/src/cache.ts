import type { AgentCardCache, CachedAgentCard } from "./types.js";

export class MemoryAgentCardCache implements AgentCardCache {
  readonly #entries = new Map<string, CachedAgentCard>();

  async get(cardUrl: string): Promise<CachedAgentCard | undefined> {
    return this.#entries.get(cardUrl);
  }

  async set(cardUrl: string, value: CachedAgentCard): Promise<void> {
    this.#entries.set(cardUrl, structuredClone(value));
  }

  async delete(cardUrl: string): Promise<void> {
    this.#entries.delete(cardUrl);
  }
}
