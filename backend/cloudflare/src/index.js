const DOCUMENT_ID = 'main';
const MAX_BODY_BYTES = 2_000_000;

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const defaults = [
    'https://1004zxq.github.io',
    'http://127.0.0.1:8890',
    'http://localhost:8890',
  ];
  const allowed = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean)
    : defaults;
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  };
}

function json(request, env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request, env),
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function equalStrings(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

async function authorized(request, env) {
  if (!env.SYNC_TOKEN_HASH) return false;
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return false;
  return equalStrings(await sha256(token), env.SYNC_TOKEN_HASH.toLowerCase());
}

function validPayload(body) {
  return body &&
    typeof body.ciphertext === 'string' &&
    body.ciphertext.length > 0 &&
    body.ciphertext.length < MAX_BODY_BYTES &&
    typeof body.iv === 'string' &&
    /^[A-Za-z0-9_-]{12,32}$/.test(body.iv) &&
    Number.isSafeInteger(body.baseRevision) &&
    body.baseRevision >= 0 &&
    Number.isSafeInteger(body.clientUpdatedAt) &&
    body.clientUpdatedAt > 0;
}

function recordResponse(record) {
  return {
    ciphertext: record.ciphertext,
    iv: record.iv,
    revision: Number(record.revision),
    clientUpdatedAt: Number(record.client_updated_at),
    updatedAt: Number(record.updated_at),
  };
}

async function getRecord(env) {
  return env.DB.prepare(
    `SELECT ciphertext, iv, revision, client_updated_at, updated_at
     FROM documents WHERE id = ?`
  ).bind(DOCUMENT_ID).first();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (url.pathname === '/health') {
      return json(request, env, {
        ok: true,
        service: 'zhiqing-sync',
        configured: Boolean(env.SYNC_TOKEN_HASH && env.DB),
      });
    }

    if (url.pathname !== '/api/sync') {
      return json(request, env, { error: 'not_found' }, 404);
    }

    if (!(await authorized(request, env))) {
      return json(request, env, { error: 'unauthorized' }, 401);
    }

    if (request.method === 'GET') {
      const record = await getRecord(env);
      if (!record) return json(request, env, { empty: true, revision: 0 });
      return json(request, env, { ok: true, document: recordResponse(record) });
    }

    if (request.method !== 'PUT') {
      return json(request, env, { error: 'method_not_allowed' }, 405);
    }

    const declaredLength = Number(request.headers.get('Content-Length') || '0');
    if (declaredLength > MAX_BODY_BYTES) {
      return json(request, env, { error: 'body_too_large' }, 413);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json(request, env, { error: 'bad_json' }, 400);
    }
    if (!validPayload(body)) {
      return json(request, env, { error: 'bad_payload' }, 400);
    }

    const now = Date.now();
    const current = await getRecord(env);
    if (!current) {
      if (body.baseRevision !== 0) {
        return json(request, env, { error: 'conflict', revision: 0 }, 409);
      }
      try {
        await env.DB.prepare(
          `INSERT INTO documents
            (id, ciphertext, iv, revision, client_updated_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?)`
        ).bind(DOCUMENT_ID, body.ciphertext, body.iv, body.clientUpdatedAt, now).run();
      } catch {
        const latest = await getRecord(env);
        return json(request, env, {
          error: 'conflict',
          revision: latest ? Number(latest.revision) : 0,
        }, 409);
      }
      return json(request, env, {
        ok: true,
        revision: 1,
        updatedAt: now,
      });
    }

    if (Number(current.revision) !== body.baseRevision) {
      return json(request, env, {
        error: 'conflict',
        revision: Number(current.revision),
      }, 409);
    }

    const result = await env.DB.prepare(
      `UPDATE documents
       SET ciphertext = ?, iv = ?, revision = revision + 1,
           client_updated_at = ?, updated_at = ?
       WHERE id = ? AND revision = ?`
    ).bind(
      body.ciphertext,
      body.iv,
      body.clientUpdatedAt,
      now,
      DOCUMENT_ID,
      body.baseRevision
    ).run();

    if (!result.meta || result.meta.changes !== 1) {
      const latest = await getRecord(env);
      return json(request, env, {
        error: 'conflict',
        revision: latest ? Number(latest.revision) : 0,
      }, 409);
    }

    return json(request, env, {
      ok: true,
      revision: body.baseRevision + 1,
      updatedAt: now,
    });
  },
};
