# Tane Money — Claude Code ハンドオーバー文書
> このドキュメントをClaude Codeの最初のメッセージに貼り付けてください。

---

## プロジェクト概要

**アプリ名:** Tane Money（タネマネー）  
**コンセプト:** 「お金は、未来を育てるタネ。」家族向けポイント管理PWA  
**URL:** https://tane-money.vercel.app  
**GitHub:** https://github.com/yuta10051227/tane-money  
**ファミリーコード:** TANE-YUTA  

---

## ファイル構成

```
tane-money/（GitHubリポジトリ）
├── index.html          ← デプロイ対象（Babelコンパイル済みJS埋め込み）
├── vercel.json         ← Vercel SPAルーティング設定
├── manifest.json       ← PWA設定
└── okozukai-v9.jsx     ← ソースJSX（参照用・直接デプロイ不可）
```

**ローカル作業ファイル（Claude.ai outputs/）:**
```
okozukai-v9.jsx         ← 本番ソース（5,000行・約353KB）
okozukai-v9-stable.jsx  ← 安定版バックアップ
index.html              ← デプロイ済みHTML（Babel変換済み）
check.py                ← デプロイ前チェックスクリプト
TANE_MONEY_RULES.md     ← 開発ルール
```

---

## 技術スタック

| 項目 | 内容 |
|------|------|
| UI | React 18（Babel CDN、ビルドレス） |
| 状態管理 | useState / useEffect（全コンポーネントで完結） |
| DB | Firebase Firestore（リアルタイム同期） |
| ホスティング | Vercel（自動デプロイ） |
| フォント | Noto Sans JP + M PLUS Rounded 1c（Google Fonts） |
| アイコン | 絵文字 + 自前SVG（lucide-react **不使用**） |

---

## デザインシステム

### カラー定数（変更禁止）

```javascript
const BG    = "#F7F5EF";   // 背景（アイボリー）
const CARD  = "#FFFFFF";   // カード背景
const CARDS = "#F2EFE7";   // サブカード背景
const GP    = "#187A4E";   // メイングリーン（ヘッダー・強調）
const G     = "#34C77B";   // ブライトグリーン（CTA・プラスpt）
const GS    = "#DDF3E7";   // グリーン薄（バッジ背景）
const GOLD  = "#E8B83E";   // ゴールド（バッジ・称号）
const GOLDS = "#FFF1CB";   // ゴールド薄
const R     = "#D95C55";   // レッド（マイナスpt・警告）
const RS    = "#FCE6E4";   // レッド薄
const B     = "#3478D4";   // ブルー（情報・為替）
const BS    = "#E5F0FF";   // ブルー薄
const P     = "#7B61C9";   // パープル（目標・特典）
const PS    = "#EFEAFE";   // パープル薄
const TEXT  = "#18231D";   // メインテキスト
const TEXTS = "#59645E";   // サブテキスト
const MUTED = "#929B95";   // ミュートテキスト
const BORDER= "#E8E3D8";   // ボーダー
```

**削除済み（使用禁止）:** `O`（旧orange）, `Y`（旧gold）, `SHADOW`（旧shadow定数）

### フォント

```javascript
const F  = "'Noto Sans JP','Hiragino Kaku Gothic ProN',sans-serif";  // 本文
const FB = "'M PLUS Rounded 1c','Hiragino Maru Gothic ProN',sans-serif"; // ロゴ・強調
```

---

## アーキテクチャ

### 画面遷移（screen state）

```
home
  ├── pin-child   → child（ChildScreen）
  ├── pin-parent  → parent（ChildScreen ※親もChildScreenを使用）
  ├── family_public（FamilyPublicScreen）
  ├── family_guardian（FamilyGuardianScreen）
  └── pin-reset
```

### 主要コンポーネント（行番号は現時点）

