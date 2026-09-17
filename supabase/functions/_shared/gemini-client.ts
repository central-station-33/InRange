/**
 * Thin Gemini REST client, mirroring the existing callClaude() pattern in
 * enrich-ai/index.ts. Uses generationConfig.responseMimeType='application/json'
 * so the model is constrained to JSON output at the API level, not just by
 * prompt instruction.
 *
 * NOT LIVE-TESTED: this environment has no GEMINI_API_KEY provisioned (it
 * is deliberately reserved-but-unset in .env.example, per
 * docs/ai-lead-enrichment-blueprint.md — Phase 1 needs budget/approval
 * sign-off first) and no verified network path to
 * generativelanguage.googleapis.com. The request/response shape below
 * follows Gemini's documented REST API; verify against a real key before
 * relying on it in production.
 */

export const GEMINI_MODEL = 'gemini-2.5-pro';
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

interface GeminiApiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

export async function callGemini(systemInstruction: string, userPrompt: string): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini API ${res.status}: ${errBody}`);
  }

  const data = (await res.json()) as GeminiApiResponse;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) throw new Error('Gemini API returned no text content');
  return text;
}
