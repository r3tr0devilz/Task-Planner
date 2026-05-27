require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();

const MIME = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json',
};

async function handleConfig(res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_KEY }));
}

async function getUserId(req) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) throw new Error('Missing authorization header');
  const token = authHeader.slice(7);
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + token }
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.message || err.error_description || 'Unauthorized');
  }
  const user = await r.json();
  if (!user.id) throw new Error('No user ID in response');
  return user.id;
}

async function handleSync(req, res) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Supabase env vars not configured. Check your .env file.' }));
    return;
  }

  const serviceHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
  };

  try {
    if (req.method === 'GET') {
      const userId = await getUserId(req);
      const r = await fetch(
        SUPABASE_URL + '/rest/v1/task_planner?id=eq.' + encodeURIComponent(userId) + '&select=data,updated_at',
        { headers: serviceHeaders }
      );
      const body = await r.text();
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(body);

    } else if (req.method === 'POST') {
      const userId = await getUserId(req);
      let bodyStr = '';
      await new Promise((resolve) => { req.on('data', c => bodyStr += c); req.on('end', resolve); });
      let bodyObj;
      try { bodyObj = JSON.parse(bodyStr); } catch (e) { bodyObj = {}; }
      bodyObj.id = userId;
      const r = await fetch(SUPABASE_URL + '/rest/v1/task_planner', {
        method: 'POST',
        headers: { ...serviceHeaders, 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify(bodyObj)
      });
      const body = r.status === 204 ? '{}' : await r.text();
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(body);

    } else {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
    }
  } catch (err) {
    const status = ['Missing authorization header', 'Unauthorized', 'No user ID in response'].includes(err.message) ? 401 : 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
  const ext = path.extname(filePath);
  const mimeType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url === '/.netlify/functions/config') return handleConfig(res);
  if (url === '/.netlify/functions/sync')   return handleSync(req, res);

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('Task Planner running at http://localhost:' + PORT);
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn('WARNING: SUPABASE_URL or SUPABASE_KEY not set. Copy .env.example to .env and fill in your values.');
  }
});
