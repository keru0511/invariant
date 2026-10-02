# ChatGPT Data Analysis 用の固定評価関数

## アップロード対象

`cancellation_evaluator.py.txt` だけを executable_rules 条件へアップロードする。標準ライブラリだけで動作する Python ソースであり、ケース、正解、期待するツール引数を含まない。関数自身はネットワーク・ファイルの読み書き・認証・モデル呼出しを行わない。

- ベースとなる TypeScript 実装の確認時コミット: `695be17`
- SHA256: `b0a4f037db18a20d58b4364494367959ab157821f2030a8af009e955dc9bd83f`
- サイズ: 11,588 bytes（UTF-8）

`verify_evaluator.py` と親ディレクトリの `oracle.json` はローカル検証専用であり、どちらの実験条件にも渡さない。両条件のルール本文・質問・事実・回答形式には元の公開フィクスチャをそのまま使用する。

## 読み込み手順

Data Analysis の実際の添付ファイル名に合わせてパスを指定し、ハッシュを確認して未変更のソースを読み込む。このローダーだけは添付ファイルを読み取るが、書き換えない。

```python
from pathlib import Path
import hashlib

source_path = Path('/mnt/data/cancellation_evaluator.py.txt')
source_bytes = source_path.read_bytes()
assert hashlib.sha256(source_bytes).hexdigest() == 'b0a4f037db18a20d58b4364494367959ab157821f2030a8af009e955dc9bd83f'
namespace = {}
exec(compile(source_bytes.decode('utf-8'), source_path.name, 'exec'), namespace)
```

`namespace['describe']()` で固定ルールと入力スキーマを確認できる。`describe(request_dict)` を明示的に呼ぶ場合は、domain/version/function を検証する。引数なしの describe は自分自身の固定された説明を返すための補助であり、評価時の版省略を許すものではない。

モデルが質問・与件から `request_dict` を自分で組み立てて、次を実行する。採点側の toolTarget を貼り付けてはいけない。

```python
result = namespace['evaluate'](request_dict)
print(result)
```

評価要求のトップレベルフィールドは domain, version, function, args だけ。対象はそれぞれ synthetic-cancellation, cancellation-v1, cancellation-fee に固定し、args には確認済みの organizerCancelled, secondsUntilStart, bookingPriceYen だけを入れる。未知の事実は省略し、null・推測値にしない。実行時の要求と生の結果も保存する。

## 検証

```sh
python3 fixtures/empirical-v1/chatgpt/verify_evaluator.py --typescript-parity
```

- 既存の別ファイルに記述された手計算期待値との照合: 12ケース
- 整数境界、巨大金額、入力型、欠測、版固定、不要でも不正な入力の拒否、入力非変更など: 8テストメソッド（下記の相互照合を含む）
- TypeScript 実装との相互照合: 評価83ベクトル・説明4ベクトル

TypeScript との一致は移植の整合確認であり、独立した正解の証明ではない。既存の期待値も AI による手計算で、人による確認は未実施。

## この移植の境界

- 評価・説明の結果は新しい通常の Python 辞書。TypeScript の deepFreeze と異なり呼出し側が結果を書き換えられるが、後続の呼出し結果に影響しない
- JSON の数値型との一致のため、安全範囲内の整数値 float（86400.0 など）も受け入れる。bool は数値として受け入れない。小数、非有限値、負数、範囲外、符号が保存された負のゼロ（-0.0）は拒否する
- Python の整数式 `-0` や通常の json.loads の `-0` は評価関数へ来る前に 0 になり、元の符号を検出できない。JSON テキストから読むときに符号保持が必要なら `json.loads(text, parse_int=lambda s: -0.0 if s == '-0' else int(s))` を使う。要求生成時に無断で値を正規化しない
- 完全な Python 組込み dict/str/bool/int/float のみ受け入れる。Python の派生クラスや非JSONオブジェクトの動作はTS固有のプロキシ等との互換対象外
- ローカルな Python ソース実行であり、稼働中のMCP登録・永続化・変更承認・固定されたリモートツール環境ではない。モデルはファイルを読む・書き換える能力を持つため、ハッシュと実行記録で未変更のプログラム使用を確認する
- この検証だけではLLMの事実抽出、引数選択、説明文の正しさ、現行規則維持、回答精度の改善を保証しない。UI上で Python が使えない・未実行・実行結果が取得できない場合は、そのまま失敗／未確認として記録する
