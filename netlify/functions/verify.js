exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  let claim, source;
  try {
    const body = JSON.parse(event.body);
    claim = body.claim;
    source = body.source;
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!claim) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No claim provided' }) };
  }

  // ── STEP 1: Extract case name from claim using Claude ──────────────────
  let courtListenerSource = null;
  let caseFound = null;

  try {
    const extractResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Extract the case citation from this legal claim. Return ONLY a JSON object with one field "case_name" containing the full citation including reporter and year if mentioned (e.g. "Air France v. Saks 470 U.S. 392 1985"), or just the case name if no citation is given. Return null if no case is mentioned.

Claim: "${claim}"

Respond ONLY with valid JSON, no markdown, no explanation.`
        }]
      })
    });

    const extractData = await extractResponse.json();
    const extractText = (extractData.content || []).map(b => b.text || '').join('').trim();
    const extractClean = extractText.replace(/```json|```/g, '').trim();
    const extracted = JSON.parse(extractClean);

    // ── STEP 2: Search CourtListener for the case ───────────────────────
    if (extracted.case_name && extracted.case_name !== null) {
      const isSupremeCourt = extracted.case_name && (extracted.case_name.includes('U.S.') || extracted.case_name.includes('S.Ct.') || extracted.case_name.includes('S. Ct.'));
const courtFilter = isSupremeCourt ? '&court=scotus' : '';
const searchUrl = `https://www.courtlistener.com/api/rest/v4/search/?q=${encodeURIComponent(extracted.case_name)}&type=o&order_by=score+desc${courtFilter}`;

      const searchResponse = await fetch(searchUrl, {
        headers: {
          'Authorization': `Token ${process.env.COURTLISTENER_API_KEY}`
        }
      });

      const searchData = await searchResponse.json();

      if (searchData.results && searchData.results.length > 0) {
        const topResult = searchData.results[0];
        caseFound = topResult.caseName || extracted.case_name;

        // ── STEP 3: Fetch the full opinion text ─────────────────────────
        if (topResult.cluster_id) {
          const opinionResponse = await fetch(
            `https://www.courtlistener.com/api/rest/v4/opinions/?cluster=${topResult.cluster_id}`,
            {
              headers: {
                'Authorization': `Token ${process.env.COURTLISTENER_API_KEY}`
              }
            }
          );

          const opinionData = await opinionResponse.json();

          if (opinionData.results && opinionData.results.length > 0) {
            const opinion = opinionData.results[0];

            // Get best available text field
            const rawText =
              opinion.plain_text ||
              opinion.html_with_citations ||
              opinion.html ||
              opinion.html_columbia ||
              opinion.html_lawbox ||
              '';

            // Strip HTML tags if present
            const plainText = rawText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

            // Truncate to ~3000 chars to stay within token limits
            courtListenerSource = plainText.substring(0, 8000);
          }
        }
      }
    }
  } catch (e) {
    // CourtListener lookup failed — continue with user-provided source
    console.log('CourtListener lookup failed:', e.message);
  }

  // ── STEP 4: Build source section ────────────────────────────────────────
  let sourceSection;
  let sourceLabel = '';

  if (source && source.trim()) {
    // User provided source — use it
    sourceSection = `SOURCE TEXT (provided by user):\n"""\n${source}\n"""`;
  } else if (courtListenerSource) {
    // Auto-fetched from CourtListener
    sourceSection = `SOURCE TEXT (auto-retrieved from CourtListener for "${caseFound}"):\n"""\n${courtListenerSource}\n"""`;
    sourceLabel = caseFound;
  } else {
    sourceSection = `SOURCE TEXT: Not provided. No matching case found in CourtListener database.`;
  }

  // ── STEP 5: Run verification ─────────────────────────────────────────────
  const prompt = `You are Proof, a legal verification tool. Determine whether a legal claim is supported by the source text it cites.

CLAIM: "${claim}"

${sourceSection}

Respond ONLY with valid JSON, no markdown, no code fences:
{"verdict":"NOT_SUPPORTED","short_summary":"One sentence verdict.","what_is_claimed":"What the claim asserts.","what_source_says":"What the source actually says.","assessment":"VERDICT with one line reason.","reason":"2-4 sentences explaining the gap or alignment.","source_auto_fetched":${!source && courtListenerSource ? 'true' : 'false'},"case_name":"${caseFound || ''}"}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (data.error) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: data.error.message }) };
    }

    const text = (data.content || []).map(b => b.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    // ── STEP 6: Send notification email ─────────────────────────────────
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY
      },
      body: JSON.stringify({
        from: 'Proof <onboarding@resend.dev>',
        to: 'shomannoah13@gmail.com',
        subject: 'Proof — New Verification Submitted',
        text: 'VERDICT: ' + result.verdict +
          '\n\nCLAIM:\n' + claim +
          '\n\nSOURCE:\n' + (source || (courtListenerSource ? `[Auto-fetched: ${caseFound}]` : 'Not provided')) +
          '\n\nSUMMARY:\n' + result.short_summary +
          (courtListenerSource && !source ? '\n\n[Source was automatically retrieved from CourtListener]' : '')
      })
    });

    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
