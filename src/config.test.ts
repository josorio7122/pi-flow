import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig, getDefaultConfig } from './config.js';
import type { FlowConfig } from './types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flow-config-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getDefaultConfig', () => {
  it('returns the default concurrency settings', () => {
    const cfg = getDefaultConfig();
    expect(cfg.concurrency.max_parallel).toBe(8);
    expect(cfg.concurrency.max_workers).toBe(4);
    expect(cfg.concurrency.stagger_ms).toBe(150);
  });

  it('returns the default guardrails', () => {
    const cfg = getDefaultConfig();
    expect(cfg.guardrails.token_cap_per_agent).toBe(100000);
    expect(cfg.guardrails.cost_cap_per_agent_usd).toBe(10.0);
    expect(cfg.guardrails.scope_creep_warning).toBe(0.20);
    expect(cfg.guardrails.scope_creep_halt).toBe(0.30);
    expect(cfg.guardrails.loop_detection_window).toBe(10);
    expect(cfg.guardrails.loop_detection_threshold).toBe(3);
    expect(cfg.guardrails.analysis_paralysis_threshold).toBe(8);
    expect(cfg.guardrails.git_watchdog_warn_minutes).toBe(15);
    expect(cfg.guardrails.git_watchdog_halt_minutes).toBe(30);
  });

  it('returns the default memory setting', () => {
    const cfg = getDefaultConfig();
    expect(cfg.memory.enabled).toBe(true);
  });

  it('returns the default git settings', () => {
    const cfg = getDefaultConfig();
    expect(cfg.git.branch_prefix).toBe('feature/');
    expect(cfg.git.commit_style).toBe('conventional');
    expect(cfg.git.auto_pr).toBe(true);
  });

  it('returns a fresh clone each call — mutations do not leak', () => {
    const a = getDefaultConfig();
    const b = getDefaultConfig();
    a.concurrency.max_parallel = 999;
    expect(b.concurrency.max_parallel).toBe(8);
  });
});

describe('loadConfig — no config file', () => {
  it('returns defaults when .flow/config.yaml does not exist', () => {
    const cfg = loadConfig(tmpDir);
    expect(cfg).toEqual(getDefaultConfig());
  });
});

describe('loadConfig — valid config.yaml', () => {
  it('overrides concurrency values from yaml', () => {
    const flowDir = path.join(tmpDir, '.flow');
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(
      path.join(flowDir, 'config.yaml'),
      [
        'concurrency:',
        '  max_parallel: 4',
        '  max_workers: 2',
        '  stagger_ms: 200',
      ].join('\n'),
    );

    const cfg = loadConfig(tmpDir);
    expect(cfg.concurrency.max_parallel).toBe(4);
    expect(cfg.concurrency.max_workers).toBe(2);
    expect(cfg.concurrency.stagger_ms).toBe(200);
  });

  it('overrides guardrail values from yaml', () => {
    const flowDir = path.join(tmpDir, '.flow');
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(
      path.join(flowDir, 'config.yaml'),
      [
        'guardrails:',
        '  token_cap_per_agent: 50000',
        '  cost_cap_per_agent_usd: 5.0',
        '  scope_creep_warning: 0.15',
        '  scope_creep_halt: 0.25',
        '  loop_detection_window: 5',
        '  loop_detection_threshold: 2',
        '  analysis_paralysis_threshold: 6',
        '  git_watchdog_warn_minutes: 10',
        '  git_watchdog_halt_minutes: 20',
      ].join('\n'),
    );

    const cfg = loadConfig(tmpDir);
    expect(cfg.guardrails.token_cap_per_agent).toBe(50000);
    expect(cfg.guardrails.cost_cap_per_agent_usd).toBe(5.0);
    expect(cfg.guardrails.scope_creep_warning).toBe(0.15);
    expect(cfg.guardrails.scope_creep_halt).toBe(0.25);
    expect(cfg.guardrails.loop_detection_window).toBe(5);
    expect(cfg.guardrails.loop_detection_threshold).toBe(2);
    expect(cfg.guardrails.analysis_paralysis_threshold).toBe(6);
    expect(cfg.guardrails.git_watchdog_warn_minutes).toBe(10);
    expect(cfg.guardrails.git_watchdog_halt_minutes).toBe(20);
  });

  it('overrides memory.enabled from yaml', () => {
    const flowDir = path.join(tmpDir, '.flow');
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(
      path.join(flowDir, 'config.yaml'),
      ['memory:', '  enabled: false'].join('\n'),
    );

    const cfg = loadConfig(tmpDir);
    expect(cfg.memory.enabled).toBe(false);
  });

  it('overrides git settings from yaml', () => {
    const flowDir = path.join(tmpDir, '.flow');
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(
      path.join(flowDir, 'config.yaml'),
      [
        'git:',
        '  branch_prefix: "bugfix/"',
        '  commit_style: simple',
        '  auto_pr: false',
      ].join('\n'),
    );

    const cfg = loadConfig(tmpDir);
    expect(cfg.git.branch_prefix).toBe('bugfix/');
    expect(cfg.git.commit_style).toBe('simple');
    expect(cfg.git.auto_pr).toBe(false);
  });

  it('keeps defaults for sections not present in yaml', () => {
    const flowDir = path.join(tmpDir, '.flow');
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(
      path.join(flowDir, 'config.yaml'),
      ['memory:', '  enabled: false'].join('\n'),
    );

    const cfg = loadConfig(tmpDir);
    // memory was overridden
    expect(cfg.memory.enabled).toBe(false);
    // concurrency should still be default
    expect(cfg.concurrency.max_parallel).toBe(8);
  });
});

describe('loadConfig — malformed config.yaml', () => {
  it('returns defaults when yaml is invalid', () => {
    const flowDir = path.join(tmpDir, '.flow');
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(
      path.join(flowDir, 'config.yaml'),
      'this is not valid yaml: [[[',
    );

    const cfg = loadConfig(tmpDir);
    expect(cfg).toEqual(getDefaultConfig());
  });
});
