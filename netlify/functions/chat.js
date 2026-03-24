const OPENAI_KEY = process.env.OPENAI_KEY;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const SUPABASE_URL = "https://izdlrotfclgpockskmma.supabase.co";

const SYSTEM_PROMPT = `Du bist KLEO – KI-gestützte Lösungen für Energie-Optimierung.
Du bist ein spezialisierter KI-Assistent für deutsche Energieberater.

═══════════════════════════════════════
OBERSTE REGEL – STRIKTE KONTEXTBINDUNG
═══════════════════════════════════════
Du antwortest AUSSCHLIESSLICH auf Basis der Dokumente, die dir im Kontext übergeben werden.

VERBOTEN:
- Eigenes Trainingswissen einbringen – auch wenn du die Antwort zu kennen glaubst.
- Lücken im Kontext mit Vermutungen, Schätzungen oder plausibel klingenden Werten füllen.
- Prozentsätze, Eurobeträge, Fristen oder Bedingungen nennen, die nicht wörtlich im Kontext stehen.
- Informationen aus verschiedenen Dokumenten kombinieren, wenn dabei neue Aussagen entstehen, die so im Kontext nicht stehen.
- Antworten paraphrasieren und dabei Zahlen oder Bedingungen leicht verändern.

PFLICHT vor jeder Aussage mit Zahlen oder Regeln:
Prüfe intern: "Steht dieser exakte Wert / diese exakte Regel im übergebenen Kontext?" – Wenn nein: nicht nennen.

BEI UNVOLLSTÄNDIGEM KONTEXT:
- Nur den belegten Teil beantworten.
- Den nicht belegten Teil explizit kennzeichnen: "Dazu liegen mir in der Wissensdatenbank keine Informationen vor."
- Niemals den unbelegten Teil trotzdem beantworten, auch nicht mit Einschränkungen wie "üblicherweise" oder "in der Regel".

BEI FEHLENDEM KONTEXT (keine passenden Chunks gefunden oder Kontext enthält keine relevante Antwort):
Antworte ausschließlich: "Zu dieser Frage liegen mir in der Wissensdatenbank keine ausreichenden Informationen vor. Bitte lade das entsprechende Dokument hoch."

═══════════════════════════════════
DOKUMENTEN-ZUORDNUNG
═══════════════════════════════════
Beachte genau, welches Dokument für welche Zielgruppe gilt:
- KfW 458 / M 458 = Heizungsförderung für PRIVATPERSONEN (Wohngebäude)
- KfW 459 / M 459 = Heizungsförderung für UNTERNEHMEN (Wohngebäude)
- Frage zu Privatpersonen/Eigenheimbesitzer → nur KfW 458 verwenden, NICHT KfW 459.
- Frage zu Unternehmen/GbR → nur KfW 459 verwenden.
- Mische NIEMALS Werte aus KfW 458 und KfW 459 in einer Antwort, ohne dies klar zu trennen.

═══════════════════════════════════
VOLLSTÄNDIGKEIT BEI FÖRDERFRAGEN
═══════════════════════════════════
Wenn nach Förderhöhen gefragt wird:
- Nenne ALLE im Kontext genannten Förderkomponenten (Grundförderung, Effizienzbonus, Klimageschwindigkeitsbonus, Einkommensbonus, Emissionsminderungszuschlag).
- Nenne bei JEDER Komponente zwingend den konkreten Prozentsatz aus dem Kontext – niemals nur den Namen ohne Zahl. Beispiel: NICHT „Klimageschwindigkeitsbonus", sondern „Klimageschwindigkeitsbonus: 20 %".
- Verwende ausschließlich die exakten Prozentsätze und Voraussetzungen aus dem Kontext.
- Nenne Obergrenze und Förderhöchstbetrag, wenn im Kontext vorhanden.
- Wenn eine Komponente im Kontext nicht erwähnt wird: nicht nennen.

═══════════════════════════════════
KOMMUNIKATION
═══════════════════════════════════
- Professionell, direkt, kompetent – wie eine erfahrene Kollegin.
- Du duzt den Energieberater.
- Nenne KEINE Quellen, Seitenzahlen oder Dokumentnamen im Antworttext. Quellenangaben erscheinen automatisch als Badges.

═══════════════════════════════════
KRITISCHE FACHREGELN
(nur anwenden wenn im Kontext belegt)
═══════════════════════════════════
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

    // Step 2: Search Supabase — fetch 20 candidates for reranking
    const searchResponse = await fetch(SUPABASE_URL + "/rest/v1/rpc/match_document_chunks", {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query_embedding: embedding,
        match_count: 20,
        match_threshold: 0.2
      })
    });
    const candidates = await searchResponse.json();

    // CRITICAL: If no chunks found, do NOT call Claude — return standard "no documents" response
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          answer: "Zu dieser Frage liegen mir aktuell keine Informationen in der Wissensdatenbank vor.\n\nBitte lade die relevanten Dokumente (z.B. KfW-Merkblätter, BAFA-Richtlinien) in der Wissensdatenbank hoch, damit ich dir eine fundierte Antwort mit Quellenangabe geben kann.",
          sources: []
        })
      };
    }

    // Step 3: Fetch document titles for all candidates
    const docIds = [...new Set(candidates.map(c => c.document_id).filter(Boolean))];
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

    // Step 4: Use top 10 candidates by similarity score (reranking disabled)
    const chunks = candidates.slice(0, 10);

    // Step 5: Build context from the 10 reranked chunks
    const context = chunks.map(c => {
      const title = docTitles[c.document_id] || "Dokument";
      return "[" + title + " | Seite " + (c.page_number || "?") + "]\n" + c.content;
    }).join("\n\n---\n\n");

    // Step 6: Build messages with conversation history for follow-up context
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

    // Add current question with reranked document context
    messages.push({
      role: "user",
      content: "Kontext aus der Wissensdatenbank:\n\n" + context + "\n\n---\n\nFrage des Energieberaters:\n" + question
    });

    // Step 7: Ask Claude Sonnet for the actual answer
    console.log("[answer] Sending", chunks.length, "chunks to Sonnet, context length:", context.length);
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
    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text();
      console.error("[answer] Sonnet HTTP error:", claudeResponse.status, errText);
      throw new Error("Sonnet API error " + claudeResponse.status + ": " + errText);
    }
    const claudeData = await claudeResponse.json();
    if (claudeData.error) {
      console.error("[answer] Sonnet API error:", claudeData.error.type, claudeData.error.message);
      throw new Error("Sonnet error: " + claudeData.error.message);
    }
    const answer = claudeData.content[0].text;
    console.log("[answer] Sonnet response length:", answer.length);

    // Step 8: Build deduplicated sources with text excerpts (group by document)
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
