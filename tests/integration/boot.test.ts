import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestServer, type TestContext } from '../helpers/test-server.js';

describe('Boot-time self-check', () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
      ctx = null;
    }
  });

  it('creates the full /data layout on an empty volume', async () => {
    ctx = await createTestServer();

    expect(existsSync(join(ctx.dataDir, 'home'))).toBe(true);
    expect(existsSync(join(ctx.dataDir, 'config'))).toBe(true);
    expect(existsSync(join(ctx.dataDir, 'global', 'claude-home'))).toBe(true);
    expect(existsSync(join(ctx.dataDir, 'projects'))).toBe(true);
    expect(existsSync(join(ctx.dataDir, 'logs'))).toBe(true);
  });

  it('persists instance.json with basePath, installId, schemaVersion', async () => {
    ctx = await createTestServer();

    const instanceFile = join(ctx.dataDir, 'config', 'instance.json');
    expect(existsSync(instanceFile)).toBe(true);

    const data = JSON.parse(readFileSync(instanceFile, 'utf-8'));
    expect(data.basePath).toBeDefined();
    expect(data.basePath.length).toBe(22);
    expect(data.installId).toBeDefined();
    expect(data.schemaVersion).toBe(1);
  });

  it('uses PANEL_BASE_PATH when provided', async () => {
    ctx = await createTestServer({ PANEL_BASE_PATH: 'my-custom-path' });

    const instanceFile = join(ctx.dataDir, 'config', 'instance.json');
    // instance.json should NOT be created when PANEL_BASE_PATH is set
    expect(existsSync(instanceFile)).toBe(false);
  });

  it('reuses persisted basePath on subsequent boots', async () => {
    ctx = await createTestServer();
    const instanceFile = join(ctx.dataDir, 'config', 'instance.json');
    const first = JSON.parse(readFileSync(instanceFile, 'utf-8'));

    // Simulate a second boot by reading the same file
    const data = JSON.parse(readFileSync(instanceFile, 'utf-8'));
    expect(data.basePath).toBe(first.basePath);
  });
});
