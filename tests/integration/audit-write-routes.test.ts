import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createTestServer } from '../helpers/test-server.js';

const UNAUDITED_WRITES = new Set(['PATCH /api/settings/locale']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);

type SourceRoute = { method: string; url: string; audits: boolean };

function sourceRoutes(): SourceRoute[] {
  const directory = join(process.cwd(), 'src/server/routes');
  const routes: SourceRoute[] = [];
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.ts'))) {
    const source = ts.createSourceFile(
      file,
      readFileSync(join(directory, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'app' &&
        METHODS.has(node.expression.name.text.toUpperCase()) &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const method = node.expression.name.text.toUpperCase();
        const handler = node.arguments[node.arguments.length - 1];
        let audits = false;
        if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
          const inspect = (child: ts.Node): void => {
            if (
              ts.isCallExpression(child) &&
              ts.isPropertyAccessExpression(child.expression) &&
              child.expression.name.text === 'write' &&
              ts.isPropertyAccessExpression(child.expression.expression) &&
              child.expression.expression.name.text === 'audit'
            ) audits = true;
            ts.forEachChild(child, inspect);
          };
          inspect(handler);
        }
        routes.push({ method, url: node.arguments[0].text, audits });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return routes;
}

describe('write routes have audit coverage or the pinned locale exemption', () => {
  it('derives writes from Fastify registrations and checks each handler', async () => {
    const registered: { method: string; url: string }[] = [];
    const ctx = await createTestServer({}, {
      routeObserver: (method, url) => registered.push({ method, url }),
    });
    try {
      const actualWrites = registered.filter(
        ({ method, url }) => !SAFE_METHODS.has(method) && url.includes('/api/'),
      );
      const routes = sourceRoutes();
      const exemptions = [...UNAUDITED_WRITES].sort();
      expect(exemptions).toEqual(['PATCH /api/settings/locale']);

      for (const route of actualWrites) {
        const suffix = route.url.slice(route.url.indexOf('/api/'));
        const key = `${route.method} ${suffix}`;
        if (UNAUDITED_WRITES.has(key)) continue;
        const source = routes.find((candidate) =>
          candidate.method === route.method && candidate.url === suffix,
        );
        expect(source, `registered write ${key} must have a source handler`).toBeDefined();
        expect(source?.audits, `registered write ${key} must call runtime.audit.write`).toBe(true);
      }
    } finally {
      await ctx.cleanup();
    }
  });
});
