#!/usr/bin/env python3
import re, sys

path = sys.argv[1] if len(sys.argv) > 1 else "okozukai-v9.jsx"
content = open(path, "r", encoding="utf-8").read()

REQUIRED = [
    ("cloudSave", "データ保存"),
    ("cloudLoad", "データ読込"),
    ("migrate", "マイグレーション"),
    ("ParentDailyTab", "毎日タスク管理"),
    ("ParentScreen", "親管理画面"),
    ("ChildScreen", "子ども画面"),
    ("DailyTasks", "毎日タスク"),
    ("OshiKabu", "推し株"),
    ("Tutorial", "チュートリアル"),
    ("TabHint", "タブヒント"),
    ("BadgesSection", "バッジ"),
    ("TipsSection", "豆知識"),
    ("TaskCustomizer", "タスクカスタマイザー"),
    ("WeeklyReport", "週次レポート"),
    ("GoalCelebration", "目標達成演出"),
    ("ChildAvatar", "子どもアバター"),
    ("SortBar", "並び替えバー"),
    ("PinInput", "PIN入力"),
    ("HomeScreen", "ホーム画面"),
    ("GachaAnim", "ガチャアニメ"),
    ("applyInterest", "利子システム"),
    ("fetchRealStockPrices", "株価取得"),
]
missing = [
    "{} ({})".format(l, fn)
    for fn, l in REQUIRED
    if ("function " + fn) not in content
]

lines = content.count("\n")
size = len(content.encode("utf-8"))
print("=== Tane Money Check ===")
print("Lines:{} Size:{:,}bytes".format(lines, size))
print(
    "Functions: ALL OK ({})".format(len(REQUIRED))
    if not missing
    else "MISSING: " + ", ".join(missing)
)
print("=======================")

import subprocess

parse_result = subprocess.run(
    [
        "node",
        "-e",
        'const fs=require("fs");const src=fs.readFileSync("{}","utf8");try{{require("@babel/parser").parse(src,{{plugins:["jsx"],sourceType:"module"}});console.log("PARSE_OK");}}catch(e){{console.log("PARSE_ERROR:"+e.message);}}'.format(
            path
        ),
    ],
    capture_output=True,
    text=True,
)
parse_ok = "PARSE_OK" in parse_result.stdout

raw_jsx = [
    r
    for r in re.findall(r'\n\s*(?:effectiveTab|tab)==="[\w]+"&&', content)
    if "{" not in r
]

lucide = [
    "Bell",
    "Sprout",
    "Star",
    "Flame",
    "Heart",
    "Lock",
    "Trophy",
    "BarChart2",
    "Users",
    "Shield",
    "BookOpen",
    "Home",
    "CheckSquare",
    "Target",
    "ClipboardList",
]
lucide_used = [c for c in lucide if re.search(rf"<{c}[\s/>]", content)]

deleted_used = []
for v in ["O", "Y", "SHADOW"]:
    if not re.search(rf"^const {v}\s*=", content, re.MULTILINE):
        if re.search(rf"(?<![A-Za-z_$0-9]){v}(?![A-Za-z_$0-9])", content):
            deleted_used.append(v)

import os
html_path = os.path.join(os.path.dirname(os.path.abspath(path)), "index.html")
html_conflict = False
if os.path.exists(html_path):
    html_content = open(html_path, "r", encoding="utf-8").read()
    html_conflict = bool(re.search(r'^<{7} |^>{7} |^={7}$', html_content, re.MULTILINE))

jsx_conflict = bool(re.search(r'^<{7} |^>{7} |^={7}$', content, re.MULTILINE))

print("=== 追加チェック ===")
print(f"パース: {'OK' if parse_ok else 'NG: ' + parse_result.stdout.strip()}")
print(f"生JSXコード: {'なし' if not raw_jsx else '★あり! ' + str(raw_jsx)}")
print(f"lucide残骸: {'なし' if not lucide_used else '★あり! ' + str(lucide_used)}")
print(f"削除済み変数: {'なし' if not deleted_used else '★あり! ' + str(deleted_used)}")
print(f"コンフリクトマーカー(JSX): {'なし' if not jsx_conflict else '★あり! <<<<<<< が残っています'}")
print(f"コンフリクトマーカー(HTML): {'なし' if not html_conflict else '★あり! <<<<<<< が残っています'}")
print("==================")
sys.exit(
    1
    if (missing or not parse_ok or raw_jsx or lucide_used or deleted_used or jsx_conflict or html_conflict)
    else 0
)
