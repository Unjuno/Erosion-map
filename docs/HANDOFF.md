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
