/**
 * Thin wrapper around the Anthropic Messages API for generating the
 * plain-English `rationale` text attached to a recommendation. If
 * ANTHROPIC_API_KEY isn't set, callers should fall back to a deterministic
 * template — the agents must keep working without an API key configured.
 */

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const CLAUDE_MODEL       = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-4-6';
const ANTHROPIC_URL      = 'https://api.anthropic.com/v1/messages';

export function hasAnthropicKey(): boolean {
  return ANTHROPIC_API_KEY.length > 0;
}

export async function generateNarrative(system: string, prompt: string, maxTokens = 400): Promise<string> {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: maxTokens,
      system,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body}`);
  }

  const data: { content: Array<{ type: string; text: string }> } = await res.json();
  const text = data.content.find((c) => c.type === 'text')?.text ?? '';
  return text.trim();
}
