'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const rdb = app.rdb();
const DOCUMENT_ID = 'main';
const MAX_BODY_BYTES = 2_000_000;

function corsHeaders(event) {
  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin || '';
  const allowed = [
    'https://1004zxq.github.io',
    'http://127.0.0.1:8890',
    'http://localhost:8890'
  ];
  const trustedCloudBaseOrigin = origin.endsWith('.tcloudbaseapp.com') ||
    origin.endsWith('.webapps.tcloudbase.com') ||
    origin.endsWith('.preview.cloudbase.net');
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) || trustedCloudBaseOrigin ? origin : allowed[0],
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'Cache-Control': 'no-store'
  };
}

function response(event, statusCode, body) {
  return {
    statusCode,
    headers: {
      ...corsHeaders(event),
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(body)
  };
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function authorized(event) {
  const headers = event.headers || {};
  const raw = headers.authorization || headers.Authorization || '';
  if (!raw.startsWith('Bearer ') || !process.env.SYNC_TOKEN_HASH) return false;
  const token = raw.slice(7).trim();
  return token.length > 0 && safeEqual(
    tokenHash(token),
    String(process.env.SYNC_TOKEN_HASH).toLowerCase()
  );
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : String(event.body);
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    const error = new Error('body_too_large');
    error.status = 413;
    throw error;
  }
  return JSON.parse(raw);
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
    updatedAt: Number(record.updated_at)
  };
}

async function readRecord() {
  const { data, error } = await rdb
    .from('zhiqing_sync')
    .select('*')
    .eq('id', DOCUMENT_ID)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function writeRecord(body, baseRevision) {
  const { data, error } = await rdb.rpc('zhiqing_sync_put', {
    p_ciphertext: body.ciphertext,
    p_iv: body.iv,
    p_base_revision: baseRevision,
    p_client_updated_at: body.clientUpdatedAt
  });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  if (!result) throw new Error('empty database response');
  return {
    conflict: Boolean(result.conflict),
    revision: Number(result.revision),
    updatedAt: Number(result.updated_at)
  };
}

exports.main = async event => {
  const method = String(event.httpMethod || event.requestContext?.http?.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(event), body: '' };
  }

  const path = String(event.path || event.rawPath || '/');
  if (path === '/health' || path.endsWith('/health')) {
    return response(event, 200, {
      ok: true,
      service: 'zhiqing-sync',
      configured: Boolean(process.env.SYNC_TOKEN_HASH)
    });
  }

  if (!authorized(event)) {
    return response(event, 401, { error: 'unauthorized' });
  }

  try {
    if (method === 'GET') {
      const record = await readRecord();
      if (!record) return response(event, 200, { empty: true, revision: 0 });
      return response(event, 200, { ok: true, document: recordResponse(record) });
    }

    if (method !== 'PUT') {
      return response(event, 405, { error: 'method_not_allowed' });
    }

    let body;
    try {
      body = parseBody(event);
    } catch (error) {
      return response(event, error.status || 400, { error: error.message || 'bad_payload' });
    }
    if (!validPayload(body)) {
      return response(event, 400, { error: 'bad_payload' });
    }

    const result = await writeRecord(body, body.baseRevision);
    if (result.conflict) {
      return response(event, 409, {
        error: 'conflict',
        revision: result.revision
      });
    }
    return response(event, 200, result);
  } catch (error) {
    console.error('zhiqing-sync failed', error);
    return response(event, 500, { error: 'server_error' });
  }
};

if (require.main === module) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const event = {
      httpMethod: request.method,
      path: new URL(request.url, 'http://localhost').pathname,
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8')
    };
    try {
      const result = await exports.main(event);
      response.writeHead(result.statusCode || 200, result.headers || {});
      response.end(result.body || '');
    } catch (error) {
      console.error(error);
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'server_error' }));
    }
  });
  server.listen(Number(process.env.PORT) || 9000, '0.0.0.0');
}
