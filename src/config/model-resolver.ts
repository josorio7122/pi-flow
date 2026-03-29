/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

/** Score a model against a query — higher is better match. */
function scoreModel(m: ModelEntry, query: string) {
  const id = m.id.toLowerCase();
  const name = m.name.toLowerCase();
  const full = `${m.provider}/${m.id}`.toLowerCase();

  if (id === query || full === query) return 100;
  if (id.includes(query) || full.includes(query)) return 60 + (query.length / id.length) * 30;
  if (name.includes(query)) return 40 + (query.length / name.length) * 20;
  if (query.split(/[\s\-/]+/).every(part => id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))) return 20;
  return 0;
}

/**
 * Resolve a model string to a Model instance.
 * Tries exact match first ("provider/modelId"), then fuzzy match against all available models.
 * Returns the Model on success, or an error message string on failure.
 */
export function resolveModel(
  input: string,
  registry: ModelRegistry,
) {
  // Available models (those with auth configured)
  const all = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
  const availableSet = new Set(all.map(m => `${m.provider}/${m.id}`.toLowerCase()));

  // 1. Exact match: "provider/modelId" — only if available (has auth)
  const slashIdx = input.indexOf("/");
  if (slashIdx !== -1) {
    const provider = input.slice(0, slashIdx);
    const modelId = input.slice(slashIdx + 1);
    if (availableSet.has(input.toLowerCase())) {
      const found = registry.find(provider, modelId);
      if (found) return found;
    }
  }

  // 2. Fuzzy match against available models
  const query = input.toLowerCase();
  const best = all
    .map(m => ({ model: m, score: scoreModel(m, query) }))
    .reduce((a, b) => (b.score > a.score ? b : a), { model: undefined as ModelEntry | undefined, score: 0 });

  if (best.model && best.score >= 20) {
    const found = registry.find(best.model.provider, best.model.id);
    if (found) return found;
  }

  // 3. No match — list available models
  const modelList = all
    .map(m => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`;
}
