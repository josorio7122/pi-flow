/**
 * context.ts — Extract parent conversation context for agent inheritance.
 *
 * When `inheritContext` is true, the agent gets a text summary of the
 * coordinator's conversation so far.
 */

/**
 * Extract text from a message content block array.
 */
export function extractText(content: unknown[]): string {
  return content
    .filter((c) => (c as Record<string, unknown>).type === 'text')
    .map((c) => ((c as Record<string, unknown>).text as string) ?? '')
    .join('\n');
}

/**
 * Build a text representation of the parent conversation context.
 * Used when inheritContext is true to give the agent visibility
 * into what has been discussed/done so far.
 */
export function buildParentContext(ctx: {
  sessionManager: {
    getBranch(): Array<{ type: string; message?: Record<string, unknown>; summary?: string }>;
  };
}): string {
  const entries = ctx.sessionManager.getBranch();
  if (!entries || entries.length === 0) return '';

  const parts: string[] = [];

  for (const entry of entries) {
    if (entry.type === 'message') {
      const msg = entry.message;
      if (!msg) continue;
      if (msg.role === 'user') {
        const text =
          typeof msg.content === 'string' ? msg.content : extractText(msg.content as unknown[]);
        if (typeof text === 'string' && text.trim()) parts.push(`[User]: ${text.trim()}`);
      } else if (msg.role === 'assistant') {
        const text = extractText(msg.content as unknown[]);
        if (text.trim()) parts.push(`[Assistant]: ${text.trim()}`);
      }
    } else if (entry.type === 'compaction') {
      if (entry.summary) {
        parts.push(`[Summary]: ${entry.summary}`);
      }
    }
  }

  if (parts.length === 0) return '';

  return `# Parent Conversation Context
The following is the conversation history from the parent session that spawned you.
Use this context to understand what has been discussed and decided so far.

${parts.join('\n\n')}

---
# Your Task (below)
`;
}

/**
 * Get a formatted transcript of an agent's conversation messages.
 */
export function getAgentConversation(messages: Array<{ role: string; content: unknown }>): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const text =
        typeof msg.content === 'string' ? msg.content : extractText(msg.content as unknown[]);
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const c of msg.content as Array<Record<string, unknown>>) {
        if (c.type === 'text' && c.text) textParts.push(c.text as string);
        else if (c.type === 'toolCall')
          toolCalls.push(`  Tool: ${(c.name as string) ?? 'unknown'}`);
      }
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join('\n')}`);
      if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join('\n')}`);
    } else if (msg.role === 'toolResult') {
      const text = extractText(msg.content as unknown[]);
      const truncated = text.length > 200 ? text.slice(0, 200) + '...' : text;
      parts.push(`[Tool Result]: ${truncated}`);
    }
  }

  return parts.join('\n\n');
}
