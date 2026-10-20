# ChatGPT Workへの引き継ぎ — Erosion Map

最終整備日: 2026-10-21（JST）
GitHub: https://github.com/Unjuno/Erosion-map
CI: https://github.com/Unjuno/Erosion-map/actions

## ゴール

1人1日1回、パスキー（WebAuthn）のみでログインして座標と1文字を投稿する。同日中は修正でき、最終投稿だけ有効。翌日の受け取り側主体の侵食と衝突を計算し、履歴・ランキング・静的マップを公開する。初期500×500マス、登録人数に応じて拡張。メール認証・パスワードは用いない。

**デプロイ方針**: ユーザー希望はGPT Sites内での構築・DB・公開の完結。ただしGPT Sitesの利用可能なDB仕様、サーバーアクション、定期ジョブ、WebAuthnサポートは未確認。まず実際の提供機能を確認し、互換でない場合はユーザーへ相違点を提示すること。公開GitHubはソース管理であってサイトの実行環境ではない。

## 稼働している部分（ローカル開発用）

| 機能 | 実装場所 | 動作 |
|---|---|---|
| 侵食・衝突 | src/engine.ts | 決定的1日1世代、純関数。暫定規則あり |
| 日付と投稿 | src/calendar.ts / src/daily.ts | JST基準の投稿日、最終revisionを選択 |
| SQLite | server/store.mjs | ユーザー、公開鍵、チャレンジ、セッション、投稿、公開state |
| WebAuthn | server/http.mjs | 署名・Origin・RP ID・userHandle・チャレンジの検証 |
| UI | public/index.html + app.js | 500×500 Canvas、履歴、仮投稿。API公開履歴へ切替可能 |
| パスキー投稿UI | public/account.html + account.js | 本番APIではなく開発APIへ接続 |
| ランキング | public/ranking.html + ranking.js | 公開API→静的ファイル→合成デモの順で取得 |
| 案内 | public/policy.html | 開発版説明のみ、正式法的ポリシーではない |
| 日次ジョブ | scripts/daily-job.mjs / run-server.mjs | ローカル単一ノードで日付を順次確定 |
| 静的配布 | scripts/export-states.mjs | 公開stateだけをSHA-256照合して出力 |
| CI | .github/workflows/ci.yml | Node.js 22、npm test |

## ローカルで再現する手順

\`\`\`bash
npm install
npm test
npm run dev          # http://127.0.0.1:4173 （静的デモのみ）
npm run dev:full     # http://localhost:4173 （開発用SQLite + WebAuthn）
npm run job          # 開発DBの締切済み日を確定
npm run export:states
\`\`\`

Node.js 22以上、TypeScript 5.8.3、SimpleWebAuthn 14.0.3。
\`node:sqlite\` は実験的で、サーバーレス・複数ノードでの本番利用を保証しない。
CIの成功は単体・模擬署名の成功であり、実機パスキー・実際の公開環境の保証ではない。

### 実施済みの主要テスト

- 2勢力・3勢力の相殺、同文字合算、包囲、同期更新、入力順不変。
- Unicode 1書記素、日付妥当性、カレンダー境界（Asia/Tokyo）。
- 一日一件の最終revision、原子的な更新、複数SQLite接続からの順序一貫性。
- 完了済みスナップショットの不変性と再実行時の冪等性。
- 加算型侵食で安全整数の上限を超えた際のDBロールバック。
- 仮想P-256署名器によるWebAuthn正常登録・ログイン・再ログイン・投稿。
- 偽署名、偽Origin、userHandle不一致、チャレンジ再利用の拒否。
- 公開JSONのsha256照合および認証用データ非混入。
- 静的ビルド、既定ルート /・/submit・/ranking・/policy。

## 今すぐ解決すべき設計判断（未承認）

1. https://github.com/Unjuno/Erosion-map/issues/1 — 通常投稿N=1では隣への影響が0。初期値または伝播規則の承認が必要。
2. https://github.com/Unjuno/Erosion-map/issues/2 — 3勢力以上の順次相殺は不定、同文字合算・現住者防御・同期1世代・包囲保持は暫定。
3. https://github.com/Unjuno/Erosion-map/issues/3 — 単一文字の初期N3から52日目に安全整数オーバーフロー。合算方式／上限／減衰／BigIntを決め、365日以上の検証を要求。

**これらを無断で変更しないこと。** 現在の計算結果は正式ゲーム仕様の承認を意味しない。

## Workで優先して実施する作業

1. GPT Sites環境の**実際の**機能（DB、サーバー側処理、独自ドメイン、WebAuthn、スケジューラ、ファイル出力）を調査。
2. 上記Issueを決定表・例・365日回帰テストで解決し、ゲームルールの版を固定。
3. 本番向けDBスキーマに移植。 \`users\` / \`passkeys\` / \`challenges\` / \`sessions\` / \`posts\` / \`day_config\` / \`snapshots\`。個人情報領域と公開stateを分離。
4. 正式ドメインのHTTPS、WebAuthn RP ID/Origin、Cookie、セッション失効、端末実機での認証・復旧を検証。
5. 投稿締切、日次ジョブの排他・失敗復旧・再実行時ハッシュ照合、複数ノード競合、バックアップを実装・テスト。
6. UIの公開state同期、CDNキャッシュ、圧縮、マップ描画、スマートフォン、アクセシビリティ、異常時の表示を検証。
7. 規約、プライバシーポリシー、事業者連絡先、保持・削除ポリシー、広告の可否を決定してから一般公開。
8. 本番公開後に監視・運用手順、復旧テスト、負荷・侵入テストを実施。

## 安全性に関する境界

- \`npm run dev\` は純粋な公開デモ。投稿フォームはローカル画面上のプレビューで、DB保存しない。
- \`npm run dev:full\` は**開発用バックエンド**。暗号的な模擬認証テストを通しても公開サービスとして安全とは限らない。
- パスキーの秘密鍵と生体認証情報を保存しない。DBの公開鍵やセッション情報も公開JSONには出さない。
- SQLite DB、\`.env\`、Cookieの生値・秘密情報はGitHubへ置かない。
- バックエンドにはメモリ内IPレート制限があるが、分散環境・持続DoS対策ではない。
- \`/policy\` は運営主体・連絡先・保持期間が未確定の開発版案内。合法的な本番ポリシーではない。
- GitHub公開リポジトリはソース公開であり、ライセンス未設定。実サービス公開と同義ではない。


## 同文字合算の選択肢（未承認の実験）

`docs/RULE-COMPARISON.md` にsum（現行）とmax（実験）の比較、max時の数値上界証明、365日検証を記載。デフォルトはsumから変更していない。Issue #3解決前に本番ルールへ反映しないこと。
