const OPENAI_KEY = process.env.OPENAI_KEY;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const SUPABASE_URL = "https://izdlrotfclgpockskmma.supabase.co";

const SYSTEM_PROMPT = `Du bist KLEO – KI-gestützte Lösungen für Energie-Optimierung.
Du bist ein spezialisierter KI-Assistent für deutsche Energieberater.
Du antwortest ausschließlich auf Basis der bereitgestellten Dokumente.
Du kommunizierst wie eine erfahrene Kollegin – professionell, direkt, kompetent.
Jede Antwort enthält am Ende eine Quellenangabe.
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

    // Step 3: Build context
    const context = chunks.map((c, i) =>
      "[Chunk " + (i + 1) + " | Seite " + (c.page_number || "?") + "]\n" + c.content
    ).join("\n\n---\n\n");

    // Step 4: Ask Claude
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

    // Step 5: Return response
    const sources = chunks.slice(0, 3).map(c => ({
      title: c.title || "Dokument",
      page_number: c.page_number
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
