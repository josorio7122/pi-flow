import { describe, it, expect } from 'vitest';
import {
  getArtifactTemplate,
  renderArtifactTemplate,
  getApprovalFrontmatterExample,
  ARTIFACT_NAMES,
} from './templates.js';

describe('getArtifactTemplate', () => {
  it('returns a template for spec.md', () => {
    const tpl = getArtifactTemplate('spec');
    expect(tpl).toContain('---');
    expect(tpl).toContain('approved: false');
    expect(tpl).toContain('feature:');
  });

  it('returns a template for design.md', () => {
    const tpl = getArtifactTemplate('design');
    expect(tpl).toContain('---');
    expect(tpl).toContain('approved: false');
    expect(tpl).toContain('feature:');
  });

  it('returns a template for tasks.md', () => {
    const tpl = getArtifactTemplate('tasks');
    expect(tpl).toContain('---');
    expect(tpl).toContain('wave_count:');
  });

  it('returns a template for sentinel-log.md', () => {
    const tpl = getArtifactTemplate('sentinel-log');
    expect(tpl).toContain('open_halts: 0');
    expect(tpl).toContain('open_warns: 0');
  });

  it('returns a template for review.md with valid verdict values', () => {
    const tpl = getArtifactTemplate('review');
    expect(tpl).toContain('verdict:');
    expect(tpl).toContain('PASSED');
    expect(tpl).toContain('FAILED');
  });

  it('returns null for unknown artifact', () => {
    expect(getArtifactTemplate('unknown')).toBeNull();
  });
});

describe('renderArtifactTemplate', () => {
  it('replaces feature placeholder in spec template', () => {
    const rendered = renderArtifactTemplate('spec', 'auth-refresh');
    expect(rendered).toContain('feature: auth-refresh');
    expect(rendered).not.toContain('{{FEATURE_NAME}}');
  });

  it('replaces feature placeholder in design template', () => {
    const rendered = renderArtifactTemplate('design', 'auth-refresh');
    expect(rendered).toContain('feature: auth-refresh');
  });

  it('replaces feature placeholder in tasks template', () => {
    const rendered = renderArtifactTemplate('tasks', 'auth-refresh');
    expect(rendered).toContain('feature: auth-refresh');
  });

  it('replaces feature placeholder in review template', () => {
    const rendered = renderArtifactTemplate('review', 'auth-refresh');
    expect(rendered).toContain('feature: auth-refresh');
  });

  it('returns sentinel-log template without feature placeholder', () => {
    const rendered = renderArtifactTemplate('sentinel-log', 'auth-refresh');
    expect(rendered).toContain('open_halts: 0');
    expect(rendered).not.toContain('auth-refresh');
  });

  it('returns null for unknown artifact', () => {
    expect(renderArtifactTemplate('unknown', 'feat')).toBeNull();
  });
});

describe('getApprovalFrontmatterExample', () => {
  it('returns a string showing the exact approved: true format', () => {
    const example = getApprovalFrontmatterExample();
    expect(example).toContain('---');
    expect(example).toContain('approved: true');
  });

  it('does not contain yes or YES', () => {
    const example = getApprovalFrontmatterExample();
    expect(example).not.toMatch(/\byes\b/i);
  });
});

describe('ARTIFACT_NAMES', () => {
  it('includes all gate artifact names', () => {
    expect(ARTIFACT_NAMES).toContain('spec');
    expect(ARTIFACT_NAMES).toContain('design');
    expect(ARTIFACT_NAMES).toContain('tasks');
    expect(ARTIFACT_NAMES).toContain('sentinel-log');
    expect(ARTIFACT_NAMES).toContain('review');
  });
});
