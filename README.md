# Meme Scout（Solanaミームコイン発掘＋通知＋学習）

24時間サーバーで動き、**収集 → 安全チェック → 評価 → iPhoneへ通知 → 結果の答え合わせ → 学習** を自動で繰り返します。
自動売買はしません（通知のみ。秘密鍵はサーバーに置きません）。
外部ライブラリは使っていません（Node.js 22 だけで動きます）。

## 何を見ているか

| データ | 取得元 | 用途 |
|---|---|---|
| 新規トークン・卒業・売買 | PumpPortal WebSocket（無料） | dev保有、発行3秒以内の買い（スナイパー）、初期勢の含み益玉、新規買い手の数、VWAP |
| 価格・流動性・出来高 | DexScreener API（無料） | 時価総額、流動性、買い/売り比、値動き、答え合わせ |
| 安全性・保有集中 | RugCheck API（無料） | Mint/Freeze権限、危険な拡張、上位ホルダー、インサイダー |
| 売れるか | Jupiter Quote（無料） | ハニーポット検出、売却時の価格インパクト |
| コミュニティ | Telegram公開チャンネル（CAVE_JPN） | 投稿からCAを自動抽出して評価・加点 |
| BB（Discord） | アプリの「チェック」に投稿を貼る | 自動取得は規約上しない（セルフBot禁止） |
| ウォレット | 自動発掘 + 手動/一括登録 + Solana Tracker(任意) | スマートマネー保有、KOLの売り抜け検知 |
| クラスタ | Bubblemaps API（任意・キーがあれば） | つながったウォレット群の供給シェア |

## 判定の流れ
1. **足切り**（1つでも該当で除外）: Mint/Freeze権限、危険な拡張、ラグ済、流動性不足、上位10>30%、単独>5%、クラスタ>15%、dev>5%、スナイパー>20%、量産dev、売却不可、売却インパクト>15%、古すぎ
2. **確率**: 「手数料込みで+100%と−40%のどちらに先に届くか」の確率。最初は初期ルール、データが貯まると学習モデル
3. **タイミング**: 5分で+60%以上、または30分VWAPより+50%以上なら「押し目待ち」で監視継続（6時間）
4. **期待値**: p×(利確−コスト) − (1−p)×(損切り+コスト) が +5% 以上 かつ 損益分岐の確率以上なら通知
5. **答え合わせ**: 評価したトークンは（除外したものも）24時間追跡。結果は「成績」タブへ。毎時再学習。除外条件ごとの「実は上がった率」も表示

数値はすべてアプリの「設定」で変更できます。

## かんたん設置（PCなし・iPhoneだけ）
Oracleでインスタンスを作るとき「拡張オプションの表示 → 管理 → cloud-initスクリプトの貼付け」に以下を貼るだけで、自動で設置されます（3か所を書き換え）。
```bash
#!/bin/bash
export DOMAIN=myscout.duckdns.org
export TOKEN=好きなパスワード（英数字20文字以上）
export DUCKDNS_TOKEN=DuckDNSのtoken
curl -fsSL https://raw.githubusercontent.com/s14-114ws-cloud/Meme-coin/main/deploy/cloud-init.sh | bash
```
作成後10分ほどで `https://myscout.duckdns.org` が開けるようになります。進み具合はサーバーの `/var/log/memescout-setup.log` に記録されます。
毎日4時（日本時間）にGitHubの最新版へ自動更新されます。

## Oracle Cloud Always Free への設置（PCから手動で）

### 1. サーバーを作る
1. Oracle Cloud にサインアップ（クレジットカード登録あり、Always Free の範囲なら課金されない）
2. 「コンピュート → インスタンス → インスタンスの作成」
   - イメージ: **Ubuntu 24.04**
   - シェイプ: **VM.Standard.A1.Flex（Ampere, 1 OCPU / 6GB）** がおすすめ。東京で「容量不足」と出たら **VM.Standard.E2.1.Micro** でも動きます
   - 「SSHキー」をダウンロードして保存
3. 作成後、インスタンスの「サブネット → セキュリティ・リスト → イングレス・ルールの追加」で
   ソース `0.0.0.0/0`・TCP・宛先ポート **80** と **443** を追加

> 注意: Always Free のインスタンスは長期間ほぼ使われていないと回収されることがあります。このアプリは常に動くので通常は問題になりにくいですが、気になる場合はアカウントを「従量課金（Pay As You Go）」にアップグレードすると回収対象外になります（無料枠内なら請求は0円）。

### 2. 無料のドメインを取る（iPhoneのプッシュ通知にはHTTPSが必須）
1. https://www.duckdns.org にログインし、サブドメイン（例 `myscout`）を作成
2. 「current ip」にOracleインスタンスの**パブリックIP**を入力して update

### 3. ファイルを置いてセットアップ
PCのターミナル（Macならターミナル、WindowsならPowerShell）で:
```bash
scp -i 鍵ファイル memescout.zip ubuntu@パブリックIP:~
ssh -i 鍵ファイル ubuntu@パブリックIP
sudo apt-get update && sudo apt-get install -y unzip
unzip memescout.zip && cd memescout
bash deploy/setup.sh myscout.duckdns.org
```
最後に表示される **ACCESS_TOKEN** をメモ（アプリのログインに使います）。
PCがない場合は、Oracleの画面右上の「Cloud Shell」からも同じ操作ができます（zipは Cloud Shell のメニュー「アップロード」で送る）。

### 4. iPhoneで
1. Safariで `https://myscout.duckdns.org` を開く → ACCESS_TOKENでログイン
2. 共有ボタン →「ホーム画面に追加」
3. **ホーム画面のアイコンから開き直して**「通知をオン」→ テスト通知が届けば完了

## 運用
- ログ: `journalctl -u memescout -f`
- 再起動: `sudo systemctl restart memescout`
- 更新: 新しいzipを展開して上書き → 再起動（`data/` と `.env` は残す）
- データ: `data/memescout.db`（SQLite）。バックアップはこのファイルをコピー

## 進め方のおすすめ
1. **最初の2〜4週間は買わずに観察**。「成績」タブの「通知した」の平均（手数料込み）がプラスで、件数が30件以上になってから少額で
2. 「除外条件の見直し」で「実は2倍」率が高い条件だけ少しゆるめる
3. Bot手数料・実際の滑りを「往復コスト」に正しく入れる（ここが甘いと期待値が過大になる）
4. 有料APIは、成績がプラスになってから（Helius $49/月 などで取りこぼしを減らす）

## 制限
- 価格の答え合わせは1分ごと。1分以内の急な上下は捉えきれない（損切り優先で保守的に判定）
- スナイパー・初期勢の分析は、サーバー起動後に発行された pump.fun トークンのみ
- devの「量産」判定もサーバー起動後のデータから。使うほど精度が上がる
- 個人利用向け。シグナルを他人に有料配信する場合は法規制に注意

## 開発
```bash
npm test     # オフラインテスト
npm start    # 起動
```
