#!/bin/bash
# Tane Money — デプロイスクリプト
# 使い方: npm run deploy "コミットメッセージ"
# 例:     npm run deploy "fix: ランキングボタンのデザイン修正"

set -e  # エラーが起きたら即停止

MSG="${1:-"chore: update"}"
JSX="okozukai-v9.jsx"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Tane Money デプロイ開始"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. ソースチェック
echo ""
echo "▶ [1/4] check.py 実行中..."
python3 check.py "$JSX"
echo "✅ チェック OK"

# 2. emoji variation selector 除去
echo ""
echo "▶ [2/4] emoji クレンジング..."
python3 -c "
import re, shutil
c = open('$JSX','r',encoding='utf-8').read()
c = re.sub(r'[️︎‍​﻿]','',c)
open('$JSX','w',encoding='utf-8').write(c)
shutil.copy2('$JSX','okozukai-v9-stable.jsx')
print('JSX saved & backed up')
"

# 3. ビルド
echo ""
echo "▶ [3/4] ビルド中..."
node scripts/build.js
echo "✅ ビルド OK"

# 4. Git commit & push
echo ""
echo "▶ [4/4] GitHub へ push 中..."
git add index.html "$JSX" okozukai-v9-stable.jsx
git commit -m "$MSG

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
git push origin main

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ✅ デプロイ完了！"
echo " Vercel が自動デプロイ中（約30秒）"
echo " https://tane-money.vercel.app"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
