import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

interface BasePathOptions {
  basePath: string;
}

const basePathPlugin: FastifyPluginAsync<BasePathOptions> = async (fastify, opts) => {
  const { basePath } = opts;

  // Register a scoped plugin that all app routes will be registered under
  await fastify.register(
    async (scopedApp) => {
      // Placeholder route for Phase 2
      scopedApp.get('/', async (_req, reply) => {
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Panel Shell</title>
</head>
<body>
  <h1>Panel shell — Phase 2</h1>
  <script>
    window.__BASE__ = "/${basePath}";
  </script>
</body>
</html>`;
        return reply.type('text/html').send(html);
      });

      // Decorate the scoped app with basePath for use by other plugins
      scopedApp.decorate('basePath', basePath);
    },
    { prefix: `/${basePath}` }
  );
};

export default fp(basePathPlugin, {
  name: 'base-path',
});
