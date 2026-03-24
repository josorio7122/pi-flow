import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { loadConfig, getDefaultConfig } from './config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flow-config-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getDefaultConfig', () => {
  it('returns concurrency defaults', () => {
    const config = getDefaultConfig();
    expect(config.concurrency.max_workers).toBe(4);
    expect(config.concurrency.max_parallel).toBe(8);
    expect(config.concurrency.stagger_ms).toBe(150);
  });

  it('returns guardrails defaults', () => {
    const config = getDefaultConfig();
    expect(config.guardrails.loop_detection_window).toBe(10);
    expect(config.guardrails.loop_detection_threshold).toBe(3);
  });

  it('returns independent copies', () => {
    const a = getDefaultConfig();
    const b = getDefaultConfig();
    a.concurrency.max_workers = 99;
    expect(b.concurrency.max_workers).toBe(4);
  });
});

describe('loadConfig', () => {
  it('returns defaults when .flow/config.yaml does not exist', () => {
    const config = loadConfig(tmpDir);
    expect(config).toEqual(getDefaultConfig());
  });

  it('overrides specific values from config.yaml', () => {
    const flowDir = path.join(tmpDir, '.flow');
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(
      path.join(flowDir, 'config.yaml'),
      `concurrency:
  max_workers: 2
`,
    );

    const config = loadConfig(tmpDir);
    expect(config.concurrency.max_workers).toBe(2);
    expect(config.concurrency.max_parallel).toBe(8); // default preserved
  });

  it('ignores unknown keys', () => {
    const flowDir = path.join(tmpDir, '.flow');
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(
      path.join(flowDir, 'config.yaml'),
      `concurrency:
  max_workers: 2
  unknown_key: 999
`,
    );

    const config = loadConfig(tmpDir);
    expect(config.concurrency.max_workers).toBe(2);
    expect((config.concurrency as Record<string, unknown>)['unknown_key']).toBeUndefined();
  });

  it('returns defaults on malformed YAML', () => {
    const flowDir = path.join(tmpDir, '.flow');
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(flowDir, 'config.yaml'), ':::invalid:::');

    const config = loadConfig(tmpDir);
    expect(config).toEqual(getDefaultConfig());
  });

  it('handles comments in YAML', () => {
    const flowDir = path.join(tmpDir, '.flow');
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(
      path.join(flowDir, 'config.yaml'),
      `# Pi-flow config
concurrency:
  max_workers: 6 # override default
`,
    );

    const config = loadConfig(tmpDir);
    expect(config.concurrency.max_workers).toBe(6);
  });
});
