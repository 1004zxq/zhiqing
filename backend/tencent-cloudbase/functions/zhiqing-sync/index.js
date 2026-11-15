'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const rdb = app.rdb();
const DOCUMENT_ID = 'main';
const MAX_BODY_BYTES = 2_000_000;
let personaCache = '';

function corsHeaders(event) {
  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin || '';
  const allowed = [
    'https://1004zxq.github.io',
    'http://greenbranch.local:8765',
    'http://10.94.129.90:8765',
    'http://127.0.0.1:8890',
    'http://localhost:8890'
  ];
  const trustedCloudBaseOrigin = origin.endsWith('.tcloudbaseapp.com') ||
    origin.endsWith('.webapps.tcloudbase.com') ||
    origin.endsWith('.preview.cloudbase.net');
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) || trustedCloudBaseOrigin ? origin : allowed[0],
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
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

function cleanHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => item && (item.role === 'user' || item.role === 'assistant'))
    .slice(-12)
    .map(item => ({
      role: item.role,
      text: String(item.text || '').slice(0, 1200)
    }))
    .filter(item => item.text.trim());
}

function chatSystemPrompt(context) {
  if (!personaCache) {
    try {
      personaCache = fs.readFileSync(path.join(__dirname, 'persona.local.md'), 'utf8').trim();
    } catch (error) {
      personaCache = '你是如期。接住青，不冒充她，不说教；回答短、真、有来有回。';
    }
  }
  const contextText = JSON.stringify(context || {}).slice(0, 80000);
  return `${personaCache}

## 在枝下青网站里工作的补充规则

- 青已经明确授权你读取她交来的全部枝下青记录。不要反问能否读取，也不要假装自己只看见摘要。
- 下面是青当前的待办、旧卡片勾选、笔叙、睡眠和卡片目录。回答具体问题时以这些记录为依据；做观察时尽量带日期。
- 如果记录不足，直说不知道，不补写不存在的事件。
- 你可以陪聊、梳理、劝停空耗、催她做具体的下一件事。给建议时一次只留少量选择，别把她当成小孩，也别用羞耻推动。
- 直接把内容当作背景，不要为了证明“我懂你”而搬出隐私细节。她问起再说。
- 多数回答保持三到六句，像聊天，不像报告。需要整理时才用很短的分点。
- 若提出一件可执行的待办，在最后单独写一行“待办建议：……”，只写一件。

当前日期：${new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}

## 枝下青记录

${contextText}`;
}

async function replyWithRuqi(body) {
  const apiKey = String(process.env.CHAT_API_KEY || '').trim();
  if (!apiKey) {
    const error = new Error('chat_not_configured');
    error.status = 503;
    throw error;
  }
  const message = String(body.message || '').trim().slice(0, 4000);
  if (!message) {
    const error = new Error('empty_message');
    error.status = 400;
    throw error;
  }
  const baseUrl = String(process.env.CHAT_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.CHAT_MODEL || 'deepseek-flash',
        messages: [
          { role: 'system', content: chatSystemPrompt(body.context) },
          ...cleanHistory(body.history),
          { role: 'user', content: message }
        ],
        temperature: 0.7,
        max_tokens: 1000,
        stream: false
      }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error?.message || payload?.message || 'model_failed');
      error.status = 502;
      throw error;
    }
    const reply = String(payload?.choices?.[0]?.message?.content || '').trim();
    if (!reply) {
      const error = new Error('empty_model_reply');
      error.status = 502;
      throw error;
    }
    return reply;
  } finally {
    clearTimeout(timer);
  }
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
    if (path === '/chat' || path.endsWith('/chat')) {
      if (method !== 'POST') {
        return response(event, 405, { error: 'method_not_allowed' });
      }
      let body;
      try {
        body = parseBody(event);
      } catch (error) {
        return response(event, error.status || 400, { error: error.message || 'bad_payload' });
      }
      try {
        const reply = await replyWithRuqi(body);
        return response(event, 200, { ok: true, reply });
      } catch (error) {
        if (error.status !== 502 && error.status !== 503) console.error('zhiqing-chat failed', error.message);
        return response(event, error.status || 500, {
          error: error.status === 502 ? 'model_failed' : error.message
        });
      }
    }

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
