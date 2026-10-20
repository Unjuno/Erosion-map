# ChatGPT Workへの引継ぎ — Erosion Map

## 主な目的

1日1回、パスキーで認証したユーザーが座標と1文字を投稿。同じ日なら再編集可。日付ごとの侵食・相殺の状態を保存し、500×500から拡張される世界を閲覧・再生する。

ソース: https://github.com/Unjuno/Erosion-map
ソースはPublic。本番サイト・ログイン・投稿データはまだ公開していない。

## 現時点で動くもの

- Node.js 22 / TypeScript 5.8.3。`npm test` で純粋な計算と静的画面のビルドを検証。
- `npm run dev` でローカルデモを表示（永続データは扱わない）。
- `src/engine.ts`、`src/daily.ts`、`src/calendar.ts` は副作用のない関数。
- `public/` にCanvas画面、マス選択・ランキング・時系列再生・投稿プレビュー。
- `npm run build:site` で `site/` に静的ファイル生成。GPT Sitesへの取り込み方式は要確認。

## 本番化するための必須作業（優先順）

1. **仕様確定**: `docs/ALGORITHM.md` とIssue #1/#2。N=1が拡大しない問題と3勢力相殺・同文字合算等をユーザーと確定。
2. **本番DBの実装**: users、passkey_credentials、session、posts（変更履歴）、daily_snapshots。PK/FK、一意制約、ACL、インデックスを指定する。GPT Sitesの実際のDB機能に合わせる。
3. **パスキーWebAuthn**: 登録とログインのchallenge、RP ID/origin、署名・user verification・challengeの検証、counterと失効、複数パスキー、セッションCookie。サーバー側の検証を必須とする。メールは原則使わない。
4. **投稿API**: 認証済みユーザーID、現在のAsia/Tokyoの日付、文字と座標のサーバー側バリデーション、同日revisionを原子的に採番、レート制限とCSRF対策。
5. **日次バッチ**: 1日1回のサーバー実行（ジョブ重複排除）、投稿締切、DBの整合スナップショット、日次状態のimmutable保存、再実行時は同一結果照合、エラー通知。
6. **本番マップ接続**: 閲覧専用の公開APIで日付別stateとランキングを取得。private credentialsなどを含めない。部分読み込み・圧縮・キャッシュ。
7. **運用と配信**: 公開ドメイン、HTTPS、CSP、Cookie制限、広告/プライバシー、監査・バックアップ・障害復旧・負荷テスト。

## 特に重要な注意

- このデモの「投稿を試す」は認証もDB保存も行わない。これを本番投稿として使ってはいけない。
- 通常N=1では広がらない。デモ初期勢力や選択可能な強さN>1は「侵食の見え方」を検証するためで、ゲームルールの変更を承認した意味ではない。
- ローカルの静的サイトは公開環境で安全にユーザー認証を受け付けられない。
- `resolveCollision` は同文字合算、最大勢力と他勢力総和との差分による暫定実装。本仕様の「順次相殺」と異なる可能性がある。
- GPT Sitesに必要なバックエンドAPI、DB、WebAuthn、ジョブがあるか必ず調査してから技術を確定する。
- GitHubに個人情報・秘密情報を投入しない。公開前にライセンス・規約・プライバシーポリシーを確認する。

## 動作再現

```bash
npm install
npm test
npm run dev
```

## 次の検証の例

- データ整合性: 同一(user,day)の最後のrevisionのみ確定。
- DB競合: 同時POST100回を負荷試験し、revision番号の一意性を検証。
- ジョブ冪等性: 同じ入力の重複起動で同一stateハッシュを保証。
- WebAuthn: 不正署名、origin/RP ID不一致、期限切れchallengeをすべて拒否。
- UI: 500×500表示、1px以下へのズーム、履歴再生、キーボード操作を確認。


## 追加実装（SQLite + WebAuthn開発API）

- `server/store.mjs`: Node 22 `node:sqlite` （experimental）によるユーザー・公開鍵・セッション・投稿・日次state永続化。開発用途のみ。
- `server/http.mjs`: @simplewebauthn/server 14.0.3を使った登録・ログイン・複数パスキー追加、署名/Challenge/Origin/RP検証、投稿API。
- `public/account.html`: ブラウザ認証・投稿の開発画面。静的デモではAPIがないため非対応。
- `npm run dev:full`: ローカルの認証APIつきサイト起動、`npm run job`: 締切済み日付をDBへ確定。
- シミュレーション表示のメイン画面は、まだローカルデモデータ固定。本番公開DBとの閲覧API統合が必要。
- パスキー端末の実機認証テストは手動で要実施。HTTPテストはオプション発行・不正挑戦の拒否を検査するが実機フローの正当性を保証しない。


## ブロッカー: 長期増幅

https://github.com/Unjuno/Erosion-map/issues/3 の実測により、暫定同文字合算ルールは単一N3から52日後に安全整数を超える。長期運用する日次ジョブを有効にする前に、合算方式・上限・減衰・BigIntなどの選択を正式決定し、最低365日の回帰試験を行うこと。


## 公開用の状態ファイル

`npm run export:states` は非公開DBから、公開されてもよいスナップショットのみを `site/data/state-YYYY-MM-DD.json`、`site/data/index.json`、`site/data.js` に書き出す。ユーザー認証や投稿のDBはエクスポートしない。GPT Sitesへファイルを運ぶ場合はこの出力を候補にできるが、日次計算の自動実行と安全な配信は別途構築が必要。
