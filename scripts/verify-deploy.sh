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
  REMOTE_HASH=$(curl -s "$PROD_URL" | grep -o 'tane-version" content="[^"]*"' | grep -o '"[^"]*"$' | tr -d '"')
  echo "$REMOTE_HASH"
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
    printf "  待機中... %d秒\r" $((COUNT*5))
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
  echo " → まだデプロイ中か、接続エラーの可能性があります"
  echo " → npm run verify -- --wait で再試行してください"
else
  echo " ❌ バージョン不一致"
  echo " ローカル: $LOCAL_HASH"
  echo " Vercel:   $REMOTE"
  echo " → まだデプロイ中です。しばらく待ってから再実行してください"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
