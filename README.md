# light-3dcad

**ブラウザだけで動く、日本語ネイティブのパラメトリックCAD。** サーバー側の処理は一切なく、静的
ファイルの配信だけで完結します(GitHub Pages想定)。インストール不要・アカウント登録不要で、URLを
開けばそのままスケッチから3Dモデリングまで行えます。

- **純日本製・日本語ネイティブ**: UI・ドキュメント・エラーメッセージ・拘束の説明文まで日本語で
  設計されています。
- **ブラウザ完結**: Replicad/opencascade.js(WASM)によるB-Rep演算、PlaneGCS(WASM)によるスケッチ
  拘束求解を含め、すべてブラウザ内(Web Worker)で実行します。データはサーバーへ送信されません。
- **SolidWorks風の操作感**: フィーチャーツリー、リボンUI、標準ビュー切替など、既存のパラメトリック
  CADに馴染みのある人が直感的に使える操作体系を採用しています。

## 主な機能

- **スケッチ + 拘束ソルバ**: 矩形・円・円弧・スロット・正多角形・自由な線分/円弧、寸法駆動編集、
  フィレット/面取り、[PlaneGCS](https://github.com/Salusoft89/planegcs)(FreeCAD Sketcherと同じ2D
  幾何拘束ソルバのWASM移植版)による一致・平行・垂直・接線・距離などの幾何拘束
- **押し出し・回転体・フィレット/シェル・ねじ**: New Body/Cut/Addの押し出し、X/Y軸回転体、3D
  エッジ/面への直接フィレット・面取り、シェル(中抜き)、ISO並目ねじ(M3〜M12)
- **マルチボディ・簡易アセンブリ**: 複数ボディの管理、部品(別`.l3dcad`)の配置・移動、干渉
  チェック、合致(メイト: 一致/距離/同軸)
- **STL・STEP出力 / `.l3dcad`保存**: 3DプリントやCAM向けのSTLエクスポート、他CADとの受け渡し用
  STEPエクスポート、ブラウザ内(localStorage)への自動保存とプロジェクトファイルの保存・読み込み
