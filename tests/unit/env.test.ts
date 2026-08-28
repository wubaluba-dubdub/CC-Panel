import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../src/server/env.js';

describe('loadEnv', () => {
  const validEnv = {
    PANEL_MASTER_KEY: Buffer.from('a'.repeat(32)).toString('base64'),
    PANEL_ADMIN_USERNAME: 'admin',
    PANEL_ADMIN_PASSWORD: 'correct-horse-battery-staple',
  };

  it('accepts valid env', () => {
    const original = { ...process.env };
    Object.assign(process.env, validEnv);
    try {
      const env = loadEnv();
      expect(env.PANEL_ADMIN_USERNAME).toBe('admin');
      expect(env.PANEL_TRUST_PROXY).toBe(true);
      expect(env.PORT).toBe(3000);
    } finally {
      process.env = original;
    }
  });

  it('rejects missing PANEL_MASTER_KEY', () => {
    const original = { ...process.env };
    delete process.env.PANEL_MASTER_KEY;
    Object.assign(process.env, {
      PANEL_ADMIN_USERNAME: 'admin',
      PANEL_ADMIN_PASSWORD: 'correct-horse-battery-staple',
    });
    try {
      expect(() => loadEnv()).toThrow();
    } finally {
      process.env = original;
    }
  });

  it('rejects master key under 32 bytes', () => {
    const original = { ...process.env };
    Object.assign(process.env, {
      ...validEnv,
      PANEL_MASTER_KEY: Buffer.from('short').toString('base64'),
    });
    try {
      expect(() => loadEnv()).toThrow(/32 bytes/);
    } finally {
      process.env = original;
    }
  });

  it('rejects password under 12 chars', () => {
    const original = { ...process.env };
    Object.assign(process.env, {
      ...validEnv,
      PANEL_ADMIN_PASSWORD: 'short',
    });
    try {
      expect(() => loadEnv()).toThrow(/12 characters/);
    } finally {
      process.env = original;
    }
  });

  it('rejects weak password from built-in list', () => {
    const original = { ...process.env };
    Object.assign(process.env, {
      ...validEnv,
      PANEL_ADMIN_PASSWORD: 'password123456',
    });
    try {
      expect(() => loadEnv()).toThrow(/weak/);
    } finally {
      process.env = original;
    }
  });

  it('parses PANEL_TRUST_PROXY=false', () => {
    const original = { ...process.env };
    Object.assign(process.env, { ...validEnv, PANEL_TRUST_PROXY: 'false' });
    try {
      const env = loadEnv();
      expect(env.PANEL_TRUST_PROXY).toBe(false);
    } finally {
      process.env = original;
    }
  });
});
