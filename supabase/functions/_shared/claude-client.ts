/**
 * Thin Claude client for JSON-producing calls, sibling to the existing
 * callClaude() in enrich-ai/index.ts (which is prose-only). Kept separate
 * rather than generalizing enrich-ai's version, since that function is
 * part of the already-deployed Phase 0 pipeline and this repo's practice
 * this session has been not to modify already-reviewed code in place.
 *
 * NOT LIVE-TESTED beyond confirming this mirrors enrich-ai's already-
 * working request shape (same endpoint, same auth headers).
 */

export const CLAUDE_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

interface AnthropicApiResponse {
  content: Array<{ type: string; text: string }>;
}

export async function callClaudeJson(systemInstruction: string, userPrompt: string): Promise<string> {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      system: systemInstruction,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errBody}`);
  }

  const data = (await res.json()) as AnthropicApiResponse;
  const text = data.content.find((c) => c.type === 'text')?.text ?? '';
  if (!text) throw new Error('Anthropic API returned no text content');
  return text.trim();
}
