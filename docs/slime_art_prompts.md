# ✨ ひみつ系統「スラリル」アート生成プロンプト集
> 用途：隠しタネモン「スラリル」(全7段階)の自作アート用。画像生成AI（Midjourney / DALL·E / Stable Diffusion / Niji 等）にそのまま貼って使えます。
> 方針：かわいい青いスライムが「転生→名付け→竜の友→魔人→竜魔王」と育つ、オリジナルキャラ。日本の異世界スライムRPG風の世界観。

---

## 0. スタイルバイブル（全段階で共通＝これを毎回の頭に付ける）

**英語（推奨。Midjourney/SD系）**
```
cute original mascot creature, chibi kawaii style, soft cel-shaded anime illustration,
glossy translucent blue slime material, big sparkling round eyes with white highlight,
gentle friendly smile, thick clean outline, soft rim light, pastel sky-blue palette
(#6db8ff base, #2a9fe0 shade, white gloss), centered single character, full body,
front view, plain transparent background, sticker / game sprite style, no text
```
**日本語補足**：ぷるぷる半透明の青スライム素材／大きなキラキラした丸い目／やさしい笑顔／太めの輪郭線／パステル水色／中央に1体・全身・正面・**背景透過**。

**共通ネガティブ（除外）**
```
realistic, scary, sharp teeth, dark gore, text, watermark, signature, multiple characters,
cropped, extra limbs, busy background, photo, 3d render noise, low quality, jpeg artifacts
```

**一貫性のコツ（同じ子に見せる）**
- 同じ **seed** を固定（SD/Niji）。MJは `--cref <段階1の画像URL> --cw 70` で顔を引き継ぐ。
- まず **段階2「スラっこ」** を作って“基準キャラ”に。以降は基準画像を参照に差分進化させる。
- 各段階「正面 front」と「横向き side」を同プロンプトで角度だけ変えて2枚ずつ。
- 出力は正方形・透過PNG。

---

## 1. 各段階プロンプト（段階＝アプリのID）

### 🥚 srimu_egg「ひかるしずく」（タマゴ／rarity5）
```
[STYLE BIBLE] +
a perfectly round plump egg-droplet made of glossy translucent sky-blue jelly,
very smooth and chubby, jiggly soft surface, big soft inner glow,
a few gentle darker-blue droplet spots, one big bright sparkle on top,
no face, calm and magical, squishy and adorable
```
JP：**まんまるで ぷっくり**した、つやつや半透明の青ジェルのタマゴ。なめらかで ぷるぷる。内側がやわらかく発光、青い水玉、上に大きなキラッ。顔なし。

### 💧 srimu1「スラっこ」（転生したて／最弱だけど元気）← **基準キャラ**
```
[STYLE BIBLE] +
a very round chubby baby blue slime, big plump jelly dome shape, super glossy and jiggly,
huge round innocent eyes (extra large, with two white sparkle highlights each),
tiny happy smile, soft rounded cheeks, pure cheerful and squishy, gentle bounce,
nothing else on body, maximum cuteness
```
JP：**まんまる・ぷくぷく**の赤ちゃん青スライム。つやつや・ぷるぷるのジェルドーム。**瞳は特大**で、それぞれに白いキラキラ2つ。ちいさな笑顔、やわらかいほっぺ。装飾なし、**かわいさ最大**。**この子を基準に**。

### ✨ srimu2「うつしスライム」（見たものを“うつす”まねっこ名人）
```
[STYLE BIBLE] +
a curious blue slime that copies shapes, faint white sparkle motes floating around it,
its surface shimmering as if mimicking, slightly bigger than baby, playful look
```
JP：周りに白いキラキラの粒。表面が“うつし”でちらっと光る。少し大きく、いたずらっぽい表情。

### 🏷 srimu3「なまえスライム」（名前をもらって成長・絆）
```
[STYLE BIBLE] +
a blue slime that just received a name, a small glowing golden name-tag ribbon at its side,
a faint warm halo arc above its head, proud and happy, a touch larger and brighter
```
JP：横に光る金色のネームタグ（リボン）、頭上にうっすら温かいハロー（光の弧）。誇らしげ。

### 🌪 srimu4「あらし竜の友」（嵐の子竜と仲よし・竜の力めばえ）
```
[STYLE BIBLE] +
a teal-blue slime gaining dragon power, small cream-colored dragon horns,
tiny translucent wind-wings, faint swirling wind/cyan aura around it,
a small spark of lightning beside it, brave excited expression
```
JP：少し青緑寄り。クリーム色の小さな竜のツノ、半透明の風の翼、シアンの渦オーラ、横に小さな稲妻。勇ましい表情。

### 🔮 srimu5「あおの魔人」（人型もとれる青き魔人・やさしいリーダー）
```
[STYLE BIBLE] +
a humanoid magic-being form of the blue slime, slender chibi figure wearing a deep-blue
hooded cloak, silver-blue bangs framing a cute slime-skinned face, calm reliable smile,
faint magic glow, still clearly the same blue character
```
JP：青いスライム肌のチビ人型。濃紺のフード付きローブ、銀青の前髪。落ち着いた頼れる笑顔。**同じ青キャラと分かるように**。

### 👑 srimu_u「竜魔王スラリル」（究極体・やさしき竜の魔王）
```
[STYLE BIBLE] +
the ultimate form: a majestic but kind dragon-demon-king slime, golden crown,
elegant golden dragon horns, large translucent dragon wings, royal purple-and-gold aura,
floating sparkles, regal yet gentle benevolent expression, hero of its little kingdom
```
JP：金の王冠、金の竜ツノ、大きな半透明の竜の翼、紫×金のオーラ、舞うキラキラ。威厳がありつつ“やさしい王”の表情。

---

## 2. 各段階そろえる枚数 & 書き出し（アプリに入れる用）

各段階につき最低 **正面1枚**（無くても可：横2枚）。アニメ用に下記をそろえると“ぴょこぴょこ”動きます。

| いる枚数 | ファイル名（assets/ に置く） |
|---|---|
| 正面4コマ | `monster_<ID>_f0.png` 〜 `_f3.png` |
| 横向き2コマ | `monster_<ID>_side_f0.png` 〜 `_f1.png` |

- `<ID>` は：`srimu_egg / srimu1 / srimu2 / srimu3 / srimu4 / srimu5 / srimu_u`
- サイズ **320×320 / 透過PNG**。4コマは「少し縦に潰れる→伸びる」の差分でOK（ジャンプ感）。
- 横向きは正面を少し横に傾け、目を片側に寄せるだけでOK。
- **今は仮のドット絵が入っています。** 同じファイル名で上書きすれば、そのまま反映されます（コード変更不要）。

## 3. 1枚で4コマを作る近道
正面を1枚作ったら、画像編集で「縦95%/横105%」と「縦105%/横95%」の2バリエ＋元＝計3〜4コマにすると、十分かわいく弾みます。AIで4枚バラバラに作るより**キャラがブレません**（推奨）。

---

### メモ
- 名前・デザインはすべて本作オリジナル（特定作品のキャラ名・絵柄の複製ではありません）。世界観は「異世界スライムRPG風」の一般的な雰囲気で寄せています。
- この系統は**表に出さない隠し枠**：保護者の「設定→付与」から対象の子を開くと「✨ ひみつのタマゴをプレゼント」ボタンで配布できます。
