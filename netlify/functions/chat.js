const OPENAI_KEY = process.env.OPENAI_KEY;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const SUPABASE_URL = "https://izdlrotfclgpockskmma.supabase.co";

const SYSTEM_PROMPT = `Du bist KLEO – KI-gestützte Lösungen für Energie-Optimierung.
Du bist ein spezialisierter KI-Assistent für deutsche Energieberater.
Du antwortest ausschließlich auf Basis der bereitgestellten Dokumente.
Du kommunizierst wie eine erfahrene Kollegin – professionell, direkt, kompetent.
WICHTIG: Nenne KEINE Quellen, Seitenzahlen oder Dokumentnamen im Antworttext. Die Quellenangaben werden automatisch als Badges unter deiner Antwort angezeigt. Schreibe also NICHT "Quelle: ..." oder "Siehe Seite ..." oder ähnliches.
Kritische Regeln:
1) Wärmepumpenförderung seit 2024 ausschließlich über KfW 458 – NICHT BAFA.
2) iSFP-Bonus gilt NICHT bei KfW 458.
3) Förderantrag MUSS vor Auftragsvergabe gestellt werden.
Wenn die Dokumente keine Antwort hergeben: sage das klar.`;

exports.handler = async (event) => {
  // CORS headers
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };

  // Handle preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const { question } = JSON.parse(event.body);
    if (!question) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "No question provided" }) };
    }

    // Step 1: Create embedding
    const embResponse = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + OPENAI_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "text-embedding-ada-002",
        input: question
      })
    });
    const embData = await embResponse.json();
    const embedding = embData.data[0].embedding;

    // Step 2: Search Supabase
    const searchResponse = await fetch(SUPABASE_URL + "/rest/v1/rpc/match_document_chunks", {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query_embedding: embedding,
        match_count: 6,
        match_threshold: 0.2
      })
    });
    const chunks = await searchResponse.json();

    // Step 3: Fetch document titles for the matched chunks
    const docIds = [...new Set(chunks.map(c => c.document_id).filter(Boolean))];
    const docTitles = {};

    if (docIds.length > 0) {
      const titleRes = await fetch(
        SUPABASE_URL + "/rest/v1/documents?id=in.(" + docIds.join(",") + ")&select=id,title",
        {
          headers: {
            "apikey": SUPABASE_KEY,
            "Authorization": "Bearer " + SUPABASE_KEY
          }
        }
      );
      const titleData = await titleRes.json();
      if (Array.isArray(titleData)) {
        titleData.forEach(d => { docTitles[d.id] = d.title; });
      }
    }

    // Step 4: Build context with real document titles
    const context = chunks.map((c, i) => {
      const title = docTitles[c.document_id] || "Dokument";
      return "[" + title + " | Seite " + (c.page_number || "?") + "]\n" + c.content;
    }).join("\n\n---\n\n");

    // Step 5: Ask Claude
    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: "Kontext aus der Wissensdatenbank:\n\n" + context + "\n\n---\n\nFrage des Energieberaters:\n" + question
        }]
      })
    });
    const claudeData = await claudeResponse.json();
    const answer = claudeData.content[0].text;

    // Step 6: Build deduplicated sources (group by document, merge pages)
    const sourceMap = {};
    chunks.forEach(c => {
      const docId = c.document_id || "unknown";
      const title = docTitles[docId] || "Dokument";
      if (!sourceMap[docId]) {
        sourceMap[docId] = { title: title, pages: new Set() };
      }
      if (c.page_number) sourceMap[docId].pages.add(c.page_number);
    });

    const sources = Object.values(sourceMap).map(s => ({
      title: s.title,
      pages: [...s.pages].sort((a, b) => a - b)
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ answer, sources })
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
