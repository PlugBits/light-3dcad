<!--
  モデルギャラリー(models/)へのモデル投稿用テンプレートです。
  このPRを作成するときは、URLに `?template=model.md` を付けてください
  (例: https://github.com/PlugBits/light-3dcad/compare/main...your-branch?quick_pull=1&template=model.md)。
-->

## モデル投稿

- [ ] `models/<slug>/model.l3dcad` を追加した
- [ ] `models/<slug>/meta.json` を追加した(`title` / `author` / `description` / `tags` すべて指定)
- [ ] `npm run dev` でアプリを起動し、`?g=<slug>` でモデルが正しく開ける(エラーなく評価が完了する)ことを確認した
- [ ] `npm test` がローカルで通る(`tests/project/models.test.ts` が投稿したモデルを自動検証します)
- [ ] このモデルおよび付随するメタ情報を **MITライセンス** の下で提供することに同意する

### slugについて

- 英数字とハイフンのみ(例: `plate-with-hole`)。ディレクトリ名と一致させてください。
- 他の投稿と衝突しない、内容が分かる名前にしてください。

### モデルの概要

<!-- 何を作ったか、どんなパラメータ・フィーチャーを使っているか等を簡潔に記載してください -->

### スクリーンショット(任意)

<!-- アプリでモデルを開いた様子のスクリーンショットがあれば添付してください -->
