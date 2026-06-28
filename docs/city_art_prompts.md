# 🏙 「推しカンパニーの街」建物アート 生成プロンプト集
> 庭ホーム（畑）→ 街（推しカンパニー）の見た目変換に必要なドット絵の **画像生成プロンプト**。
> キャラ・建物のアートは**こちらで作成**。このファイルはそのための指示書（チームが用意したプロンプト）。
> 既存の `crop_*.png` と**同じ仕様**で作れば、コードに**ドロップイン**できます。

---

## 0. なぜ「街」か（設計の核）
畑の失敗点＝**作物が「保有日数」でしか育たず、株価の上下が見た目に出なかった**こと。
街では各銘柄＝**1つの建物**。
- **保有して育てる**＝建物が段階的に大きくなる（更地→お店→ビル→ランドマーク）＝コツコツ続ける満足感。
- **株価に連動**＝街全体の「栄え度（天気/空）」と各タイルの `😊▲ / 😴▼%`（実装済み）で**上下を正直に**表現。
- → 「育てる楽しさ」と「株価の正直さ」を**両立**させる。

---

## 1. 全体スタイル（厳守・既存と揃える）
- **形式**：PNG、**透過背景**（背景は完全透明）。むずかしければ **マゼンタ背景 `#FB03FB` 単色**でもOK（こちらでクロマキー抜きします）。
- **画風**：ドット絵（ピクセルアート）。**やさしい・まるい・かわいい**。既存の `crop_apple_*.png` 等と**同じ太さの輪郭・同じパステル調**。
- **視点**：正面〜ほんの少し見下ろし。建物は**画面下端に接地**（足元が下に来る／空中に浮かせない）。
- **キャンバス**：建物 = **128×128px**。**下寄せ**で配置し、上に成長の余白を残す（小さい段階は下半分、大きい段階で上まで使う）。
- **パレット指針**（アプリ基調色に寄せる）：緑 `#34C77B`/`#187A4E`、ゴールド `#E8B83E`、空色 `#3478D4`、生成り背景 `#F7F5EF`。**彩度ひかえめ・角丸・影は淡く**。
- **NG**：写実、グラデ多用、細い線、暗い・こわい雰囲気、ロゴ・実在企業名・実在キャラ、文字（看板の絵記号はOK、読める文章はNG）。

### 共通ネガティブプロンプト（全画像に付ける）
```
photorealistic, 3d render, realistic, gradient-heavy, blurry, thin lines, dark, scary,
text, letters, words, real brand logos, real company names, copyrighted characters,
floating (not grounded), drop shadow on background, white background, noisy background
```

---

## 2. 建物の成長5段階（全社共通の“育ち”ストーリー）
既存の作物と同じく **5枚**（`seed`,`0`,`1`,`2`,`3`）。保有日数で切替（3日/10日/30日）。

| ファイル接尾 | 段階 | 日数めやす | 見た目 |
|---|---|---|---|
| `_seed` | 更地（こうじ） | 0日 | 工事の囲い・コーン・「ここに建つよ」感の更地。土とロープ。 |
| `_0` | 基礎・屋台 | 0日〜 | 小さなプレハブ／屋台。1区画。芽吹いた感じ。 |
| `_1` | 小さなお店 | 3日〜 | 1階建ての小さなお店。ドアと小窓、小さな看板（絵記号）。 |
| `_2` | ビル | 10日〜 | 2〜3階のビル。窓が増え、人の気配。 |
| `_3` | にぎわうランドマーク | 30日〜 | 大きくにぎわう建物。明かり・旗・きらめき。**収穫可（栄えの極み）**。 |

> ポイント：段階が上がるほど **大きく・明るく・にぎやか**に。`_3` は `🌟` が似合う華やかさ。

---

## 3. 各社のプロンプト（実在5銘柄ぶん＝既存アートの置換）
コード対応：`bld_game / bld_studio / bld_auto / bld_food / bld_tech`（後述のマッピングで差し替え）。
各社 **5枚**ずつ（`_seed _0 _1 _2 _3`）。下のベース文に、各段階の「見た目」（§2）を足してください。

**ベース文（共通・各画像の頭に付ける）**
```
cute chunky pixel art, 128x128, transparent background, soft pastel palette,
friendly kawaii city building, front view slightly top-down, grounded at the bottom edge,
thick clean outline matching a children's farming game art style, no text
```

### 🎮 bld_game（ゲーム会社・s1）
- テーマ：ゲーム/アーケード。ネオン控えめ、十字キーやコントローラの絵記号。
- 例（_3）：`a thriving game arcade landmark building with playful controller motif, glowing soft neon signs (icons only, no letters), flags, sparkles, lively`
- 各段階：_seed 更地＋ゲーム機の箱が1つ / _0 小さなガチャ屋台 / _1 小さなゲームショップ / _2 ゲーム会社ビル / _3 にぎわうアーケード。

### 🎵 bld_studio（音楽・メディア・s2）
- テーマ：音楽スタジオ／メディア。音符・レコードの絵記号、やわらかい紫×クリーム。
- 各段階：_seed 更地＋スピーカー箱 / _0 ストリート演奏の小台 / _1 小さなレコード店 / _2 メディアスタジオビル / _3 にぎわうライブホール（音符きらめき）。

