# VIELE secretary 社 — 組織・採用記録

> 一人社長向け秘書アプリ **VIELE secretary**（https://viele-secretary.vercel.app）を作る会社の組織。
> CEOが必要人材を採用し、各メンバーは `.claude/agents/` のサブエージェントとして常駐（再利用可）。

## 組織図

```
CEO（ceo）
├─ プロダクト部長（product-director）
│   └─ デザイン課長（design-manager）
│       └─ UIデザイナー（ui-designer）
│   └─ QA/評価（qa-engineer）            ※品質ゲート
├─ エンジニアリング部長/CTO（engineering-director）
│   └─ フロントエンド課長（frontend-manager）
│       ├─ フロントエンドエンジニア（frontend-engineer）
│       └─ バックエンド/インフラエンジニア（backend-engineer）
├─ グロース部長（growth-director）
│   └─ グロース&CS課長（growth-cs-manager）
│       └─ グロースマーケター（growth-marketer）
│
├─ 〔CEO直属・独立〕セキュリティ&プライバシー監査（security-auditor）
├─ 〔横断〕データアナリスト（data-analyst）
└─ 〔顧客諮問パネル＝外部評価〕
    ├─ ハルカ 36 施術家・本人（persona-haruka）
    ├─ ケンジ 42 発信者/ローンチ（persona-kenji）
    ├─ リン 28 独立したて初心者（persona-rin）
    ├─ ヨシコ 54 IT苦手ベテラン（persona-yoshiko）
    └─ タケシ 38 生産性オタク辛口（persona-takeshi）
```

## 採用台帳

| 役職 | エージェント | 階層 | モデル | 主な役割 |
|------|------|------|------|------|
| CEO | `ceo` | 経営 | opus | 方針・採用・最終意思決定 |
| プロダクト部長 | `product-director` | 部長 | opus | 戦略・ロードマップ・要件 |
| エンジニアリング部長(CTO) | `engineering-director` | 部長 | opus | 技術方針・品質・実装可否 |
| グロース部長 | `growth-director` | 部長 | opus | 集客〜継続〜収益のファネル |
| デザイン課長 | `design-manager` | 課長 | sonnet | UX/UI・情報設計・アクセシビリティ |
| フロントエンド課長 | `frontend-manager` | 課長 | sonnet | React実装の設計/レビュー |
| グロース&CS課長 | `growth-cs-manager` | 課長 | sonnet | オンボーディング・継続・要望整理 |
| UIデザイナー | `ui-designer` | 実行 | sonnet | 具体UI仕様 |
| フロントエンドエンジニア | `frontend-engineer` | 実行 | sonnet | UI実装・バグ修正 |
| バックエンド/インフラ | `backend-engineer` | 実行 | sonnet | Firebase/ルール/デプロイ |
| グロースマーケター | `growth-marketer` | 実行 | sonnet | コピー・LP・施策制作 |
| QA/評価 | `qa-engineer` | 評価 | sonnet | 動作検証・品質ゲート |
| セキュリティ監査 | `security-auditor` | 監査 | opus | 独立監査（CEO直属） |
| データアナリスト | `data-analyst` | 横断 | sonnet | KPI・定量化・優先度付け |
| 顧客パネル ×5 | `persona-*` | 外部 | sonnet | ターゲット視点の評価 |

## CEOの採用判断（理由）

- **部長3名（Product/Eng/Growth）**：プロダクトの3本柱。これ以上分けない（リーン）。
- **課長は各部1名**：意思決定の速度優先。中間層を厚くしない。
- **評価担当**：社内QA（`qa-engineer`）＋ 外部の顧客パネル5名（`persona-*`）の二層。客観性のため外部視点を必ず入れる。
- **監査担当**：個人の予定・お金を扱うため、開発から**独立した**セキュリティ&プライバシー監査をCEO直属で設置。
- **データアナリスト**：感覚でなく数値で意思決定するため横断で1名。

### 採用見送り（保留）— 今はリーン優先
- 専任PM → 部長が兼務 ／ 人事 → CEO兼務 ／ 専任法務 → プライバシーは監査がカバー、必要時に外部委託
- 必要になれば CEO 判断で随時採用し本台帳に追記する。

## チームの使い方

各メンバーは Agent ツールで呼べる（例：「`security-auditor` に Firestore ルールを監査させて」「顧客パネルにアプリを評価させて」）。
CEO に統合させる場合は、各メンバーの報告を `ceo` に渡して意思決定を出させる。
