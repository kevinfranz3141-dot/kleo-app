const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_URL = "https://izdlrotfclgpockskmma.supabase.co";

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json"
  };

  try {
    // Step 1: Find M458 document(s)
    const docRes = await fetch(
      SUPABASE_URL + "/rest/v1/documents?title=ilike.*458*&select=id,title",
      {
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": "Bearer " + SUPABASE_KEY
        }
      }
    );
    const docs = await docRes.json();

    if (!Array.isArray(docs) || docs.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "No M458 document found" }) };
    }

    // Step 2: Fetch chunks 9, 10, 11 for each matching document
    const results = {};
    for (const doc of docs) {
      const chunkRes = await fetch(
        SUPABASE_URL + "/rest/v1/document_chunks?document_id=eq." + doc.id +
        "&chunk_index=in.(9,10,11)&select=chunk_index,page_number,content&order=chunk_index.asc",
        {
          headers: {
            "apikey": SUPABASE_KEY,
            "Authorization": "Bearer " + SUPABASE_KEY
          }
        }
      );
      const chunks = await chunkRes.json();
      results[doc.title] = { document_id: doc.id, chunks };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(results, null, 2)
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
