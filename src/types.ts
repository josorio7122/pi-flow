// Phase type — 7 phases of the pi-flow state machine
export type Phase = 'intent' | 'spec' | 'analyze' | 'plan' | 'execute' | 'review' | 'ship';

// Agent config parsed from .md frontmatter
export interface FlowAgentConfig {
  name: string;
  label: string;
  description: string;
  model: string;
  thinking: string;
  tools: string[];
  phases: Phase[];
  writable: boolean;
  temperament: string;
  limits: { max_tokens: number; max_steps: number };
  variables: string[];
  systemPrompt: string;  // markdown body after frontmatter
  source: 'builtin' | 'custom';
  filePath: string;
}

// Flow state from state.md frontmatter
export interface FlowState {
  feature: string;
  change_type: 'feature' | 'refactor' | 'hotfix' | 'docs' | 'config' | 'research';
  current_phase: Phase;
  current_wave: number | null;
  wave_count: number | null;
  skipped_phases: Phase[];
  started_at: string;
  last_updated: string;
  budget: { total_tokens: number; total_cost_usd: number };
  gates: { spec_approved: boolean; design_approved: boolean; review_verdict: string | null };
  sentinel: { open_halts: number; open_warns: number };
}

// Config from config.yaml (§14 S1 simplified schema — no model overrides)
export interface FlowConfig {
  concurrency: { max_parallel: number; max_workers: number; stagger_ms: number };
  guardrails: {
    token_cap_per_agent: number;
    cost_cap_per_agent_usd: number;
    scope_creep_warning: number;
    scope_creep_halt: number;
    loop_detection_window: number;
    loop_detection_threshold: number;
    analysis_paralysis_threshold: number;
    git_watchdog_warn_minutes: number;
    git_watchdog_halt_minutes: number;
  };
  memory: { enabled: boolean };
  git: { branch_prefix: string; commit_style: string; auto_pr: boolean };
}

// Gate check result
export interface GateResult {
  canAdvance: boolean;
  reason: string;
}

// Single agent execution result
export interface SingleAgentResult {
  agent: string;
  agentSource: 'builtin' | 'custom';
  task: string;
  exitCode: number;
  messages: any[];  // pi Message type
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;      // for chain mode
  startedAt?: number; // epoch ms when agent was spawned — used for elapsed display
}

// Usage stats
export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

// Dispatch details stored in tool result
export interface FlowDispatchDetails {
  mode: 'single' | 'parallel' | 'chain';
  phase: Phase;
  feature: string;
  results: SingleAgentResult[];
}


