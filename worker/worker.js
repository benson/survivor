const ALLOWED_ORIGINS = ['https://bensonperry.com', 'https://www.bensonperry.com', 'http://localhost:8080', 'http://127.0.0.1:8080'];

function getCorsOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': getCorsOrigin(request),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function json(data, status, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

function isAuthorized(request, env) {
  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${env.ADMIN_SECRET}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }

    // POST /picks — submit picks
    if (request.method === 'POST' && path === '/picks') {
      try {
        const body = await request.json();
        const { season, name, picks, alternates } = body;

        if (!season || !name || !picks || !Array.isArray(picks)) {
          return json({ error: 'missing required fields: season, name, picks' }, 400, request);
        }

        const config = await env.DATA.get(`config:${season}`, 'json');
        if (config) {
          if (config.deadline && new Date() >= new Date(config.deadline)) {
            return json({ error: 'submissions are closed' }, 403, request);
          }
          if (config.open === false) {
            return json({ error: 'submissions are not open' }, 403, request);
          }
          if (config.contestants) {
            const valid = new Set(config.contestants);
            const allPicks = [...picks, ...(alternates || [])];
            const invalid = allPicks.filter(p => !valid.has(p));
            if (invalid.length > 0) {
              return json({ error: `invalid contestants: ${invalid.join(', ')}` }, 400, request);
            }
          }
        }

        const key = `picks:${season}`;
        let existing = await env.DATA.get(key, 'json') || [];
        const playerName = name.trim().toLowerCase();

        existing = existing.filter(p => p.name !== playerName);
        existing.push({
          name: playerName,
          picks,
          alternates: alternates || [],
          submittedAt: new Date().toISOString(),
        });

        await env.DATA.put(key, JSON.stringify(existing));
        return json({ ok: true, message: `picks submitted for ${playerName}` }, 200, request);
      } catch (e) {
        return json({ error: 'invalid request body' }, 400, request);
      }
    }

    // GET /picks/:season — get all picks
    if (request.method === 'GET' && path.startsWith('/picks/')) {
      const season = path.split('/')[2];
      if (!season) return json({ error: 'season required' }, 400, request);

      const picks = await env.DATA.get(`picks:${season}`, 'json') || [];
      const config = await env.DATA.get(`config:${season}`, 'json') || {};
      return json({ picks, config }, 200, request);
    }

    // POST /admin/config — set config (auth required)
    if (request.method === 'POST' && path === '/admin/config') {
      if (!isAuthorized(request, env)) return json({ error: 'unauthorized' }, 401, request);

      try {
        const body = await request.json();
        const { season, ...config } = body;
        if (!season) return json({ error: 'season required' }, 400, request);

        const key = `config:${season}`;
        const existing = await env.DATA.get(key, 'json') || {};
        const merged = { ...existing, ...config };
        await env.DATA.put(key, JSON.stringify(merged));
        return json({ ok: true, config: merged }, 200, request);
      } catch (e) {
        return json({ error: 'invalid request body' }, 400, request);
      }
    }

    // POST /admin/delete-pick — remove a submission by name
    if (request.method === 'POST' && path === '/admin/delete-pick') {
      if (!isAuthorized(request, env)) return json({ error: 'unauthorized' }, 401, request);

      try {
        const { season, name } = await request.json();
        if (!season || !name) return json({ error: 'season and name required' }, 400, request);

        const key = `picks:${season}`;
        let picks = await env.DATA.get(key, 'json') || [];
        picks = picks.filter(p => p.name !== name);
        await env.DATA.put(key, JSON.stringify(picks));
        return json({ ok: true, remaining: picks.length }, 200, request);
      } catch (e) {
        return json({ error: 'invalid request body' }, 400, request);
      }
    }

    // GET /admin/export/:season — export picks for committing
    if (request.method === 'GET' && path.startsWith('/admin/export/')) {
      if (!isAuthorized(request, env)) return json({ error: 'unauthorized' }, 401, request);

      const season = path.split('/')[3];
      if (!season) return json({ error: 'season required' }, 400, request);

      const picks = await env.DATA.get(`picks:${season}`, 'json') || [];
      const clean = picks.map(({ name, picks: p, alternates }) => ({ name, picks: p, alternates }));
      return json(clean, 200, request);
    }

    return json({ error: 'not found' }, 404, request);
  },
};
