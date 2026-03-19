/**
 * KLEO Upload Function – PDF → Chunks → Embeddings → Supabase
 * ==============================================================
 * 
 * Netlify Serverless Function für den Upload einzelner PDFs.
 * Nimmt ein PDF als Base64 entgegen, extrahiert Text via Claude,
 * teilt in Chunks, generiert Embeddings und speichert in Supabase.
 * 
 * POST /.netlify/functions/upload
 * Body: { pdf_base64: "...", filename: "dokument.pdf" }
 * 
 * Response: { success: true, document_id: "...", title: "...", chunk_count: N }
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://izdlrotfclgpockskmma.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

// Chunking-Parameter
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;
const EMBEDDING_BATCH_SIZE = 50;

// ============================================================
// HILFSFUNKTIONEN
// ============================================================

function chunkText(text) {
  const cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  const chunks = [];
  let start = 0;

  while (start < cleaned.length) {
    let end = Math.min(start + CHUNK_SIZE, cleaned.length);

    if (end < cleaned.length) {
      const searchBack = cleaned.substring(end - 100, end);
      const lastPeriod = searchBack.lastIndexOf('. ');
      const lastNewline = searchBack.lastIndexOf('\n');
      const bestBreak = Math.max(lastPeriod, lastNewline);
      if (bestBreak > 0) {
        end = end - 100 + bestBreak + 1;
      }
    }

    chunks.push(cleaned.substring(start, end).trim());
    start = end - CHUNK_OVERLAP;
    if (start >= cleaned.length || end >= cleaned.length) break;
  }

  return chunks.filter(c => c.length > 50);
}

async function extractTextWithClaude(pdfBase64) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfBase64,
            },
          },
          {
            type: 'text',
            text: `Extrahiere den vollständigen Text aus diesem Dokument. 

Regeln:
- Gib NUR den extrahierten Text zurück, keine Kommentare oder Erklärungen
- Behalte die Textstruktur bei (Überschriften, Absätze, Aufzählungen)
- Beginne deine Antwort mit einer Zeile "TITEL: [erkannter Dokumenttitel]"
- Danach eine Leerzeile, dann der vollständige Text
- Tabellen als lesbaren Text darstellen
- Fußnoten und Seitenzahlen weglassen`,
          },
        ],
      }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API Fehler: ${response.status} – ${err}`);
  }

  const data = await response.json();
  const fullText = data.content[0].text;

  // Titel extrahieren
  let title = 'Unbekanntes Dokument';
  let textBody = fullText;

  const titleMatch = fullText.match(/^TITEL:\s*(.+)/m);
  if (titleMatch) {
    title = titleMatch[1].trim();
    textBody = fullText.substring(titleMatch[0].length).trim();
  }

  return { title, text: textBody };
}

async function createEmbeddings(texts) {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
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

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI Fehler: ${response.status} – ${err}`);
  }

  const data = await response.json();
  return data.data.map(d => d.embedding);
}

async function supabaseInsert(table, rows) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(rows),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Supabase Fehler: ${response.status} – ${err}`);
  }

  return response.json();
}

// ============================================================
// HANDLER
// ============================================================

exports.handler = async (event) => {
  // CORS Headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // OPTIONS für CORS Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Nur POST-Requests erlaubt' }),
    };
  }

  try {
    const { pdf_base64, filename } = JSON.parse(event.body);

    if (!pdf_base64) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'pdf_base64 fehlt im Request-Body' }),
      };
    }

    // 1. Text mit Claude extrahieren
    console.log('Extrahiere Text mit Claude...');
    const { title, text } = await extractTextWithClaude(pdf_base64);
    console.log(`Titel: "${title}", ${text.length} Zeichen`);

    if (text.length < 100) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Konnte keinen Text aus dem PDF extrahieren. Möglicherweise gescannt?' }),
      };
    }

    // 2. In Chunks aufteilen
    const chunks = chunkText(text);
    console.log(`${chunks.length} Chunks erstellt`);

    // 3. Dokument in Supabase anlegen
    const docContent = text.substring(0, 5000) + (text.length > 5000 ? '...' : '');
    const [doc] = await supabaseInsert('documents', {
      title: title,
      content: docContent,
    });
    const documentId = doc.id;
    console.log(`Dokument ${documentId} angelegt`);

    // 4. Embeddings generieren und Chunks speichern
    let savedCount = 0;

    for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBEDDING_BATCH_SIZE);
      const embeddings = await createEmbeddings(batch);

      const chunkRows = batch.map((content, j) => ({
        document_id: documentId,
        content: content,
        embedding: JSON.stringify(embeddings[j]),
        page_number: null,
        chunk_index: i + j,
      }));

      await supabaseInsert('document_chunks', chunkRows);
      savedCount += batch.length;
    }

    console.log(`${savedCount} Chunks gespeichert`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        document_id: documentId,
        title: title,
        chunk_count: savedCount,
        filename: filename || 'unknown.pdf',
      }),
    };

  } catch (error) {
    console.error('Upload Fehler:', error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Upload fehlgeschlagen',
        details: error.message,
      }),
    };
  }
};
