import { describe, it, expect } from 'vitest';
import { resolveModel } from './model-resolver.js';

const MODELS = [
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic' },
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', provider: 'anthropic' },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
];

function makeRegistry(available = MODELS) {
  return {
    find: (provider: string, modelId: string) =>
      MODELS.find((m) => m.provider === provider && m.id === modelId) ?? undefined,
    getAll: () => MODELS,
    getAvailable: () => available,
  };
}

describe('resolveModel', () => {
  it('resolves exact provider/modelId', () => {
    const result = resolveModel('anthropic/claude-sonnet-4-6', makeRegistry());
    expect(result).toEqual(MODELS[0]);
  });

  it('fuzzy resolves "haiku" to claude-haiku', () => {
    const result = resolveModel('haiku', makeRegistry());
    expect(result).toEqual(MODELS[1]);
  });

  it('fuzzy resolves "sonnet" to claude-sonnet', () => {
    const result = resolveModel('sonnet', makeRegistry());
    expect(result).toEqual(MODELS[0]);
  });

  it('fuzzy resolves "opus" to claude-opus', () => {
    const result = resolveModel('opus', makeRegistry());
    expect(result).toEqual(MODELS[2]);
  });

  it('fuzzy resolves "gpt" to gpt-4o', () => {
    const result = resolveModel('gpt', makeRegistry());
    expect(result).toEqual(MODELS[3]);
  });

  it('returns error string when model not found', () => {
    const result = resolveModel('nonexistent-model', makeRegistry());
    expect(typeof result).toBe('string');
    expect(result as string).toContain('Model not found');
    expect(result as string).toContain('Available models');
  });

  it('only resolves available models', () => {
    // Only haiku is available
    const registry = makeRegistry([MODELS[1]]);
    const result = resolveModel('sonnet', registry);
    // sonnet not available — should fail
    expect(typeof result).toBe('string');
  });

  it('exact match requires availability', () => {
    const registry = makeRegistry([]); // nothing available
    const result = resolveModel('anthropic/claude-sonnet-4-6', registry);
    expect(typeof result).toBe('string');
  });

  it('prefers exact id match over substring', () => {
    const result = resolveModel('claude-sonnet-4-6', makeRegistry());
    expect(result).toEqual(MODELS[0]);
  });

  it('handles multi-word fuzzy queries', () => {
    const result = resolveModel('claude haiku', makeRegistry());
    expect(result).toEqual(MODELS[1]);
  });
});
