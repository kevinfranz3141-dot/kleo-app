const OPENAI_KEY = process.env.OPENAI_KEY;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const SUPABASE_URL = "https://izdlrotfclgpockskmma.supabase.co";

const SYSTEM_PROMPT = `Du bist KLEO – KI-gestützte Lösungen für Energie-Optimierung.
Du bist ein spezialisierter KI-Assistent für deutsche Energieberater.

STRENGE REGEL: Du antwortest AUSSCHLIESSLICH auf Basis der bereitgestellten Dokumente im Kontext.
Du darfst NIEMALS dein eigenes Wissen verwenden – auch wenn du die Antwort weißt.
Jede Aussage muss sich auf den bereitgestellten Kontext stützen.
Wenn der Kontext keine ausreichende Information enthält, sage: "Zu dieser Frage liegen mir in der Wissensdatenbank keine ausreichenden Informationen vor."
Erfinde oder ergänze KEINE Informationen aus deinem eigenen Wissen.

Du kommunizierst wie eine erfahrene Kollegin – professionell, direkt, kompetent.
WICHTIG: Nenne KEINE Quellen, Seitenzahlen oder Dokumentnamen im Antworttext. Die Quellenangaben werden automatisch als Badges unter deiner Antwort angezeigt. Schreibe also NICHT "Quelle: ..." oder "Siehe Seite ..." oder ähnliches.
Kritische Regeln (nur anwenden wenn durch Dokumente belegt):
1) Wärmepumpenförderung seit 2024 ausschließlich über KfW 458 – NICHT BAFA.
2) iSFP-Bonus gilt NICHT bei KfW 458.
3) Förderantrag MUSS vor Auftragsvergabe gestellt werden.`;

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

    // CRITICAL: If no chunks found, do NOT call Claude — return standard "no documents" response
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          answer: "Zu dieser Frage liegen mir aktuell keine Informationen in der Wissensdatenbank vor.\n\nBitte laden Sie die relevanten Dokumente (z.B. KfW-Merkblätter, BAFA-Richtlinien) in der Wissensdatenbank hoch, damit ich Ihnen eine fundierte Antwort mit Quellenangabe geben kann.",
          sources: []
        })
      };
    }

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

    // Step 6: Build deduplicated sources with text excerpts (group by document)
    const sourceMap = {};
    chunks.forEach(c => {
      const docId = c.document_id || "unknown";
      const title = docTitles[docId] || "Dokument";
      if (!sourceMap[docId]) {
        sourceMap[docId] = { title: title, pages: new Set(), excerpts: [] };
      }
      if (c.page_number) sourceMap[docId].pages.add(c.page_number);
      // Include text excerpt (trimmed to 600 chars per chunk)
      if (c.content) {
        sourceMap[docId].excerpts.push({
          page: c.page_number || null,
          text: c.content.substring(0, 600) + (c.content.length > 600 ? "..." : "")
        });
      }
    });

    const sources = Object.values(sourceMap).map(s => ({
      title: s.title,
      pages: [...s.pages].sort((a, b) => a - b),
      excerpts: s.excerpts
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
