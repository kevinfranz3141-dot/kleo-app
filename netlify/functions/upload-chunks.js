/**
 * KLEO Upload Chunks – Chunks embedden und speichern
 * ====================================================
 * POST /.netlify/functions/upload-chunks
 * Body: { document_id: "...", chunks: [{ content: "...", chunk_index: 0, page_number: 1 }, ...] }
 * Response: { saved: N }
 * 
 * Verarbeitet max. 10 Chunks pro Request (bleibt unter 10s Timeout).
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://izdlrotfclgpockskmma.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Nur POST' }) };

  try {
    const { document_id, chunks } = JSON.parse(event.body);

    if (!document_id || !chunks || !chunks.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'document_id und chunks erforderlich' }) };
    }

    // Sicherheit: max 10 Chunks pro Request
    const batch = chunks.slice(0, 10);
    const texts = batch.map(c => c.content);

    // 1. Embeddings generieren
    const embRes = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'text-embedding-ada-002',
        input: texts,
      }),
    });

    if (!embRes.ok) {
      const err = await embRes.text();
      throw new Error(`OpenAI: ${embRes.status} – ${err}`);
    }

    const embData = await embRes.json();
    const embeddings = embData.data.map(d => d.embedding);

    // 2. Chunks mit Embeddings in Supabase speichern
    const rows = batch.map((chunk, i) => ({
      document_id: document_id,
      content: chunk.content,
      embedding: JSON.stringify(embeddings[i]),
      page_number: chunk.page_number || null,
      chunk_index: chunk.chunk_index || i,
    }));

    const storeRes = await fetch(`${SUPABASE_URL}/rest/v1/document_chunks`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(rows),
    });

    if (!storeRes.ok) {
      const err = await storeRes.text();
      throw new Error(`Supabase: ${storeRes.status} – ${err}`);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ saved: batch.length }),
    };

  } catch (error) {
    console.error('upload-chunks error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