- **モデルギャラリー**: リボンの「ギャラリー」リンクから、コミュニティが投稿したモデル(PRで
  `models/`に追加)を静的なページ(`/gallery/`)で閲覧し、「開く」でそのままアプリに読み込めます
  (投稿方法は[CONTRIBUTING.md](./CONTRIBUTING.md#モデルギャラリーコミュニティモデル共有について)参照)
- **AI生成(Anthropic / OpenAI、BYOキー)**: 自然言語プロンプトからパラメトリックモデルを生成。
  自分のAPIキーを使うBYOK方式で、サーバー側の仲介はありません(詳細は後述)
- **SolidWorks風UI**: フィーチャーツリー、リボンツールバー、標準ビュー切替、ヘッズアップビュー
  クラスタなど

## 使い方(基本操作の例)

以下の8ステップを一通り実行できます。

1. XY平面に2Dスケッチを作成する
2. 長方形を数値寸法で定義する
3. 閉じた長方形を押し出して3Dソリッドを作成する
4. 生成された平面をクリックして選択する
5. 選択した面を新しいスケッチ平面にする
6. その面に円を配置する
7. 円を使用して押し出しカットを行う
8. 最終形状をSTLとして出力する

フィーチャーツリーで各フィーチャーを選択して寸法を編集すると、自動的に再評価されて3D表示に
反映されます(パラメトリック編集)。

押し出しはNew Body/Cut/Addの3操作に対応し、スケッチ線・選択中スケッチのグリッドを3Dビューに
常時可視化します。矩形・円に加えて、クリックで頂点を繋いで閉じた多角形プロファイルを描く線描画
モード(頂点/中点/原点への優先順位付きスナップ、水平・垂直±5度の軸ロック、数字キーでの長さ指定、
Esc/Enterでのキャンセル・確定)にも対応しています。

スケッチ図形には寸法ラベル(矩形の幅・高さ、円の半径、多角形の各辺の長さ・角度)を常時表示し、
ラベルをクリックすると数値編集ポップアップで寸法駆動編集ができます(始点固定・終点/半径/幅高さ
のみ更新する決定的ルール)。また、多角形の各頂点には個別にフィレット(丸め)または面取り(角の
斜めカット)をサイズ指定でき、スケッチ線オーバーレイもフィレット・面取り後の実形状(円弧・直線
近似)に一致して表示されます。

入れ子プロファイルは自動的に穴として差分押し出しされ、SolidWorks風の標準ビュー切替とスケッチ
専用のフィレット/面取りツール、円弧・スロット・正多角形エンティティ、自由な線分・円弧セグメント
の作図とトリムツールにも対応しています。スケッチ拘束は「寸法」ツールでセグメント本体をクリック
すると長さ・半径拘束を、端点を2つ順にクリックすると2点間距離拘束を作成・編集でき、拘束由来の
寸法は黒背景の強調ラベルで常時表示され(実測ラベルと区別)、拘束一覧パネルで種類・対象・値を
確認して個別削除できます。拘束が矛盾する変更を加えた場合は直前の変更を自動的に取り消します。

ボディ自体を直接編集する3Dフィーチャーとして、ボディのB-Repエッジ・面をビューア上で直接クリック
して選ぶ3Dフィレット/面取り・シェル(中抜き)、スケッチ矩形をX/Y軸まわりに回転させる回転体
(Revolve)があります。ねじフィーチャーではISO並目(M3〜M12)のプリセットから雄ねじ(呼び径円柱+
ヘリカルなねじ山リブ)を実形状として配置でき、雌ねじは規格の下穴径(呼び径-ピッチ)の穴を開ける
簡易表現になります。雄ねじは長さに応じて再評価に数秒〜十数秒かかるため、20mmの長さ上限を設けて
います。

プロジェクトの保存・読み込み(`.l3dcad`形式、JSON)に対応し、ドキュメント変更のたびにlocalStorage
へ自動保存(500msデバウンス)して次回起動時に復元します。STLに加えてSTEP形式(`.step`)での
エクスポートにも対応しています。

複数ボディにも対応しています。New Bodyの押し出し/回転体を何度でも追加でき、Cut/Addは対象ボディ
(既定は最後に作られたボディ)を編集パネルで選んで個別に適用できます。フィレット/面取り・シェル・
ねじは全ボディを横断した幾何マッチングで最も一致するボディへ自動的に適用されます。

簡易アセンブリ(部品配置)にも対応しています。「部品を配置」ボタンから別の`.l3dcad`ファイルを
選ぶと、その部品を丸ごと埋め込んだ状態で位置・回転(度、X→Y→Z順)を指定して配置でき、部品側の
重い評価結果はキャッシュされ位置・回転の変更だけでは再計算されません(部品の中に部品を入れる
入れ子は不可)。部品のボディを直接ドラッグして位置を動かせる「部品移動」、全ボディをペアごとに
交差判定して重なりを赤表示する「干渉チェック」に加え、部品と他のボディの面を2つ選んで一致・
距離・同軸の関係を満たすよう位置・回転を自動的に解く「合致(メイト)」ツールがあります。合致は
数値ソルバ(Levenberg-Marquardt法)で解き、ドラッグ等で位置がずれても再評価のたびに合致を満たす
配置へ引き戻されます。

スケッチ拘束ソルバは、FreeCADのSketcherが使う実績のある2D幾何拘束ソルバ
[PlaneGCS](https://github.com/Salusoft89/planegcs)(WASM移植版、LGPL-2.1-or-later)を採用して
います。全拘束種別に対応し、一致チェーンで繋がった線分群が円に接するまで剛体的に動く必要がある
ケース等の複合的な拘束問題も解けます。PlaneGCSはメインバンドルには含めず動的importで別チャンク化
しているため、初回表示の読み込みサイズへの影響はごくわずかです。アプリ起動時にバックグラウンドで
初期化を開始し、完了前の(アプリ起動直後のごく短い)ウィンドウにドキュメント更新が発生した場合は
初期化完了を待ってから解きます。

## AIモデル生成

ツールバーの「AI生成」ボタンから、自然言語のプロンプト(例:「幅100 高さ50 厚み10の板の中央に
φ20の穴」)でモデルを生成できます。ブラウザから[Anthropic API](https://console.anthropic.com/)
または[OpenAI API](https://platform.openai.com/)を直接呼び出す方式(BYOK、Bring Your Own Key)で、
サーバー側の仲介は一切ありません。プロバイダはパネル上部のドロップダウンでAnthropic(Claude)/
OpenAI(GPT)から選べます。

- **APIキーが必要です**。プロバイダごとに[Anthropic Console](https://console.anthropic.com/)
  または[OpenAI Platform](https://platform.openai.com/)で取得したAPIキーをパネルに入力してくだ
  さい。キーはこの端末のlocalStorageに(プロバイダごとに別々のキーとして)保存され、選択中の
  プロバイダのAPI以外には送信されません。
- **APIコストはユーザー負担です**(BYOKのため)。生成1回あたりのコストは選択したモデル・プロンプト
  の長さ・自己修復リトライ回数(最大3回)により変動します。既定モデルはAnthropicがClaude Opus 5
  (Claude Sonnet 5 / Claude Haiku 4.5も選択可)、OpenAIがGPT-5.5(GPT-5.4 / GPT-5.4 miniも選択可、
  またはテキスト欄への直接入力で任意のモデルIDを指定可能)です。生成前に想定コストを把握したい
  場合は、各プロバイダの料金ページで使用予定モデルの入出力トークン単価を確認してください。
- **APIキー無しでも使えます**。「詳細」から「プロンプト仕様をコピー」して外部のAIチャット
  (ChatGPT等)に貼り付け、返ってきたJSONを本アプリに貼り付けて読み込む経路も用意しています。
- 生成されたモデルは通常のフィーチャーツリーとして読み込まれ、以降は数値編集・寸法駆動編集など
  既存の機能でそのまま編集できます。
- LLMが出力する形式は内部の`CadDocument`ではなく、専用の「アウソリングJSON」
  (`src/ai/authoringSchema.ts`)です。生成→検証(`src/ai/compile.ts`)→スケッチ拘束求解→評価の
  いずれかに失敗した場合、エラー内容をAIへ伝えて自動的に再生成します(最大3回)。両プロバイダとも
  構造化出力(JSON Schema)でこのスキーマに従ったJSONを強制します。
- 応答は「設計メモ(実寸/機能要件/主要寸法表/造形方針)」を先に書かせるdesign-first方式で生成
  され、寸法が一意に決まらない指示に対しては最大3問までの質問モード(1セッション1ラウンドのみ)
  でユーザーの意図を確認します。

## 技術スタック

- **React + TypeScript + Vite** — UIとビルド
- **Three.js** — 3D表示と面のRaycastピック(表示専用。CAD演算は行わない)
- **Replicad + opencascade.js(WASM)** — B-Rep形状の生成・ブーリアン演算。Web Worker内でのみ実行
  し、UIスレッドをブロックしない。内部で利用しているOpenCascade Technology(OCCT)自体は
  **LGPL-2.1**です(詳細は[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)を参照)
- **PlaneGCS**(`@salusoft89/planegcs`、WASM、**LGPL-2.1-or-later**) — 2Dスケッチの拘束ソルバ。
  動的importでメインバンドルから分離しています。ライセンス条文は
  `node_modules/@salusoft89/planegcs/LICENSE`を参照してください
- **Zustand** — ドキュメント状態(フィーチャー列)とUI状態の管理
- **@anthropic-ai/sdk / openai** — AIモデル生成(BYOK、Anthropic/OpenAIの2プロバイダ対応)。
  いずれも動的importでメインバンドルから分離しており、AI生成パネルを開かない限り読み込まれません
- **Vitest** — 単体・統合テスト
- **Playwright** — E2E動作検証(サブパス配信検証等)

正本データはフィーチャー列(`src/model/`)であり、Three.jsのメッシュはWorkerでの評価結果から
都度導出される派生表示です。

## ディレクトリ構成

```
src/
├── ai/           # AIモデル生成(アウソリングJSONスキーマ・コンパイラ・生成ループ、純粋TS+動的import)
├── app/          # Reactシェル(レイアウト・ツールバー)
├── components/   # フィーチャーツリー、スケッチ/押し出し編集パネル、AI生成パネル
├── model/        # 正本。フィーチャーデータの型と操作(純粋TS)
├── project/      # プロジェクトファイル(.l3dcad)のserialize/deserialize(純粋TS)
├── sketch/       # スナップ・軸ロック・寸法駆動編集・コーナー幾何等の純粋TSロジック
├── state/        # Zustandストア(ドキュメント状態+UI状態)
├── worker/       # CADカーネル側。Replicad/OpenCascadeはここに閉じ込める
├── protocol/     # Worker⇔UIのメッセージ型
├── viewer/       # Three.jsシーン・カメラ・面ピック
└── export/       # STLダウンロード
tests/            # Vitest
e2e/              # Playwright E2E
```

## 開発コマンド

```bash
npm install

npm run dev        # 開発サーバー起動(base=/)
npm run build      # 型チェック(tsc -b)+ 本番ビルド(dist/)
npm test           # Vitest(単体・統合テスト)
npm run e2e        # Playwright E2E
npm run size       # メインバンドルサイズの回帰チェック
npx tsc --noEmit -p tsconfig.app.json   # アプリコードの型チェックのみ
npx tsc --noEmit -p tsconfig.e2e.json   # E2Eコードの型チェックのみ
```

## デプロイ(GitHub Pages)

デフォルトブランチへのpush、または手動実行(workflow_dispatch)で `.github/workflows/deploy.yml`
が起動し、ビルド成果物をGitHub Pagesへ配置します(トリガー対象のブランチ名はワークフローファイル
内で指定しています。リポジトリの既定ブランチを変更した場合はあわせて更新してください)。

- ビルド時に `GITHUB_PAGES=true` を渡すことで、Viteの `base` をプロジェクトサイトのサブパス
  `/light-3dcad/` に切り替えます(`vite.config.ts` 参照)。ローカル開発時は未設定のままでよく、
  `base=/` で動作します。任意のサブパスにしたい場合は `BASE_PATH` 環境変数で上書きできます。
- ワークフローは「検証ジョブ(型チェック→テスト→ビルド)→デプロイジョブ(Pagesへ配置)」の2段
  構成です。検証に失敗するとデプロイは実行されません。
- **リポジトリ設定側の作業が必要です**: GitHubリポジトリの Settings → Pages で、Source を
  **「GitHub Actions」** に変更してください(デフォルトの「Deploy from a branch」のままだと
  ワークフローからのデプロイが反映されません)。

## スクリーンショット

現時点ではスクリーンショットをリポジトリに含めていません(バイナリ資産をコミットしない方針の
ため)。まずは`npm run dev`で実際に触っていただくのが手っ取り早いです。

## ライセンス

本リポジトリ自体は [MIT License](./LICENSE) です(Copyright (c) 2026 PlugBits)。

Replicad/opencascade.js経由で利用しているOpenCascade Technology(OCCT)、および2Dスケッチ拘束
ソルバのPlaneGCS(`@salusoft89/planegcs`)は、それぞれ**LGPL-2.1系**のライセンスで配布されている
コンポーネントです。いずれもWASMバイナリを無改変・動的importで利用しており、本体のMITライセンス
とは独立して扱っています。依存ライブラリのライセンス一覧・OCCT/PlaneGCSソースの入手方法については
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)を参照してください。

## コントリビュート

バグ報告・機能提案・Pull Requestを歓迎します。開発環境のセットアップ、テストゲート、コミット
規約については[CONTRIBUTING.md](./CONTRIBUTING.md)を参照してください。

## 既知の制約

- **複数ボディ対応**。New Bodyを何度でも追加でき、押し出し/回転体のCut・Addは対象ボディを指定
  (未指定時は最後に作られたボディ)して個別に適用できます。ただしCutは指定した1ボディからのみ
  減算します(全ボディ横断のカットには対応していません)。フィレット/面取り・シェル・ねじは全
  ボディの中から幾何マッチングで最も一致するボディに自動的に適用されます。ボディ間の位置合わせは
  合致(メイト)で一致/距離/同軸の3種のみ対応しています。パターン配置・機構的な可動範囲の定義・
  部品ライブラリ等の本格的なアセンブリ機能はまだありません。
- **スケッチ平面はXYワールド平面と、選択済み平面(面)上のみ**。任意平面や作業平面の作成はできません。
- **押し出しは New Body / Cut / Add の3操作**に対応しています。
- **トポロジカルネーミング問題は幾何マッチングで近似的に対応**しています。面選択時のfaceIdでの
  再解決を優先し、失敗時は法線一致+中心距離の近さで再解決します。形状変更が大きい場合は面参照が
  ずれたりエラーになったりすることがあり、その際は面を選択し直す必要があります。
- スケッチ拘束ソルバは自由な線分・円弧セグメント(線分ツールで作図、または既存エンティティを
  「分解」したもの)のみを対象とします。rectangle/circle等の基本エンティティに直接付与することは
  できません。entities由来の寸法ラベル編集は引き続き「始点/中心を固定し対象パラメータのみ更新
  する」決定的ルールです。
- 多角形頂点のフィレット/面取りは、コーナーサイズが隣接辺に対して明らかに大きすぎる場合に事前
  チェックでエラーにしますが、自己交差等の厳密な破綻判定はOCCT側に委ねています。
- アンドゥ/リドゥは未実装です。

---

## English summary

light-3dcad is a browser-only, Japanese-native parametric 3D CAD application. It runs entirely
client-side (no server-side processing) using Replicad/opencascade.js (WASM) for B-Rep geometry
and PlaneGCS (WASM, the same 2D constraint solver used by FreeCAD's Sketcher) for sketch
constraints — both run inside a Web Worker. Features include constrained 2D sketching, extrude/
revolve/fillet/chamfer/shell/thread features, multi-body modeling and simple assembly (placement,
interference check, mates), STL/STEP export, local project save (`.l3dcad`), and optional
AI-assisted model generation via Anthropic or OpenAI APIs (bring-your-own-key, called directly
from the browser). See the Japanese sections above for full detail, or just run `npm install &&
npm run dev` to try it. Licensed under the [MIT License](./LICENSE); see
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for third-party (including LGPL-2.1) license
notices, and [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.
