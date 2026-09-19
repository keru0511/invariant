# Invariant

Cloudflare Workers および MCP 上で動作する、決定論的ドメイン評価と自然言語によるドメインモデル作成基盤。

## プロジェクト構成

```
src/
  domain/   # 純粋なドメインコア (Cloudflare や MCP に非依存)
  worker/   # Cloudflare Workers エントリーポイントおよび HTTP/MCP アダプター
```

- **Domain Core (`src/domain/`)**: 純粋な TypeScript で実装されたビジネスロジックおよび AST 定義。ランタイムや通信プロトコルの詳細から完全に分離されています。
- **Worker (`src/worker/`)**: 外部 HTTP フレームワーク（Hono など）を使用しない、最小限の Cloudflare Workers `fetch` ハンドラー。

## 開発コマンド

```bash
# 依存パッケージのインストール
npm install

# Cloudflare Worker ローカル開発サーバーの起動
npm run dev

# TypeScript 型チェック
npm run typecheck

# テスト実行
npm test

# 共有CI workflowをローカルで実行（固定された前提条件が必要）
npm run ci:local

# 実runnerを使う分離smoke（actrunの互換性も検証）
npm run test:ci-gate

# リポジトリローカルの pre-push CI hook を有効化（冪等）
npm run hooks:install
```

ローカルCIゲートの前提条件と検証状況は [`docs/ci-local.md`](docs/ci-local.md) に記録しています。

## エンドポイント

- `GET /` または `GET /health`: 健全性・サービスステータスを JSON で返却します。
- `POST /mcp`（および `OPTIONS /mcp`）: 2026-07-28 Modern MCP (Streamable HTTP) エンドポイント。
  - **ツール**:
    - `domain.ping`: ドメインコアの疎通・健全性を確認し、決定論的に `{ ok: true }` を返却します。
