# Conversation patch provider

`src/provider/openai-compatible.ts` provides the concrete HTTP adapter used at
the conversation-to-Domain-Patch boundary. It is intentionally outside
`src/domain`, so credentials and network access do not enter Domain Core.

Configure the adapter from the runtime environment:

- `OPENAI_API_KEY` — required secret.
- `OPENAI_MODEL` — required model name.
- `OPENAI_BASE_URL` — optional OpenAI-compatible API base URL; defaults to
  `https://api.openai.com/v1`.
- `OPENAI_TIMEOUT_MS` — optional positive request timeout in milliseconds.

```ts
import { createOpenAICompatibleProviderFromEnv } from './provider';

const provider = createOpenAICompatibleProviderFromEnv(env);
const result = await generateValidatedDomainPatch(input, provider);
```

Normal tests continue to inject deterministic fake providers. No credentials
or live network call are required for `npm test`.

The bounded-repair wrapper may add optional `attempt` and structured `repair`
diagnostics to a provider request. The concrete adapter forwards those fields
inside the structured request metadata and uses optional `signal` only for
transport cancellation. Existing injected providers remain valid because the
adapter boundary and output schema are unchanged.