| コンポーネント | 行 | 役割 |
|--------------|-----|------|
| `HomeScreen` | L3389 | メンバー選択画面 |
| `ChildScreen` | L1369 | 子ども＋親のメイン画面（共通） |
| `ParentScreen` | L2727 | 旧親管理画面（現在未使用） |
| `FamilyPublicScreen` | L2510 | ファミリー公開ランキング |
| `FamilyGuardianScreen` | L2665 | 親専用管理（子の詳細） |
| `InvestLearnTab` | L2449 | 投資・為替学習タブ |
| `InvestTab` | L4042 | 株式シミュレーション |
| `ForexSection` | L3848 | 為替シミュレーション |
| `BadgesSection` | L4324 | バッジ一覧 |
| `DailyTasks` | L726 | 毎日タスク |
| `TaskManagerSection` | L899 | お手伝いタスク管理 |

### ChildScreenのタブ体系

```
MAIN_TABS（Teen）: daily / activity / money / learn / more
MAIN_TABS（Junior）: daily / tasks / goals / more

tabAlias（旧名→新名マッピング）:
  tasks→activity, invest→activity
  kakeibo→money, goals→money, rewards→money
  log→more, badges→more, tips→more, ranking→more, gacha→daily

moneyタブのサブタブ（monTab state）:
  goals（目標）/ rewards（こうかん）/ kakeibo（家計簿）

moreタブのサブタブ（moreOpen state）:
  "log"（履歴）/ "badges"（バッジ）/ "ranking"（ランキング）

activityタブのサブタブ（actTab state）:
  "tasks"（お手伝い）/ "bad"（マイナス）/ "invest"（投資）
```

---

## データ構造（INIT）

```javascript
const INIT = {
  parentPin: "0000",
  children: [
    { id:"c1", name:"れいか", emoji:"🌸", pin:"1111", ageMode:"middle",
      displayMode:"teen", role:"child", gradeLabel:"中学生",
      permissions:{investment:"trade", forex:"trade", dailyBonus:true, ranking:true},
      visibility:{balanceToFamily:"hidden", goalToFamily:"progress_only",
                  investmentResultToFamily:"ranking_only",
                  rankingParticipation:true, operationRankingParticipation:true}
    },
    { id:"c2", name:"かなと", emoji:"⚡", pin:"2222", ageMode:"senior",
      displayMode:"teen", role:"child", gradeLabel:"高校生", ... }
  ],
  parents: [
    { id:"p1", name:"パパ", emoji:"👨", pin:"3333",
      displayMode:"adult", role:"parent", participationMode:"player_and_guardian",
      permissions:{investment:"trade", forex:"trade"}, ... },
    { id:"p2", name:"ママ", emoji:"👩", pin:"4444", ... }
  ],
  logs: [],          // {id, cid, type, label, pts, date, rid?}
  goals: [],         // {id, cid, label, target, done}
  goodTasks: [...],  // お手伝いタスク
  badTasks: [...],   // マイナスタスク
  stocks: [...],     // 株式データ（5銘柄）
  forex: {...},      // 為替データ（5通貨）
  holdings: {},      // {memberId: [{stockId, qty, avgCost}]}
  forexHoldings: {}, // {memberId: {USD:10, EUR:5, ...}}
  goals: [],
  rewards: [...],    // こうかん商品
  badges: [...],
  tips: [...],       // まめちしき
  streak: {},        // {memberId: {cur, max, lastDate}}
  gachaDate: {},
  noPinIds: {},
  familySettings: {
    parentPointRule: "partner_approval",
    operationRanking: {enabled:true, rankingBasis:"return_rate", includeFees:true},
    familyMission: {enabled:true, label:"みんなの活動で 3,000 pt を育てよう", target:3000}
  }
}
```

### ログtype一覧（変更禁止）

```
good      お手伝い完了
bad       マイナス行動
daily     毎日タスク完了
grant     手動付与
reward    こうかん使用
gacha     デイリーボーナス（旧ガチャ）
interest  利子
invest_buy  株式購入
invest_sell 株式売却
forex_buy   為替購入
forex_sell  為替売却
badge     バッジ獲得
tips      まめちしき読了
```

---

## デプロイ手順（Claude Code用）

