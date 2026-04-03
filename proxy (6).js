const ALLOWED_INDUSTRIES = [
  'dental clinic', 'medical clinic', 'law firm', 'hvac plumbing',
  'hair salon spa', 'restaurant', 'real estate agency', 'auto repair shop',
  'chiropractor', 'veterinary clinic'
];

const rateLimitMap = {};
const RATE_LIMIT = 300;

function isRateLimited(ip) {
  const now = Date.now();
  if (!rateLimitMap[ip]) rateLimitMap[ip] = [];
  rateLimitMap[ip] = rateLimitMap[ip].filter(t => now - t < 60000);
  if (rateLimitMap[ip].length >= RATE_LIMIT) return true;
  rateLimitMap[ip].push(now);
  return false;
}

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://elevation-prospector.netlify.app';

exports.handler = async function(event) {
  const origin = event.headers['origin'] || '';
  const headers = {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : '',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (origin !== ALLOWED_ORIGIN) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };

  const ip = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
  if (isRateLimited(ip)) return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests. Please wait.' }) };

  try {
    const { type, params } = JSON.parse(event.body);
    if (!type || !params) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing type or params' }) };

    const GOOGLE_KEY = process.env.GOOGLE_API_KEY;

    // Search businesses by industry + city
    if (type === 'search') {
      const { city, state, industry, limit } = params;

      if (!city || typeof city !== 'string' || city.length > 100)
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid city' }) };
      if (!state || typeof state !== 'string' || state.length > 2)
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid state' }) };
      if (!industry || !ALLOWED_INDUSTRIES.includes(industry))
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid industry' }) };

      const query = encodeURIComponent(`${industry} in ${city}, ${state}`);
      const maxResults = Math.min(parseInt(limit) || 10, 20);
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=${GOOGLE_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.results) data.results = data.results.slice(0, maxResults);
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    // Get place details
    if (type === 'details') {
      const { place_id } = params;

      if (!place_id || typeof place_id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(place_id) || place_id.length > 300)
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid place_id' }) };

      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=name,formatted_address,formatted_phone_number,website&key=${GOOGLE_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    // Scrape email from website
    if (type === 'scrape') {
      const { url } = params;

      if (!url || typeof url !== 'string' || !url.startsWith('http') || url.length > 500)
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid URL' }) };

      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ElevationBot/1.0)' },
          signal: AbortSignal.timeout(6000)
        });
        const html = await res.text();
        const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
        const matches = html.match(emailRegex) || [];
        const filtered = matches.filter(e =>
          !e.includes('example.com') &&
          !e.includes('sentry') &&
          !e.includes('wix') &&
          !e.includes('google') &&
          !e.includes('schema') &&
          !e.includes('@2x') &&
          !e.includes('png') &&
          !e.includes('jpg') &&
          e.length < 60
        );
        return { statusCode: 200, headers, body: JSON.stringify({ email: filtered[0] || '' }) };
      } catch(e) {
        return { statusCode: 200, headers, body: JSON.stringify({ email: '' }) };
      }
    }

    // Push row to Google Sheets via service account
    if (type === 'sheets_append') {
      const { rows, sheetId, accessToken } = params;

      if (!sheetId || typeof sheetId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sheetId))
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid sheetId' }) };
      if (!accessToken || typeof accessToken !== 'string')
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing accessToken' }) };
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > 100)
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid rows' }) };

      const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A:K:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: rows })
      });
      const data = await res.json();
      return { statusCode: res.status, headers, body: JSON.stringify(data) };
    }

    // Get existing sheet names to check duplicates
    if (type === 'sheets_get') {
      const { sheetId, accessToken } = params;

      if (!sheetId || typeof sheetId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sheetId))
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid sheetId' }) };
      if (!accessToken || typeof accessToken !== 'string')
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing accessToken' }) };

      const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A:A`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const data = await res.json();
      return { statusCode: res.status, headers, body: JSON.stringify(data) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown type' }) };

  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
