#!/bin/bash
# Vercelデプロイ確認スクリプト
# 使い方: npm run verify
# 　　　　npm run verify -- --wait   # デプロイ完了まで待つ

PROD_URL="https://tane-money.vercel.app"
WAIT_MODE=false
[[ "$1" == "--wait" ]] && WAIT_MODE=true

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOCAL_HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Tane Money デプロイ確認"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ローカル: $LOCAL_HASH"
echo " 確認先:   $PROD_URL"
echo ""

check_remote() {
  # Python3でモバイルUA使用（Vercel Security Checkpointを回避）
  python3 - <<'PYEOF'
import urllib.request, ssl, sys, re
ctx = ssl.create_default_context()
req = urllib.request.Request(
  "https://tane-money.vercel.app",
  headers={
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "ja-JP,ja;q=0.9",
  }
)
try:
  r = urllib.request.urlopen(req, context=ctx, timeout=15)
  content = r.read().decode("utf-8", errors="replace")
  m = re.search(r'name="tane-version"\s+content="([^"]+)"', content)
  if m:
    print(m.group(1))
  else:
    m2 = re.search(r'tane-version[^>]*content="([^"]+)"', content)
    if m2:
      print(m2.group(1))
    else:
      print("")
except Exception:
  print("")
PYEOF
}

if $WAIT_MODE; then
  echo "▶ デプロイ完了を待機中..."
  MAX=24  # 最大2分
  COUNT=0
  while [ $COUNT -lt $MAX ]; do
    REMOTE=$(check_remote)
    if [ "$REMOTE" = "$LOCAL_HASH" ]; then
      break
    fi
    COUNT=$((COUNT+1))
    printf "  待機中... %d秒 (Vercel: %s)\r" $((COUNT*5)) "${REMOTE:-取得中...}"
    sleep 5
  done
  echo ""
else
  REMOTE=$(check_remote)
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$REMOTE" = "$LOCAL_HASH" ]; then
  echo " ✅ デプロイ完了！"
  echo " ローカル = Vercel: $LOCAL_HASH"
elif [ -z "$REMOTE" ]; then
  echo " ⚠️  バージョン情報が取得できません"
  echo " → まだデプロイ中か、Vercel Security Checkpointが応答"
  echo " → npm run verify -- --wait で再試行してください"
else
  echo " ❌ バージョン不一致"
  echo " ローカル: $LOCAL_HASH"
  echo " Vercel:   $REMOTE"
  echo " → まだデプロイ中です。しばらく待ってから再実行してください"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
