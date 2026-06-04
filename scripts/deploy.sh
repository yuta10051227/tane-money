#!/bin/bash
# Tane Money — デプロイスクリプト
# 使い方: npm run deploy "コミットメッセージ"

set -e

MSG="${1:-"chore: update"}"
JSX="okozukai-v9.jsx"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Tane Money デプロイ開始"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. ソースチェック
echo ""
echo "▶ [1/5] check.py 実行中..."
python3 check.py "$JSX"
echo "✅ チェック OK"

# 2. emoji variation selector 除去
echo ""
echo "▶ [2/5] emoji クレンジング..."
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
echo "▶ [3/5] ビルド中..."
node scripts/build.js
echo "✅ ビルド OK"

# 4. Git commit & push
echo ""
echo "▶ [4/5] GitHub へ push 中..."
git add index.html "$JSX" scripts/build.js okozukai-v9-stable.jsx 2>/dev/null || true
git add index.html "$JSX" scripts/build.js
git commit -m "$MSG

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
git push origin main

LOCAL_HASH=$(git rev-parse --short HEAD)

# 5. Vercelデプロイ確認（最大2分待機）
echo ""
echo "▶ [5/5] Vercel デプロイ確認中..."
PROD_URL="https://tane-money.vercel.app"
MAX=24
COUNT=0
while [ $COUNT -lt $MAX ]; do
  REMOTE=$(curl -s "$PROD_URL" | grep -o 'tane-version" content="[^"]*"' | grep -o '"[^"]*"$' | tr -d '"')
  if [ "$REMOTE" = "$LOCAL_HASH" ]; then
    echo ""
    break
  fi
  COUNT=$((COUNT+1))
  printf "  待機中... %d秒経過\r" $((COUNT*5))
  sleep 5
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$REMOTE" = "$LOCAL_HASH" ]; then
  echo " ✅ Vercel デプロイ完了！"
  echo " バージョン: $LOCAL_HASH"
  echo " URL: $PROD_URL"
else
  echo " ⚠️  2分経過してもVercelに反映されませんでした"
  echo " → vercel.com でデプロイ状況を確認してください"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