### 🚗 bld_auto（自動車・s3）
- テーマ：自動車工場／ディーラー。車・歯車の絵記号、赤×シルバー控えめ。
- 各段階：_seed 更地＋タイヤ / _0 小さな修理屋台 / _1 小さな車屋 / _2 自動車ビル＋ショールーム / _3 にぎわう工場＆ディーラー（旗・車が並ぶ）。

### 🍙 bld_food（食べもの・s4）
- テーマ：レストラン／食。湯気・お皿の絵記号、あたたかいオレンジ×クリーム。
- 各段階：_seed 更地＋食材カゴ / _0 小さな屋台（湯気） / _1 小さな食堂 / _2 レストランビル / _3 にぎわう人気店（行列の気配・ちょうちん）。

### 💡 bld_tech（テック・s5）
- テーマ：テック企業タワー。りんご型は避け、電球/新芽/回路の絵記号、白×ミントグリーン。
- 各段階：_seed 更地＋小さな機械箱 / _0 小さなラボ小屋 / _1 小さなテックショップ / _2 ガラスのオフィスビル / _3 にぎわうテックタワー（屋上に光る新芽マーク）。

---

## 4. 架空の学習用5銘柄（任意・あると最高）
親が値動きを操作して「増える/下がる感覚」を教えるための架空銘柄。建物にすると街がにぎやか。
対応ID：`f1🌱コツコツ食品 / f2🚀ロケットゲームズ / f3🎈バブルソーダ / f4⛅おてんき牧場 / f5💎きらめき鉱山`
- `bld_f1`：芽のマークの食品工場（堅実・あたたかい緑）
- `bld_f2`：ロケットのゲーム会社（わくわく・乱高下のイメージで少し派手）
- `bld_f3`：炭酸ソーダの店（ポップ・はじける泡、はかなさ＝急落の暗喩）
- `bld_f4`：おてんき牧場（のんびり・横ばい、雲と牧草）
- `bld_f5`：きらめき鉱山（宝石、じわっと光る）
各5段階（_seed〜_3）。§2の成長ストーリーに合わせる。

---

## 5. 地面・区画・空（街の下地）
| ファイル名 | サイズ | 内容 |
|---|---|---|
| `street_tile.png` | **128×128** | 街路のタイル（敷石/舗装）。**上下左右くり返せる**シームレス。やさしい灰みベージュ。`soil_tile.png` の街版。 |
| `lot_empty.png` | **96×96** | 空き区画（建てる前の土台）。やわらかい緑地＋点線の区画ライン。`plot_empty.png` の街版。 |
| `lot_thriving.png` | **96×96** | にぎわい区画（栄えた建物の足元）。ほんのり光る舗装＋花壇。`plot_ripe.png` の街版。 |
| （任意）`sky_city_morning/noon/sunset.png` | **1536×253** | 街の空バナー（朝/昼/夕）。シンプルな空でOK（既存 `sky_*.png` 流用も可）。 |

ネガティブ（地面・空）：`buildings on the ground tile, characters, text, harsh contrast, photorealistic`

---

## 6. 受け取り方・差し替え（こちら側でやること）
1. 画像を `assets/` に**この名前で**置く（透過 or マゼンタ背景）。マゼンタなら抜き処理します。
2. コードに以下を足すだけで庭→街に差し替わります（crop はフォールバックに残すので壊れません）：
   ```js
   const CITY_ART = { s1:"bld_game", s2:"bld_studio", s3:"bld_auto", s4:"bld_food", s5:"bld_tech",
                      f1:"bld_f1", f2:"bld_f2", f3:"bld_f3", f4:"bld_f4", f5:"bld_f5" };
   // CropArt を BuildingArt に切替（stage→建物段階）、soil_tile→street_tile、plot_*→lot_* に差し替え。
   ```
3. 1枚でも欠けると**自動で絵文字にフォールバック**（`onError`）。**全部そろわなくても出せます**＝段階リリースOK。

## 7. 最小セット（まず4枚で動作確認）
全部待たずに、まず **`bld_game_seed/_1/_2/_3`** の4枚だけ作ってもらえれば、1社で「更地→お店→ビル→ランドマーク」の差し替えを実機確認できます。OKなら他社へ展開。

---

## 付録：1枚ぶんの完成プロンプト例（コピペ用・bld_game_3）
```
cute chunky pixel art, 128x128, transparent background, soft pastel palette,
friendly kawaii city building, front view slightly top-down, grounded at the bottom edge,
thick clean outline matching a children's farming game art style, no text,
a thriving game arcade landmark, playful controller and joystick motifs (icons only),
glowing soft neon accents, little flags and sparkles, lively and welcoming, mint-green and gold palette
--neg photorealistic, 3d render, realistic, gradient-heavy, blurry, thin lines, dark, scary,
text, letters, words, real brand logos, real company names, copyrighted characters,
floating, white background, noisy background
```
