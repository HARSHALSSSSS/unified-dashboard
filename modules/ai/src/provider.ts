/**
 * The AI service boundary. The platform's answers are built from REAL data by deterministic code (see brain.ts); a language model is an
 * optional narrator behind this interface that may only re-word facts it is given. It never queries data, never changes data and is never
 * the source of truth. Swap providers (or run with none) without touching anything else.
 */
export interface AiProvider {
  readonly name: string;
  /** Re-write `draft` (already correct, from real data) in natural language for `question`. Must not add facts. */
  narrate(input: { question: string; draft: string; facts: unknown; signal?: AbortSignal }): Promise<string>;
}

export interface AiProviderConfig { AI_PROVIDER: 'rules' | 'anthropic'; ANTHROPIC_API_KEY?: string; AI_MODEL: string; AI_TIMEOUT_MS: number }

/** Anthropic Messages API over fetch. Only aggregated business facts are sent (ids and numbers), never credentials or customer PII. */
class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  constructor(private readonly key: string, private readonly model: string, private readonly timeoutMs: number) {}
  async narrate({ question, draft, facts }: { question: string; draft: string; facts: unknown }): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model, max_tokens: 600,
        system: 'You explain business data to a seller. Use ONLY the facts provided. Do not invent numbers, products or causes. If the data does not answer the question, say so. Be brief and concrete.',
        messages: [{ role: 'user', content: `Question: ${question}\n\nVerified answer draft:\n${draft}\n\nFacts (JSON):\n${JSON.stringify(facts).slice(0, 12_000)}\n\nRewrite the draft as a clear answer. Keep every number exactly as given.` }],
      }),
    });
    if (!res.ok) throw new Error(`AI provider HTTP ${res.status}`);
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = body.content?.filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim();
    if (!text) throw new Error('AI provider returned no text');
    return text;
  }
}

export function createAiProvider(cfg: AiProviderConfig): AiProvider | null {
  if (cfg.AI_PROVIDER === 'anthropic' && cfg.ANTHROPIC_API_KEY) return new AnthropicProvider(cfg.ANTHROPIC_API_KEY, cfg.AI_MODEL, cfg.AI_TIMEOUT_MS);
  return null; // 'rules': the deterministic answer is the answer
}
