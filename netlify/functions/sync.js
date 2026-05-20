exports.handler = async function(event) {
  const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
  const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Supabase env vars not configured' }) };
  }

  const serviceHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY
  };

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  // Let Supabase verify the user's token — no manual JWT crypto needed
  async function getUserId() {
    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
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

  try {
    if (event.httpMethod === 'GET') {
      let userId;
      try { userId = await getUserId(); } catch(e) {
        return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
      }

      const r = await fetch(
        SUPABASE_URL + '/rest/v1/task_planner?id=eq.' + encodeURIComponent(userId) + '&select=data,updated_at',
        { headers: serviceHeaders }
      );
      const body = await r.text();
      return { statusCode: r.status, headers: corsHeaders, body };
    }

    if (event.httpMethod === 'POST') {
      let userId;
      try { userId = await getUserId(); } catch(e) {
        return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
      }

      let bodyObj;
      try { bodyObj = JSON.parse(event.body); } catch(e) { bodyObj = {}; }
      bodyObj.id = userId; // enforce from verified identity — client cannot fake this

      const r = await fetch(SUPABASE_URL + '/rest/v1/task_planner', {
        method: 'POST',
        headers: Object.assign({ 'Prefer': 'resolution=merge-duplicates' }, serviceHeaders),
        body: JSON.stringify(bodyObj)
      });
      const body = r.status === 204 ? '{}' : await r.text();
      return { statusCode: r.status, headers: corsHeaders, body };
    }

    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  }
};
