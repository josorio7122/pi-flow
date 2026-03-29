// ─── Agent config parsed from .md frontmatter ────────────────────────────────

export interface FlowAgentConfig {
  name: string;
  label: string;
  description: string;
  model: string;
  thinking: string;
  tools: string[];
  writable: boolean;
  limits: { max_tokens: number; max_steps: number };
  variables: string[];
  writes: string[];
  systemPrompt: string; // markdown body after frontmatter
  source: 'builtin' | 'custom';
  filePath: string;
  /** Persistent memory scope — agents with memory get a MEMORY.md directory */
  memory?: 'project' | 'global' | 'local';
  /** Isolation mode — "worktree" runs the agent in a temporary git worktree */
  isolation?: 'worktree';
  /** Whether this agent is enabled (disabled agents are hidden from dispatch) */
  enabled?: boolean;
  /** Tool denylist — these tools are removed even if the agent's tools list includes them */
  disallowedTools?: string[];
  /** Default: fork parent conversation context into agent */
  inheritContext?: boolean;
  /** Default: run in background */
  runInBackground?: boolean;
  /** Default: no extension tools */
  isolated?: boolean;
  /** Extension inheritance: true = all, string[] = listed, false = none */
  extensions?: true | string[] | false;
  /** Skill inheritance: true = all, string[] = listed, false = none */
  skills?: true | string[] | false;
  /** Prompt mode: replace (standalone) or append (inherit parent identity) */
  promptMode?: 'replace' | 'append';
}

// ─── Skill config parsed from .md frontmatter ────────────────────────────────

export interface FlowSkillConfig {
  name: string;
  description: string;
  body: string; // markdown body after frontmatter
  source: 'builtin' | 'custom';
  filePath: string;
}

// ─── Flow state — just feature + budget ───────────────────────────────────────

export interface FlowState {
  feature: string;
  started_at: string;
  last_updated: string;
  budget: { total_tokens: number; total_cost_usd: number };
}

// ─── Session state — per-process isolation ────────────────────────────────────

export interface SessionState {
  session_id: string;
  started_at: string;
  last_updated: string;
  feature: string | null; // null = featureless (ad-hoc scouting)
  budget: { total_tokens: number; total_cost_usd: number };
}

// ─── Config from config.yaml ──────────────────────────────────────────────────

export interface FlowConfig {
  concurrency: { max_parallel: number; max_workers: number; stagger_ms: number };
  guardrails: {
    loop_detection_window: number;
    loop_detection_threshold: number;
  };
}

// ─── Dispatch types ───────────────────────────────────────────────────────────

export interface DispatchParams {
  agent?: string;
  task?: string;
  parallel?: Array<{ agent: string; task: string }>;
  chain?: Array<{ agent: string; task: string }>;
  feature?: string;
  sessionDir?: string;
  /** Extension context — required for in-process agent execution */
  ctx?: unknown;
  /** Run agents in background — returns IDs immediately */
  background?: boolean;
  /** Model override (exact "provider/modelId" or fuzzy "haiku", "sonnet") */
  model?: string;
  /** Thinking level override */
  thinking?: string;
  /** Max turns override */
  max_turns?: number;
  /** Isolated mode override (no extension tools) */
  isolated?: boolean;
  /** Isolation mode override */
  isolation?: 'worktree';
  /** Fork parent conversation context into agent */
  inherit_context?: boolean;
}

export interface DispatchResult {
  content: Array<{ type: 'text'; text: string }>;
  details: FlowDispatchDetails;
  isError?: boolean;
}

// ─── Execution types ──────────────────────────────────────────────────────────

export interface SingleAgentResult {
  agent: string;
  agentSource: 'builtin' | 'custom';
  task: string;
  exitCode: number;
  messages: Record<string, unknown>[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  startedAt?: number;
  /** Branch name if agent ran in a worktree and made changes */
  worktreeBranch?: string;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface FlowDispatchDetails {
  mode: 'single' | 'parallel' | 'chain';
  feature: string;
  results: SingleAgentResult[];
}
