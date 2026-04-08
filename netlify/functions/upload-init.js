/**
 * KLEO Upload Init – Dokument in Supabase anlegen
 * =================================================
 * POST /.netlify/functions/upload-init
 * Body: { title: "...", content: "..." }
 * Response: { document_id: "..." }
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://izdlrotfclgpockskmma.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Nur POST' }) };

  try {
    const { title, content, tenant_id } = JSON.parse(event.body);
    if (!title) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Titel fehlt' }) };

    const docData = {
      title: title,
      content: (content || '').substring(0, 5000),
    };
    if (tenant_id) docData.tenant_id = tenant_id;

    const res = await fetch(`${SUPABASE_URL}/rest/v1/documents`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(docData),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Supabase: ${res.status} – ${err}`);
    }

    const [doc] = await res.json();
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ document_id: doc.id, title: doc.title }),
    };

  } catch (error) {
    console.error('upload-init error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
