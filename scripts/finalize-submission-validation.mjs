#!/usr/bin/env node
// GitHub Action(.github/workflows/model-submission.yml)の「検証結果を読み取る」ステップから
// 呼ばれる薄いグルーコード。tests/project/validateSubmissionEnv.test.ts が
// SUBMISSION_RESULT_PATH に書き出した { ok, message? } を読み取り、後続ステップ向けに
// $GITHUB_OUTPUT へ ok/message を出力する。vitestの実行自体が(タイムアウト等で)結果ファイルを
// 書けずに終わった場合は ok:false 扱いにする(投稿を安全側に倒す)。
import { appendFileSync, existsSync, readFileSync } from "node:fs";

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  const line = `${name}<<__GALLERY_SUBMISSION_EOF__\n${value}\n__GALLERY_SUBMISSION_EOF__\n`;
  if (outputPath) {
    appendFileSync(outputPath, line, "utf-8");
  } else {
    console.log(`${name}=${value}`);
  }
}

function main() {
  const resultPath = process.env.SUBMISSION_RESULT_PATH;
  if (!resultPath || !existsSync(resultPath)) {
    setOutput("ok", "false");
    setOutput("message", "モデルデータのバリデーション処理が結果を出力せずに終了しました(想定外のエラー)");
    return;
  }

  let result;
  try {
    result = JSON.parse(readFileSync(resultPath, "utf-8"));
  } catch (err) {
    setOutput("ok", "false");
    setOutput("message", `バリデーション結果の読み取りに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (result.ok) {
    setOutput("ok", "true");
  } else {
    setOutput("ok", "false");
    setOutput("message", `ドキュメントのバリデーションに失敗しました: ${result.message ?? "(詳細不明)"}`);
  }
}

main();
