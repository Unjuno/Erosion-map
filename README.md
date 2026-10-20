# EROSION MAP — 1日1文字 侵食マップシステム

ユーザーが1日1文字を投稿し、上下左右からの影響を**受け取る側のマス**が比較して支配者を決める、日次マップシミュレーション。

> **現状: 静的な操作可能デモ + 純粋な日次計算エンジン。**
> サイト公開、パスキー認証、本番DB、永続投稿API、日次ジョブは**未実装**です。
> いまの「投稿を試す」はブラウザ内プレビューのみで、保存されません。

## 実装済み

- 500×500マス（各軸-250..249）、拡大縮小、ドラッグ、座標移動、マス選択
- 13日分のデモ履歴、再生・停止・速度調整、ランキング
- 受動型の同期式侵食エンジン、衝突・相殺・包囲
- 日次投稿の最終revision選択、投稿衝突、イベントN、日付チェック（日本時間）
- Node.js自動テストとGitHub Actions CI
- HTML/CSS/JavaScriptの静的サイト書き出し

## 動作方法

必要な環境: Node.js **22以上**、npm。TypeScript 5.8.3で検証します。

```bash
npm install
npm test            # エンジン＋日次生成＋サイトのテスト
npm run dev         # http://127.0.0.1:4173
npm run build:site  # site/ に配信可能な静的ファイルを生成
```

`site/` はデモ表示専用です。実際のユーザー投稿、パスキー認証、DBは含みません。
ビルド結果を配信するときは静的ホストがJavaScriptモジュールを配信できる必要があります。

## 構成

```text
src/engine.ts         1世代の侵食・衝突、スナップショット
src/daily.ts          投稿の最終版選択と日次state生成
src/calendar.ts       ISO日付・Asia/Tokyoの日付判定
public/               操作可能なブラウザ画面（Canvas）
scripts/build-site.mjs  HTML/JS静的ファイルの組み立て
scripts/serve.mjs       ローカルプレビューサーバー（127.0.0.1のみ）
tests/                自動テスト
docs/ALGORITHM.md     計算式、仕様確定点・暫定点
docs/DAILY-PIPELINE.md 日次処理の契約と実装外の責務
docs/HANDOFF.md       ChatGPT Work引継ぎ資料
```

## 正式仕様決定待ち

1. **通常投稿N=1は現在の影響計算(N-1)では広がりません。**
2. 三勢力以上の相殺方式、同じ文字の加算、既存勢力の防御、包囲処理は暫定です。
3. 1日をいつ締め切りどの時点で投稿を固定するか、DBトランザクションの設計が必要です。
4. 最終的なGPT SitesのDB・定期実行・パスキー対応状況は未確認です。

[Issue #1](https://github.com/Unjuno/Erosion-map/issues/1) / [Issue #2](https://github.com/Unjuno/Erosion-map/issues/2)

公開リポジトリであっても、秘密鍵・パスキー秘密情報・投稿者の個人情報・接続文字列は絶対に置かないこと。ライセンスは未設定です。


## 開発用のパスキー + SQLite API

バックエンドを伴うローカルテストでは以下を使用します。

```bash
npm install
npm run dev:full   # http://localhost:4173/account.html
npm run job        # 日本時間で締まった日付のstateをDBへ確定
```

`/account.html` はメール不要のWebAuthn登録・ログイン・投稿を試す画面です。新規登録・追加登録時には対応端末のパスキーが必要です。`/api/me`・`/api/post`・`/api/state`・`/api/history` を実装しています。日付ごとの確定は開発用ジョブを手動で起動してください。公開ホスティングへの反映はしていません。

**本番利用不可**: `server/store.mjs` はNode 22の実験的`node:sqlite` に依存し、単一インスタンス前提です。大規模同時アクセス、複数インスタンス、サーバーレス上の永続性は未検証です。WebAuthn端末実機でのエンドツーエンド検証、HTTPSドメイン・デプロイ・CSRF/DoS・バックアップ・復旧設計が必要です。現段階では個人データを登録して公開運用しないでください。

参照: [SimpleWebAuthn server](https://simplewebauthn.dev/docs/packages/server)。


## 公開履歴の静的書き出し

```bash
npm run export:states
```

永続DBから公開済みのスナップショットだけを `site/data/state-YYYY-MM-DD.json` と `site/data/index.json`、最新の `site/data.js` に書き出します。ユーザーID・パスキー公開鍵・セッション・投稿編集履歴はエクスポートしません。

開発用バックエンド `npm run dev:full` を起動している間は1時間ごとにJST締切済みの日付を確定しようとします。実際の公開環境では永続ジョブと独立したDBを用い、公開前に排他性・バックアップを検証する必要があります。


### 独立したランキング画面

`/ranking.html` は実際の公開スナップショット（API→静的JSON）から順位を算出します。両方利用できない静的デモ環境では `public/demo-data.js` の合成データを使用します。指標は**最新日の支配マス数・N合計・直近30日の出現日数**。出現日数は連続生存期間とは異なり、正式な「生存期間」ルールは未定です。
