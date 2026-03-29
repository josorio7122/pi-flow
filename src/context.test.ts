import { describe, it, expect } from 'vitest';
import { extractText, buildParentContext, getAgentConversation } from './context.js';

describe('extractText', () => {
  it('extracts text from content blocks', () => {
    const content = [
      { type: 'text', text: 'Hello' },
      { type: 'toolCall', name: 'read' },
      { type: 'text', text: 'World' },
    ];
    expect(extractText(content)).toBe('Hello\nWorld');
  });

  it('returns empty string for no text blocks', () => {
    expect(extractText([{ type: 'toolCall' }])).toBe('');
    expect(extractText([])).toBe('');
  });
});

describe('buildParentContext', () => {
  it('builds context from conversation branch', () => {
    const ctx = {
      sessionManager: {
        getBranch: () => [
          { type: 'message', message: { role: 'user', content: 'Build auth module' } },
          {
            type: 'message',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'I will scout the codebase first.' }],
            },
          },
        ],
      },
    };

    const result = buildParentContext(ctx);
    expect(result).toContain('Parent Conversation Context');
    expect(result).toContain('[User]: Build auth module');
    expect(result).toContain('[Assistant]: I will scout the codebase first.');
    expect(result).toContain('Your Task (below)');
  });

  it('includes compaction summaries', () => {
    const ctx = {
      sessionManager: {
        getBranch: () => [
          { type: 'compaction', summary: 'Previously discussed auth design.' },
          { type: 'message', message: { role: 'user', content: 'Continue' } },
        ],
      },
    };

    const result = buildParentContext(ctx);
    expect(result).toContain('[Summary]: Previously discussed auth design.');
  });

  it('returns empty string for empty branch', () => {
    const ctx = { sessionManager: { getBranch: () => [] } };
    expect(buildParentContext(ctx)).toBe('');
  });
});

describe('getAgentConversation', () => {
  it('formats a conversation transcript', () => {
    const messages = [
      { role: 'user', content: 'Find auth files' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I found 3 auth files.' },
          { type: 'toolCall', name: 'find' },
        ],
      },
      { role: 'toolResult', content: [{ type: 'text', text: 'src/auth.ts\nsrc/auth.test.ts' }] },
    ];

    const result = getAgentConversation(messages);
    expect(result).toContain('[User]: Find auth files');
    expect(result).toContain('[Assistant]: I found 3 auth files.');
    expect(result).toContain('[Tool Calls]:');
    expect(result).toContain('Tool: find');
    expect(result).toContain('[Tool Result]: src/auth.ts');
  });

  it('truncates long tool results', () => {
    const longText = 'x'.repeat(300);
    const messages = [{ role: 'toolResult', content: [{ type: 'text', text: longText }] }];

    const result = getAgentConversation(messages);
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(300);
  });
});
