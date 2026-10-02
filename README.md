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

## ローカルMCPでの動作検証

`npm run lab:check` で、ローカルD1の準備・開発サーバー起動・HTTP/MCP経由の
25ケース検証・結果保存・終了をまとめて実行できます。有料LLMは呼び出しません。
使い方と安全上の制約は [ローカルMCP検証環境](docs/local-lab.md) を参照してください。

## 会話からルール案を作成・承認

認証済みMCPには `domain.evaluate` / `domain.describe` / `domain.validate` /
`domain.search` に加え、`domain.propose` と `domain.commit` があります。
既存ドメインへの変更案を作り、引用元・変更内容・未解決事項を確認した後、
承認した案だけを新しいバージョンとして保存できます。

設定、マイグレーション、承認の責務、競合・再試行の仕様は
[会話からのルール作成](docs/domain-authoring-mcp.md)を参照してください。

## 誤った断定を減らす検証

設計の比較、再現した失敗例、修正内容と保証の境界は
[改善ループの記録](docs/reliability-loop.md)にまとめています。
公開版に未解決の知識・矛盾が残る場合、評価は結論を保留します。

## ドメイン別の版管理と重複排除

新しい版は内容ハッシュでルール・関数・型などを共有し、ドメインごとの親版と現行版を管理します。
移行方法・互換性・保存量の検証は[内容アドレス型版管理](docs/domain-version-storage.md)を参照してください。

## 正確な計算関数

`calculation.describe` / `calculation.evaluate`で、小数文字列を有理数として正確に計算します。
`calculation.verify`では、同じ計算要求に対する構造化した数値の主張を再照合できます。
使い方、丸めと正確な値の区別、独立した正解による検証は[計算関数](docs/calculation-functions.md)を参照してください。

## 引用の文字列照合

`evidence.match_quote`で資料本文と引用を完全一致で照合します。本文のハッシュと位置を返しますが、資料の真偽や引用の妥当性を認定するものではありません。[範囲と制約](docs/quote-evidence.md)を参照してください。

## ルール形式化の実証実験

自然言語の規則だけを読む条件と、同じ規則を実行するツールが使える条件を比較する小さな実験基盤です。
`npm run eval:empirical:prepare` で、架空のキャンセル規定12問・2条件の公開入力と採点用正解を分離して準備します。
このコマンドはLLMを呼びません。別途実施した12ケースの予備比較では両条件とも全問正解で、精度差は確認できませんでした。
[保存済みの回答・実行記録と限界](experiments/results/2026-10-02-cancellation-v2/README.md)を公開しています。
[実験の設計と限界](docs/empirical-experiment.md)を参照してください。

公開議事録からのタスク抽出についても、[5有効ペアでの検証・修正比較と限界](experiments/results/2026-10-02-public-minutes-v1/README.md)を記録しています。
