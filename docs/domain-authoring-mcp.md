# Reviewed conversation-to-domain authoring

This increment connects existing conversation patch generation, immutable D1
versions, and `domain.evaluate`. It extends **an existing domain/version**; it
is not a workspace/domain provisioning UI. Two new authenticated MCP tools:

1. `domain.propose({ workspace, domain, baseVersion, conversation })`
2. `domain.commit({ workspace, domain, proposalId, reviewDigest, confirmed: true })`

Conversation entries contain `id`, `role` (`user` or `assistant`), and `content`.
The base must be the domain's current head. Membership is checked before model
access or the external provider call. Configure the provider using
[the provider environment settings](conversation-provider.md); D1 needs all
four migrations, including `0004_content_addressed_domains.sql`.

## Review protocol

Propose calls the configured LLM with the conversation (including stable turn
IDs), current domain model and unresolved items. The existing bounded repair
wrapper parses the output, checks source references and dry-applies the patch.
It stores an immutable proposal but **does not publish a domain version**.

The response includes the exact operations, per-operation source references,
source text, resulting unknowns/conflicts, base and proposed version IDs, and a
SHA-256 `reviewDigest` of that complete review object. Display that review to the
user. Reference validity and structural checks do **not** establish that the
LLM correctly understood the text. Treat generated content as untrusted data.

Only after explicit approval, send the unchanged proposal ID and digest to
commit. `confirmed` must be the literal `true`; client-supplied replacement
models/patches and extra input fields are rejected. If the user wants a change,
create and review a new proposal instead. The server uses only its stored
candidate. Commit returns the version to pass to `domain.evaluate` (with the
same workspace/domain and the intended function/args).

The server binds a proposal to the verified principal and workspace/domain.
`confirmed` and the digest record a caller assertion and snapshot identity;
they cannot prove a human clicked approval. MCP hosts must collect explicit
approval and never auto-commit based on model-generated text. There is no
separate confirmation UI or human-identity attestation in this increment.

## Persistence and concurrency

- Domain versions remain immutable. Proposal IDs and proposed version IDs are
  server-generated UUIDs. Proposals retain the patch, review, evidence and full
  authoring model (types, examples, unknowns and conflicts).
- The next edit loads authoring metadata only for a published proposal version;
  unpublished proposals cannot silently become a new base. Historical edit
  provenance stays in the proposal, without forcing a new conversation to use
  an old conversation's source ID.
- Migration 0003 introduces one head per domain. For legacy data it selects the
  greatest `(published_at, version_id)` pair; check this bootstrap choice before
  production migration if publication timestamps did not reflect intended order.
  Every later version insertion, including the older publish API, advances it.
- Commit checks the current head and inserts the selected candidate in a single
  SQLite statement. The head trigger runs in that same transaction. Competing
  proposals on one base cannot both commit. A stale proposal returns
  `STALE_BASE_VERSION`; regenerate and review against the new head.
- Repeating a successful commit returns the original version without creating
  another version or moving the head backward. A publication marker separates
  genuine replays from external version-ID collisions (`VERSION_CONFLICT`).
- Proposals are private to their author for commit. Workspace membership is
  rechecked on every call. Foreign/missing proposals return `RESOURCE_NOT_FOUND`.

## Boundaries and verification

The provider request uses non-strict JSON Schema because patch payloads include
optional and recursive domain structures. Domain Core remains the authoritative
runtime validator; a schema-shaped response is not automatically accepted.
Conversation input is limited to 50 turns, 12,000 characters each. Test dependencies
are rejected in production. Public authoring errors omit provider bodies and
storage diagnostics.

Tests use real in-memory SQLite through a D1-shaped adapter, plus an injected
provider. They cover MCP propose/commit/evaluate, unchanged historical versions,
explicit confirmation, digest mismatch, competing commits, retries, rollback,
external version insertion, revoked access, cross-principal isolation, invalid
provider output, source IDs, metadata preservation and legacy migration.

No paid provider calls, deployment, production migration, or Cloudflare-hosted
D1 test is part of ordinary tests. Live-provider quality, production smoke,
provider rate/cost controls, proposal expiration/cleanup and a dedicated review
UI remain separate work. Proposals retain referenced conversation excerpts;
apply appropriate retention/access policies before production use.

## 内容アドレス型保存

新しい提案と公開版では、ルール本体を重複保存せず共有オブジェクトへの参照を保存します。
履歴IDと内容ハッシュは区別し、公開時に親版を記録します。
旧形式の読み取りも維持します。詳細は[ドメイン版管理](domain-version-storage.md)を参照してください。