```bash
# 前提: Node.js + @babel/core @babel/preset-react @babel/parser がインストール済み

# 1. チェック（必ず最初に実行）
python3 check.py okozukai-v9.jsx

# 2. emoji variation selector 除去 + JSX保存
python3 -c "
import re, shutil
c = open('okozukai-v9.jsx','r',encoding='utf-8').read()
c = re.sub(r'[\uFE0F\uFE0E\u200D\u200B\uFEFF]','',c)
open('okozukai-v9.jsx','w',encoding='utf-8').write(c)
shutil.copy2('okozukai-v9.jsx','okozukai-v9-stable.jsx')
print('JSX saved')
"

# 3. Babelコンパイル
node -e "
const babel=require('@babel/core'), fs=require('fs');
const jsx=fs.readFileSync('okozukai-v9.jsx','utf8');
const code=jsx
  .replace('import React, { useState, useEffect, useCallback } from \"react\";','')
  .replace('export default function App()','function App()');
const result=babel.transformSync(code,{presets:['@babel/preset-react'],filename:'app.jsx'});
fs.writeFileSync('app.js',result.code);
console.log('Compiled:', result.code.length, 'chars');
"

# 4. index.html へ差し替え
python3 -c "
import shutil
js   = open('app.js','r',encoding='utf-8').read()
html = open('index.html','r',encoding='utf-8').read()
START = '<script>\nconst { useState, useEffect, useCallback } = React;\n\n'
END   = '\nfunction FamilySetup({'
si = html.find(START)
ei = html.find(END)
new_html = html[:si+len(START)] + js + html[ei:]
open('index.html','w',encoding='utf-8').write(new_html)
print('index.html updated:', len(new_html), 'bytes')
"

# 5. GitHub push → Vercel自動デプロイ
git add index.html okozukai-v9.jsx okozukai-v9-stable.jsx
git commit -m "fix: <変更内容を一行で>"
git push
```

---

## check.py の内容（コピー用）

```python
#!/usr/bin/env python3
import re, sys
path = sys.argv[1] if len(sys.argv)>1 else 'okozukai-v9.jsx'
content = open(path,'r',encoding='utf-8').read()

REQUIRED = [
    ("cloudSave","データ保存"),("cloudLoad","データ読込"),("migrate","マイグレーション"),
    ("ParentDailyTab","毎日タスク管理"),("ParentScreen","親管理画面"),
    ("ChildScreen","子ども画面"),("DailyTasks","毎日タスク"),
    ("InvestTab","投資タブ"),("ForexSection","為替"),("StockChart","株グラフ"),
    ("Tutorial","チュートリアル"),("TabHint","タブヒント"),
    ("BadgesSection","バッジ"),("TipsSection","豆知識"),
    ("TaskCustomizer","タスクカスタマイザー"),("WeeklyReport","週次レポート"),
    ("GoalCelebration","目標達成演出"),("ChildAvatar","子どもアバター"),
    ("SortBar","並び替えバー"),("PinInput","PIN入力"),
    ("HomeScreen","ホーム画面"),("GachaAnim","ガチャアニメ"),
    ("applyInterest","利子システム"),("fetchRealStockPrices","株価取得"),
]
missing = ["{} ({})".format(l,fn) for fn,l in REQUIRED if ("function "+fn) not in content]

lines = content.count('\n')
size  = len(content.encode('utf-8'))
print("=== Tane Money Check ===")
print("Lines:{} Size:{:,}bytes".format(lines,size))
print("Functions: ALL OK ({})".format(len(REQUIRED)) if not missing else "MISSING: "+", ".join(missing))
print("=======================")

# 追加チェック
import subprocess
parse_result = subprocess.run(
    ['node','-e',f'const fs=require("fs");const src=fs.readFileSync("{path}","utf8");try{{require("@babel/parser").parse(src,{{plugins:["jsx"],sourceType:"module"}});console.log("PARSE_OK");}}catch(e){{console.log("PARSE_ERROR:"+e.message);}}'],
    capture_output=True, text=True
)
parse_ok = 'PARSE_OK' in parse_result.stdout

# 生JSXコード検出（{なしで条件式が剥き出し）
raw_jsx = [r for r in re.findall(r'\n\s*(?:effectiveTab|tab)==="[\w]+"&&', content) if '{' not in r]

# lucide残骸
lucide = ['Bell','Sprout','Star','Flame','Heart','Lock','Trophy','BarChart2',
          'Users','Shield','BookOpen','Home','CheckSquare','Target','ClipboardList']
lucide_used = [c for c in lucide if re.search(rf'<{c}[\s/>]', content)]

# 削除済みカラー定数
deleted_used = []
for v in ['O','Y','SHADOW']:
    if not re.search(rf'^const {v}\s*=', content, re.MULTILINE):
        if re.search(rf'(?<![A-Za-z_$0-9]){v}(?![A-Za-z_$0-9])', content):
            deleted_used.append(v)

print("=== 追加チェック ===")
print(f"パース: {'OK' if parse_ok else 'NG: '+parse_result.stdout.strip()}")
print(f"生JSXコード: {'なし' if not raw_jsx else '★あり! '+str(raw_jsx)}")
print(f"lucide残骸: {'なし' if not lucide_used else '★あり! '+str(lucide_used)}")
print(f"削除済み変数: {'なし' if not deleted_used else '★あり! '+str(deleted_used)}")
print("==================")
sys.exit(1 if (missing or not parse_ok or raw_jsx or lucide_used or deleted_used) else 0)
```

