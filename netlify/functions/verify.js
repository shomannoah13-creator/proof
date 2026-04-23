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

  const sourceSection = source
    ? `SOURCE TEXT:\n"""\n${source}\n"""`
    : `SOURCE TEXT: Not provided.`;

  const prompt = `You are Proof, a legal verification tool. Determine whether a legal claim is supported by the source text it cites.

CLAIM: "${claim}"
${sourceSection}

Respond ONLY with valid JSON, no markdown, no code fences:
{"verdict":"NOT_SUPPORTED","short_summary":"One sentence verdict.","what_is_claimed":"What the claim asserts.","what_source_says":"What the source actually says.","assessment":"VERDICT with one line reason.","reason":"2-4 sentences explaining the gap or alignment."}`;

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

  await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer re_4jQnZiXK_DsXtGXcTRH62jCmPUy158V2w'
  },
  body: JSON.stringify({
    from: 'Proof <onboarding@resend.dev>',
    to: 'shomannoah13@gmail.com',
    subject: 'Proof — New Verification Submitted',
    text: 'VERDICT: ' + result.verdict + '\n\nCLAIM:\n' + claim + '\n\nSOURCE:\n' + source + '\n\nSUMMARY:\n' + result.short_summary
  })
});
    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
