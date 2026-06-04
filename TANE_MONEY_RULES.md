# Tane Money 開発ルール & バグ防止チェックリスト

## 根本原因の分類（過去に発生したバグ）

| # | エラー | 根本原因 | 再発防止 |
|---|--------|---------|---------|
| 1 | 生コードが画面表示 | JSX `{` が無いまま条件式が書かれた | パースチェック必須 |
| 2 | Can't find variable: O | 旧カラー定数名 `O` が削除されたが参照が残った | 未定義変数スキャン必須 |
| 3 | Can't find variable: activeParentId | 未定義変数を新コードで参照 | 未定義変数スキャン必須 |
| 4 | タブバーが2重表示 | 旧タブバーを削除せず新タブバーを追加 | str_replace前に対象範囲確認 |
| 5 | ためるタブでエラー | tab alias で3画面が全て"money"に集約され同時描画 | タブ描画数チェック必須 |
| 6 | タブ押してもコンテンツ出ない | MAIN_TABS変更後、render側の条件式を変えなかった | タブ整合性チェック必須 |

---

## デプロイ前 必須チェック（毎回実行）

```bash
python3 /mnt/user-data/outputs/tane-money-dev/check.py /tmp/tane-work.jsx
```

check.py が検出するもの：
- パースエラー（生コード表示バグ）
- 未定義変数（single-letter var）
- 重複タブバー（MAIN_TABS.map の複数描画）
- lucide-react残骸（インポート無しコンポーネント）
- 同一effectiveTab条件の過剰重複

---

## タブ変更の鉄則

### MAIN_TABS を変更したら必ず3点セットで変える

```
① MAIN_TABS = [...] の配列
② tabAlias = { 旧名: "新名" } のマッピング
③ render側の effectiveTab==="X" 条件式
```

**この3つが揃っていないとタブが動かない or エラーになる。**

### タブ内にサブタブが必要な場合

```jsx
// NG: 同じeffectiveTabで複数のブロックを並べる（同時描画される）
{effectiveTab==="money" && <家計簿/>}
{effectiveTab==="money" && <目標/>}   // ← 同時に両方描画される！

// OK: stateで分岐する
{effectiveTab==="money" && monTab==="kakeibo" && <家計簿/>}
{effectiveTab==="money" && monTab==="goals" && <目標/>}
```

---

## 変数の鉄則

### カラー定数一覧（現在の正式定義）

```
BG="#F7F5EF"  CARD="#FFFFFF"  CARDS="#F2EFE7"
GP="#187A4E"  G="#34C77B"     GS="#DDF3E7"
GOLD="#E8B83E" GOLDS="#FFF1CB"
R="#D95C55"   RS="#FCE6E4"
B="#3478D4"   BS="#E5F0FF"
P="#7B61C9"   PS="#EFEAFE"
TEXT="#18231D" TEXTS="#59645E" MUTED="#929B95" BORDER="#E8E3D8"
```

**削除済み（使用禁止）:** `Y`（旧gold）, `O`（旧orange）, `SHADOW`（旧shadow）

### 新コンポーネントを追加するときのチェック

```
□ 使う変数は全てその関数スコープ内で定義されているか
□ 親コンポーネントから props で受け取るものはあるか
□ グローバル関数（uid, bal, addLogToFirestore 等）は存在するか
□ lucide-react アイコンを使っていないか（絵文字か自前SVGを使う）
```

---

## コード編集の鉄則

### str_replace を使う前に必ず確認

```
1. view で現在の状態を確認（前回編集後の内容）
2. 置換対象が 1箇所のみ であることを確認
3. 置換後に必ずパースチェック
```

### 関数のスコープを意識する

- ChildScreen 内の変数（myBal, child, isJunior 等）は ChildScreen 外で使えない
- ParentScreen 内で activeParentId のような変数を参照するなら必ずその関数内で定義する

---

## デプロイ手順（確立済み）

```bash
# 1. 作業コピー
cp /mnt/user-data/outputs/okozukai-v9.jsx /tmp/tane-work.jsx

# 2. 編集

# 3. チェック（必須）
python3 /mnt/user-data/outputs/tane-money-dev/check.py /tmp/tane-work.jsx

# 4. emoji variation selector 除去 + 保存
python3 -c "
import re,shutil
c=open('/tmp/tane-work.jsx','r',encoding='utf-8').read()
c=re.sub(r'[\uFE0F\uFE0E\u200D\u200B\uFEFF]','',c)
open('/mnt/user-data/outputs/okozukai-v9.jsx','w',encoding='utf-8').write(c)
shutil.copy2('/mnt/user-data/outputs/okozukai-v9.jsx','/mnt/user-data/outputs/okozukai-v9-stable.jsx')
"

# 5. Babelコンパイル
cd /tmp && node -e "
const babel=require('@babel/core'),fs=require('fs');
const jsx=fs.readFileSync('/mnt/user-data/outputs/okozukai-v9.jsx','utf8');
const code=jsx.replace('import React, { useState, useEffect, useCallback } from \"react\";','').replace('export default function App()','function App()');
const result=babel.transformSync(code,{presets:['@babel/preset-react'],filename:'app.jsx'});
fs.writeFileSync('/tmp/app.js',result.code);
"

# 6. index.html 差し替え
python3 -c "
import shutil
js=open('/tmp/app.js','r',encoding='utf-8').read()
html=open('/mnt/user-data/outputs/index.html','r',encoding='utf-8').read()
s='<script>\nconst { useState, useEffect, useCallback } = React;\n\n'
e='\nfunction FamilySetup({'
si=html.find(s);ei=html.find(e)
nh=html[:si+len(s)]+js+html[ei:]
open('/mnt/user-data/outputs/index.html','w',encoding='utf-8').write(nh)
"

# 7. present_files → GitHub Upload → Vercel自動デプロイ
```
