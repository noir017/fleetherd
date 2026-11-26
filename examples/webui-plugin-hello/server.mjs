// Example server plugin for fleetherd Web UI.
// Registers GET /api/plugins/hello/ping, persists a ping counter, and pushes SSE updates.

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  res.end(body);
}

/**
 * @param {import('../../dist/webui-plugin.d.ts').PluginHost} host
 */
export async function activate(host) {
  const cfg = host.config && typeof host.config === 'object' ? host.config : {};
  const greeting = typeof cfg.greeting === 'string' && cfg.greeting.trim()
    ? cfg.greeting.trim()
    : 'Hello from plugin';

  const saved = await host.storage.read();
  let count = saved && typeof saved === 'object' && typeof saved.count === 'number'
    ? saved.count
    : 0;

  host.routes.get('/ping', async (_req, res) => {
    count += 1;
    const payload = {
      ok: true,
      id: host.id,
      greeting,
      count,
      topics: host.topics.list().length,
      now: new Date().toISOString(),
    };
    await host.storage.write({ count });
    host.events.push('ping', { count, greeting, now: payload.now });
    sendJson(res, 200, payload);
  });

  host.log(`ready (greeting="${greeting}", count=${count})`);
}

export function deactivate() {
  // Subscriptions and routes registered via host are cleaned up automatically.
}
