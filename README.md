# EROSION MAP — 1日1文字 侵食マップ

[ソースコード](https://github.com/Unjuno/Erosion-map) · [自動テスト](https://github.com/Unjuno/Erosion-map/actions) · [侵食ルール](docs/ALGORITHM.md)

1日に1文字だけ座標を指定して投稿し、上下左右からの影響を**受け取る側のマス**が計算して日ごとに変化する公開マップ。メールアドレス・パスワードの入力に代わりパスキー（WebAuthn）認証を利用する設計です。

## 構成と状態

| 領域 | 実装 |
|---|---|
| マップ | 500×500から開始、ズーム・パン・セル選択・URL座標移動 |
| 履歴とランキング | 日付再生、支配マス・N合計・履歴内出現日数 |
| 侵食エンジン | TypeScriptで決定的に1日1世代を計算 |
| パスキー | 登録・追加・ログイン・ログアウト・再認証後のアカウント削除 |
| 投稿 | 1ユーザー/日1件、同日の変更は最終revisionを採用 |
| DB（開発用） | Node.js実験的node:sqlite、単一ノード |
| DB（Sites対応） | sites/d1-store.mjs、D1 schema migration |
| Sites API | sites/worker.mjs、Fetch API / WebAuthn / D1 / 静的Assets |
| 毎日の確定 | JST日付境界、状態スナップショットの不変化、再実行の重複防止 |
| テスト | Node 22/24、模擬WebAuthn署名・D1互換SQL・API・数値計算・静的表示 |

**現状は「コードの開発版」です。GPT Sitesでの実際のデプロイ、本番D1の準備、実機パスキー認証とセキュリティ監査はまだ実施していません。** CI成功だけを本番公開の合図にしないでください。

## ローカル開発

Node.js 22以上、npm、TypeScript 5.8.3、@simplewebauthn/server 14.0.3、esbuild 0.25.12を想定しています。

```bash
npm install
npm test              # エンジン・DB・API・Worker・UI の自動テスト
npm run dev           # 静的デモ: http://127.0.0.1:4173
npm run dev:full      # ローカルSQLite + パスキー: http://localhost:4173/submit
npm run build:sites   # site/ に静的サイトと _worker.js を生成
npm run preflight     # 本番公開の前提条件を判定（未確認なら失敗）
```

`site/` は生成物であり、Gitにコミットしません。公開リポジトリには生きたDB、個人情報、秘密鍵、セッションCookie、認証チャレンジを置かないでください。

## GPT Sites向けの実装

- `sites/worker.mjs` — Web標準の `fetch` / `scheduled` イベント
- `sites/d1-store.mjs` — 非同期D1 APIへのアクセス
- `migrations/0001_d1_schema.sql` — D1のテーブルと一意制約
- `.openai/hosting.json` — DBバインディング名 `DB` の設定（サイトIDや秘密情報は含めない）
- `scripts/build-sites-worker.mjs` — `site/_worker.js` のバンドル
- `public/` — HTML、CSS、Canvas、パスキー投稿画面

本番環境の設定には次が必要です。

| 設定 | 意味 |
|---|---|
| `DB` | D1データベースバインディング、SQL migration適用済み |
| `ASSETS` | `site/` の静的アセットを配信するバインディング |
| `PUBLIC_ORIGIN` | 最終HTTPSサイトの正確なOrigin |
| `RP_ID` | パスキーの依拠当事者ドメイン |
| `SAME_GLYPH_MODE` | `sum` （従来）または `max` （実験） |
| `N1_OUTBOUND` | `0` （従来）または `1` （実験、max限定） |

サイトの公開操作・D1作成・実運用のスケジュール設定は、このソース管理とは別にGPT Sites上で行います。`scheduled` イベントが利用できない場合は閲覧時に1日分を補完する実装がありますが、厳密な時刻での無訪問更新を保証しません。

## 侵食ルールの未確定点

元の要件にある「通常投稿N=1」と「隣接への影響はN−1」は同時に採用すると、通常投稿が広がらないという矛盾があります。

- [#1](https://github.com/Unjuno/Erosion-map/issues/1): N=1の伝播をどう実現するか
- [#2](https://github.com/Unjuno/Erosion-map/issues/2): 多勢力相殺・同文字の合算などの正式ルール
- [#3](https://github.com/Unjuno/Erosion-map/issues/3): 同文字加算に伴う長期数値オーバーフロー

安全に動かせる比較用プロファイルとして `max + N1_OUTBOUND=1` を実装・検証しています。**元仕様を無断変更しないため本番デフォルトにはしていません。** [ルール比較](docs/RULE-COMPARISON.md)を参照してください。

## 画面

- `/`：マップ・過去履歴・座標指定・ズーム・デモ
- `/submit`：パスキー認証と投稿
- `/ranking`：ランキング
- `/policy`：開発版の情報取り扱い。正式な利用規約・プライバシーポリシーではありません

本番公開には運営者情報・個人情報の保持期間・お問い合わせ先・削除と復旧・広告に関する正式な方針が必要です。

## セキュリティ・ライセンス

開発用レート制限とCSRF防御は本番相当の脅威対策を保証しません。本番DBのバックアップ復元、実機WebAuthn、Origin/RP ID、DoS耐性、日次処理の排他性、負荷評価を公開前に確認してください。現時点でライセンスは未設定です。公開リポジトリは再利用許諾を意味しません。