---

## 開発ルール（必読）

### 1. タブ変更は3点セット

```
MAIN_TABS配列 + tabAlias + render側のeffectiveTab条件式
この3つを同時に変えないと動かない or エラーになる
```

### 2. サブタブはstateで分岐

```jsx
// NG: 同一effectiveTabを複数render（全部同時に表示される）
{effectiveTab==="money" && <家計簿/>}
{effectiveTab==="money" && <目標/>}

// OK: stateで1つだけ表示
{effectiveTab==="money" && monTab==="kakeibo" && <家計簿/>}
{effectiveTab==="money" && monTab==="goals" && <目標/>}
```

### 3. 変数スコープを確認

- 新コンポーネントを書くとき、使う変数がスコープ内で定義済みか確認
- `O`, `Y`, `SHADOW` は削除済み → それぞれ `P`, `GOLD`, `"0 4px 16px rgba(24,35,29,0.06)"` を使う
- lucide-reactは未インポート → 絵文字か自前SVGで代替

### 4. str_replace前に必ずview

- 前回編集後の状態を確認してから置換
- 置換対象が1箇所のみであることを確認

### 5. デプロイ前は必ずcheck.py

```bash
python3 check.py okozukai-v9.jsx
# exit code 0 でなければデプロイしない
```

---

## Firebase設定

```javascript
const firebaseConfig = {
  apiKey: "...",
  authDomain: "tane-money.firebaseapp.com",
  projectId: "tane-money",
  storageBucket: "tane-money.appspot.com",
  messagingSenderId: "...",
  appId: "..."
};
// Firestoreコレクション構造:
// family_codes/{familyCode}/config  ← データ本体
// family_codes/{familyCode}/logs    ← ログ（別管理）
```

---

## PIN一覧（テスト用）

| メンバー | PIN |
|---------|-----|
| れいか | 1111 |
| かなと | 2222 |
| パパ | 3333 |
| ママ | 4444 |
| おや管理（ParentScreen） | 0000 |

---

## 既知の未実装・TODO

- [ ] ParentScreen（旧）は未使用状態（現在は親もChildScreenを使用）
- [ ] FamilyPublicScreen/FamilyGuardianScreenへの画面遷移導線が未整備
- [ ] 運用ランキング（FamilyPublicScreen）の実データ接続
- [ ] まめちしき（tips）の初期データ追加
- [ ] Junior（小学生）モードの本格対応

---

## このドキュメントについて

作成日: 2026-06  
作成元: Claude.ai（claude-sonnet-4-6）  
次の作業はClaude Codeで引き継いでください。
