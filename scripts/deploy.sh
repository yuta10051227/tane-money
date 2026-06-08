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

# 3. ビルド（現時点のHEADをバージョンとして埋め込む）
echo ""
echo "▶ [3/5] ビルド中..."
PRE_HASH=$(git rev-parse --short HEAD)
node scripts/build.js
EXPECTED_VER=$(grep -o 'name="tane-version" content="[^"]*"' index.html | grep -o '"[^"]*"$' | tr -d '"')
echo "✅ ビルド OK (埋め込みバージョン: $EXPECTED_VER)"

# 4. Git commit & push（ビルド済みindex.htmlを含む）
echo ""
echo "▶ [4/5] GitHub へ push 中..."
git add index.html "$JSX" okozukai-v9-stable.jsx manifest.json sw.js icon.svg vercel.json 2>/dev/null || true
git add index.html "$JSX"
git add assets/ 2>/dev/null || true
git commit -m "$MSG

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
git push origin main

# 5. Vercelデプロイ確認（最大2分待機）
echo ""
echo "▶ [5/5] Vercel デプロイ確認中（最大2分）..."
PROD_URL="https://tane-money.vercel.app"
MAX=24
COUNT=0
REMOTE=""
while [ $COUNT -lt $MAX ]; do
  REMOTE=$(python3 - <<'PYEOF'
import urllib.request, ssl, re, sys
ctx = ssl.create_default_context()
req = urllib.request.Request("https://tane-money.vercel.app", headers={
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Accept": "text/html",
  "Cache-Control": "no-cache",
})
try:
  r = urllib.request.urlopen(req, context=ctx, timeout=15)
  c = r.read().decode("utf-8", errors="replace")
  m = re.search(r'tane-version[^>]*content="([^"]+)"', c)
  print(m.group(1) if m else "")
except: print("")
PYEOF
)
  if [ "$REMOTE" = "$EXPECTED_VER" ]; then
    echo ""
    break
  fi
  COUNT=$((COUNT+1))
  printf "  待機中... %d秒 (Vercel: %s)\r" $((COUNT*5)) "${REMOTE:-Security Check中...}"
  sleep 5
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$REMOTE" = "$EXPECTED_VER" ]; then
  echo " ✅ Vercel デプロイ完了！"
  echo " バージョン: $EXPECTED_VER"
  echo " URL: $PROD_URL"
else
  echo " ⚠️  2分経過してもVercelに反映されませんでした"
  echo " 期待値: $EXPECTED_VER  Vercel: ${REMOTE:-取得不可}"
  echo " → npm run verify -- --wait で確認してください"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
