const OPENAI_KEY = process.env.OPENAI_KEY;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const SUPABASE_URL = "https://izdlrotfclgpockskmma.supabase.co";

const SYSTEM_PROMPT = `Du bist KLEO – KI-gestützte Lösungen für Energie-Optimierung.
Du bist ein spezialisierter KI-Assistent für deutsche Energieberater.

KERNREGEL: Du antwortest AUSSCHLIESSLICH auf Basis der bereitgestellten Dokumente im Kontext.
- Du darfst NIEMALS eigenes Wissen verwenden oder ergänzen – auch wenn du die Antwort weißt.
- Jede Aussage muss sich direkt auf den bereitgestellten Kontext stützen.
- Erfinde KEINE Informationen, Prozentsätze, Beträge oder Regeln.
- Wenn der Kontext eine Frage nur TEILWEISE beantwortet: Gib die belegten Informationen und sage transparent, welcher Teil nicht aus den Dokumenten hervorgeht.
- Wenn der Kontext KEINE ausreichende Information enthält: "Zu dieser Frage liegen mir in der Wissensdatenbank keine ausreichenden Informationen vor."

DOKUMENTEN-ZUORDNUNG — Beachte genau welches Dokument für welche Zielgruppe gilt:
- KfW 458 / M 458 = Heizungsförderung für PRIVATPERSONEN (Wohngebäude)
- KfW 459 / M 459 = Heizungsförderung für UNTERNEHMEN (Wohngebäude)
- Wenn nach Förderung für Privatpersonen/Eigenheimbesitzer gefragt wird: Nutze primär KfW 458 Informationen. Zitiere NICHT aus KfW 459 für Privatpersonen-Fragen.
- Wenn nach Förderung für Unternehmen/GbR gefragt wird: Nutze KfW 459.

VOLLSTÄNDIGKEIT bei Förderfragen:
- Wenn nach Förderhöhen gefragt wird: Nenne ALLE im Kontext genannten Förderkomponenten (Grundförderung, Effizienzbonus, Klimageschwindigkeitsbonus, Einkommensbonus, Emissionsminderungszuschlag) mit den exakten Prozentsätzen und Voraussetzungen aus den Dokumenten.
- Nenne immer auch die Obergrenze (max. 70%) und den Förderhöchstbetrag wenn im Kontext vorhanden.

KOMMUNIKATION:
- Du kommunizierst wie eine erfahrene Kollegin – professionell, direkt, kompetent.
- Du duzt den Energieberater.
- WICHTIG: Nenne KEINE Quellen, Seitenzahlen oder Dokumentnamen im Antworttext. Die Quellenangaben werden automatisch als Badges unter deiner Antwort angezeigt.

KRITISCHE FACHREGELN (nur anwenden wenn durch Dokumente im Kontext belegt):
1) Wärmepumpenförderung seit 2024 ausschließlich über KfW 458 (Privatpersonen) bzw. KfW 459 (Unternehmen) – NICHT BAFA.
2) iSFP-Bonus gilt NICHT bei KfW 458/459 Heizungsförderung.
3) Förderantrag MUSS vor Vorhabenbeginn gestellt werden (Lieferungsvertrag mit aufschiebender/auflösender Bedingung).`;

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
    const { question, conversation_history } = JSON.parse(event.body);
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

    // Step 2: Search Supabase — 10 chunks for better coverage of all relevant info
    const searchResponse = await fetch(SUPABASE_URL + "/rest/v1/rpc/match_document_chunks", {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query_embedding: embedding,
        match_count: 10,
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
          answer: "Zu dieser Frage liegen mir aktuell keine Informationen in der Wissensdatenbank vor.\n\nBitte lade die relevanten Dokumente (z.B. KfW-Merkblätter, BAFA-Richtlinien) in der Wissensdatenbank hoch, damit ich dir eine fundierte Antwort mit Quellenangabe geben kann.",
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

    // Step 5: Build messages with conversation history for follow-up context
    const messages = [];

    // Add last 3 exchanges from conversation history (if provided)
    if (Array.isArray(conversation_history)) {
      const recentHistory = conversation_history.slice(-6); // max 6 messages = 3 pairs
      recentHistory.forEach(msg => {
        if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({ role: msg.role, content: msg.content });
        }
      });
    }

    // Add current question with document context
    messages.push({
      role: "user",
      content: "Kontext aus der Wissensdatenbank:\n\n" + context + "\n\n---\n\nFrage des Energieberaters:\n" + question
    });

    // Step 6: Ask Claude
    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: messages
      })
    });
    const claudeData = await claudeResponse.json();
    const answer = claudeData.content[0].text;

    // Step 7: Build deduplicated sources with text excerpts (group by document)
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
