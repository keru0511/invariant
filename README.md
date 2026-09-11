# Invariant

Deterministic domain evaluation and natural-language domain model authoring on Cloudflare Workers and MCP.

## Project Structure

```
src/
  domain/   # Pure domain core (no Cloudflare or MCP dependencies)
  worker/   # Cloudflare Workers entry point and HTTP adapter
```

- **Domain Core (`src/domain/`)**: Pure TypeScript business logic and AST definitions, isolated from runtime and protocol details.
- **Worker (`src/worker/`)**: Minimal Cloudflare Workers fetch handler without Hono or external HTTP frameworks.

## Development

```bash
# Install dependencies
npm install

# Start local Cloudflare Worker development server
npm run dev

# Run TypeScript typecheck
npm run typecheck

# Run test suite
npm test
```

