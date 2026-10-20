# EROSION MAP — 1日1文字 侵食マップシステム

[公開ソース](https://github.com/Unjuno/Erosion-map) · [自動テスト](https://github.com/Unjuno/Erosion-map/actions) · [Work引き継ぎ](docs/HANDOFF.md) · [アルゴリズム仕様](docs/ALGORITHM.md)

パスキーでログインしたユーザーが1日1文字を座標指定で投稿し、**受け取り側のマス**が上下左右からの影響を受けて文字と勢力値を更新する日次シミュレーション。

> **開発ステータス：ローカル試作版／本番未公開**
> 侵食エンジン、UI、開発用SQLite保存、WebAuthn APIは実装されていますが、
> **GPT Sitesへのデプロイ・本番DB・端末実機確認・運用監査は未完了**です。
> アルゴリズムの未承認規則と長期オーバーフローが残るため、本番投稿受付は禁止です。

## 実装済みの機能

| 項目 | 状態・制限 |
|---|---|
| 500×500のCanvas表示 | ズーム、ドラッグ、座標移動、マス選択 |
| デモマップ | 13日の合成履歴、再生速度、ランキング、仮投稿（保存なし） |
| 侵食・衝突 | TypeScriptによる決定的な一日一世代の計算。複数ルールは暫定 |
| 投稿データ処理 | 1ユーザー1日1件、同日更新でrevisionを加算 |
| 日次状態 | 日本時間、トランザクション、日付順、重複実行の冪等化 |
| SQLite | Node.js単一ノード用の開発アダプター、実験的APIに依存 |
| WebAuthn | メール・パスワード不要の登録、追加、ログイン、ログアウト。実機検証は未 |
| 公開履歴 | 認証情報を除くJSON静的出力。SHA-256照合 |
| ランキング | 最新マス数、N合計、読み込んだ直近30日の出現日数 |
| 情報の取り扱いページ | 開発版案内のみ。正式な規約・プライバシーポリシーではない |

## 起動

**Node.js 22以上、npm** が必要です。TypeScript 5.8.3、
\`@simplewebauthn/server\` 14.0.3、Node標準の実験的 \`node:sqlite\` を使用します。

\`\`\`bash
npm install
npm test             # build + static asset test + engine/DB/API/WebAuthn tests
npm run dev          # http://127.0.0.1:4173 （静的デモのみ）
npm run dev:full     # http://localhost:4173 （開発用API + SQLite + パスキー）
npm run job          # JSTで締切済みの日のsnapshotを確定
npm run export:states # site/data/state-YYYY-MM-DD.json 等に公開状態を出力
\`\`\`

\`npm run dev:full\` はローカル開発サーバーです。起動中は1時間ごとに締切済み日付を確認します。
最初の起動で開発用SQLiteファイルが作られ、ログイン・投稿フォームは
\`http://localhost:4173/submit\` にあります。データを公開サービスに移行する前に
保存形式、バックアップ、削除フローを決定してください。

## ページ

- \`/\` — 侵食マップと履歴再生。利用できれば公開DBの履歴へ切替可能。
- \`/submit\` — パスキー登録・ログイン・投稿（開発用バックエンドが必要）。
- \`/ranking\` — 勢力ランキング。公開JSONがなければ合成デモで表示。
- \`/policy\` — **未発効**の開発用データ取り扱い案内。

静的書き出しには \`index.html\`、\`account.html\`、\`ranking.html\`、
\`policy.html\` を含みます。拡張子なしURLはローカルHTTPサーバーが提供する
ルートであり、静的ホストにはRewrite設定が必要な場合があります。

## リポジトリ構成

\`\`\`text
src/                  侵食エンジン・投稿整合性・日付計算
server/               開発用 SQLite ストア、パスキーHTTP API
public/               Canvas・投稿・ランキング・ポリシー画面
scripts/              静的ビルド、ローカルサーバー、日次処理、公開JSON出力
tests/                ユニット、DB接続、署名付き仮想認証器、公開データ検証
docs/                 仕様・日次処理・Workへの引き継ぎ
.github/workflows/ci.yml  GitHub Actions
\`\`\`

## リリースを止めている問題

- [#1](https://github.com/Unjuno/Erosion-map/issues/1): **通常投稿N=1はN−1=0となり、侵食が始まらない。**
- [#2](https://github.com/Unjuno/Erosion-map/issues/2): **多勢力の相殺、同文字合算、現住者防御、同期更新を正式決定する。**
- [#3](https://github.com/Unjuno/Erosion-map/issues/3): **同文字合算によりNが指数的に増幅し、単一N3から52日目に安全整数を超える。**

未確定ルールは本番仕様ではなく、試作の挙動として明記しています。
本番化前には最低365日分の検証と、目標環境の機能調査が必要です。

## セキュリティ

公開リポジトリにユーザーの個人情報・認証用の秘密情報・SQLiteファイル・接続文字列をコミットしないでください。
パスキーの秘密鍵はサーバーでは扱いません。開発HTTPサーバーのCSRF防御、
IP単位の簡易レート制限、Cookieは本番環境での安全性を保証しません。
GPT Sitesの内蔵DB・WebAuthn・定期実行に関する実際の提供状況は未検証です。

**ライセンスは未設定**です。公開ソースであることと自由利用ライセンスがあることは異なります。
