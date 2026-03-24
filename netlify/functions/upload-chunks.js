/**
 * KLEO Upload Chunks – Chunks embedden und speichern
 * ====================================================
 * POST /.netlify/functions/upload-chunks
 * Body: { document_id, chunks, generate_summary?, doc_text? }
 * Response: { saved: N, summary_saved?: true }
 *
 * Verarbeitet max. 10 Chunks pro Request (bleibt unter 10s Timeout).
 * Wenn generate_summary=true: erzeugt einen zusätzlichen Zusammenfassungs-Chunk
 * via Claude aus doc_text (ersten 3000 Zeichen) und speichert ihn als
 * chunk_index=0 / page_number=0.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://izdlrotfclgpockskmma.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Nur POST' }) };

  try {
    const { document_id, chunks, generate_summary, doc_text } = JSON.parse(event.body);

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

    // 3. Optionaler Zusammenfassungs-Chunk (nur beim letzten Batch)
    let summary_saved = false;
    if (generate_summary && doc_text) {
      try {
        // Claude erstellt kompakte Zusammenfassung
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            messages: [{
              role: 'user',
              content: `Erstelle eine strukturierte Zusammenfassung des folgenden Dokuments. Decke dabei alle folgenden Punkte ab, sofern im Dokument vorhanden:\n\n1. Fördersätze & Beträge: Alle Prozentsätze, Eurobeträge, Obergrenzen und Boni mit exakten Zahlen.\n2. Antragsberechtigte: Wer darf den Antrag stellen? (z.B. Privatpersonen, Unternehmen, Vermieter, WEG)\n3. Ausschlüsse: Wer ist explizit nicht antragsberechtigt? Welche Maßnahmen oder Gebäude sind ausgeschlossen?\n4. Wichtige Einschränkungen & Bedingungen: Voraussetzungen, die erfüllt sein müssen (z.B. Energieberater-Pflicht, Antrag vor Baubeginn, Gebäudealter).\n5. Fristen & Termine: Alle relevanten Deadlines.\n6. Kombinierbarkeit: Mit welchen anderen Programmen kombinierbar oder nicht kombinierbar?\n\nSchreibe nur die Zusammenfassung ohne einleitenden Satz. Nenne Zahlen und Regeln exakt wie im Dokument.\n\n${doc_text.substring(0, 3000)}`,
            }],
          }),
        });

        if (claudeRes.ok) {
          const claudeData = await claudeRes.json();
          const summaryText = claudeData.content?.[0]?.text;

          if (summaryText) {
            // Embedding für die Zusammenfassung
            const embSumRes = await fetch('https://api.openai.com/v1/embeddings', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: 'text-embedding-ada-002', input: summaryText }),
            });

            if (embSumRes.ok) {
              const embSumData = await embSumRes.json();
              const summaryEmbedding = embSumData.data[0].embedding;

              await fetch(`${SUPABASE_URL}/rest/v1/document_chunks`, {
                method: 'POST',
                headers: {
                  'apikey': SUPABASE_KEY,
                  'Authorization': `Bearer ${SUPABASE_KEY}`,
                  'Content-Type': 'application/json',
                  'Prefer': 'return=minimal',
                },
                body: JSON.stringify([{
                  document_id,
                  content: '[ZUSAMMENFASSUNG] ' + summaryText,
                  embedding: JSON.stringify(summaryEmbedding),
                  page_number: 0,
                  chunk_index: 0,
                }]),
              });
              summary_saved = true;
            }
          }
        } else {
          console.error('Summary Claude error:', claudeRes.status, await claudeRes.text());
        }
      } catch (sumErr) {
        console.error('Summary generation failed (non-fatal):', sumErr.message);
        // Nicht fatal — Upload trotzdem als Erfolg werten
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ saved: batch.length, summary_saved }),
    };

  } catch (error) {
    console.error('upload-chunks error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
