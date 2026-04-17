exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  }
  try {
    const { claim, source } = JSON.parse(event.body);
    const sourceSection = source ? `SOURCE TEXT:\n"""\n${source}\n"""` : `SOURCE TEXT: Not provided.`;
    const prompt = `You are Proof, a legal verification tool. Determine whether a legal claim is supported by the source text it cites.

You perform TWO checks:
1. Citation Accuracy: Is the source being referenced correctly?
2. Usage Accuracy: Does the source actually support the specific claim? Do they align?

CLAIM: "${claim}"
${sourceSection}

Respond ONLY with valid JSON, no markdown, no code fences:
{"verdict":"NOT_SUPPORTED","short_summary":"One sentence verdict.","what_is_claimed":"What the claim asserts.","what_source_says":"What the source actually says.","assessment":"VERDICT with one line reason.","reason":"2-4 sentences explaining the gap or alignment."}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    const text = (data.content || []).map(b => b.text || '').join('');
    const result = JSON.parse(text.replace(/```json|```/g, '').trim());
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: err.message }) };
  }
};
