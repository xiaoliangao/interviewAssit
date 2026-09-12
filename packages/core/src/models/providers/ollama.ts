import type { Provider, ProviderSpec } from '../types.js';

/** 唯一能处理 private / nda 载荷的一类 provider —— 因为字节不离开这台机器。 */
export function ollamaProvider(spec: ProviderSpec): Provider {
  const base = spec.endpoint ?? process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  return {
    spec,
    async isAvailable() {
      try {
        const res = await fetch(`${base}/api/tags`, {
          signal: AbortSignal.timeout(1200),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    async complete(req) {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          stream: false,
          options: {
            num_predict: req.maxTokens,
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          },
          messages: [
            ...(req.system ? [{ role: 'system', content: req.system }] : []),
            { role: 'user', content: req.prompt },
          ],
        }),
      });
      if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json: any = await res.json();
      return {
        text: json.message?.content ?? '',
        inputTokens: json.prompt_eval_count,
        outputTokens: json.eval_count,
      };
    },
  };
}
