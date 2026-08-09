#!/usr/bin/env node
// GitHub Action(.github/workflows/model-submission.yml)の「Parse & decode」ステップから呼ばれる
// 薄いグルーコード。scripts/model-submission-lib.mjs・scripts/decode-share-link.mjsの純粋関数を
// 組み合わせ、issueのbody(環境変数ISSUE_BODY)からモデルデータ+メタ情報を取り出して
// ファイルに書き出し、後続ステップ向けに $GITHUB_OUTPUT へ結果を出力する。
// このファイル自体はfs/env等の副作用を持つグルーコードのため単体テスト対象外とし、
// ロジック部分(model-submission-lib.mjs・decode-share-link.mjs)側でカバーする。
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeShareLinkPayloadNode } from "./decode-share-link.mjs";
import {
  buildMetaJson,
  buildModelSlug,
  extractSharePayload,
  extractSubmissionFields,
  validateSubmissionFields,
} from "./model-submission-lib.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const MODELS_DIR = join(REPO_ROOT, "models");

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  const line = `${name}<<__GALLERY_SUBMISSION_EOF__\n${value}\n__GALLERY_SUBMISSION_EOF__\n`;
  if (outputPath) {
    appendFileSync(outputPath, line, "utf-8");
  } else {
    console.log(`${name}=${value}`);
  }
}

function fail(message) {
  setOutput("ok", "false");
  setOutput("message", message);
  console.error(`[run-model-submission] 失敗: ${message}`);
}

function main() {
  const body = process.env.ISSUE_BODY ?? "";
  const issueNumber = process.env.ISSUE_NUMBER ?? "0";
  const outDir = process.env.RUNNER_TEMP ?? REPO_ROOT;

  const fields = extractSubmissionFields(body);
  const fieldErrors = validateSubmissionFields(fields);
  if (fieldErrors.length > 0) {
    fail(`投稿内容の確認に失敗しました。\n- ${fieldErrors.join("\n- ")}`);
    return;
  }

  const payloadResult = extractSharePayload(fields.modelData);
  if (!payloadResult.ok) {
    fail(payloadResult.message);
    return;
  }

  let modelJson;
  try {
    modelJson = decodeShareLinkPayloadNode(payloadResult.payload);
  } catch (err) {
    fail(`モデルデータの展開(gzip伸長)に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const existingSlugs = existsSync(MODELS_DIR)
    ? readdirSync(MODELS_DIR).filter((name) => statSync(join(MODELS_DIR, name)).isDirectory())
    : [];
  const slug = buildModelSlug(fields.title, issueNumber, existingSlugs);
  const meta = buildMetaJson(fields);

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const modelJsonPath = join(outDir, "gallery-submission-model.json");
  const metaJsonPath = join(outDir, "gallery-submission-meta.json");
  writeFileSync(modelJsonPath, modelJson, "utf-8");
  writeFileSync(metaJsonPath, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");

  setOutput("ok", "true");
  setOutput("slug", slug);
  setOutput("model_json_path", modelJsonPath);
  setOutput("meta_json_path", metaJsonPath);
  setOutput("title", fields.title);
}

main();
