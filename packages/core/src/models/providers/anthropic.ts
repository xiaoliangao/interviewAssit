import type { Provider, ProviderSpec } from '../types.js';

export function anthropicProvider(spec: ProviderSpec): Provider {
  const keyEnv = spec.credential_ref ?? 'ANTHROPIC_API_KEY';
  return {
    spec,
    isAvailable: () => Boolean(process.env[keyEnv]),
    async complete(req) {
      const key = process.env[keyEnv];
      if (!key) throw new Error(`缺少 ${keyEnv}`);
      const res = await fetch(spec.endpoint ?? 'https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.system ? { system: req.system } : {}),
          messages: [{ role: 'user', content: req.prompt }],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json: any = await res.json();
      const text = (json.content ?? [])
        .filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      return {
        text,
        inputTokens: json.usage?.input_tokens,
        outputTokens: json.usage?.output_tokens,
      };
    },
  };
}
