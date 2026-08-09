// GitHub Action(.github/workflows/model-submission.yml、Phase 40d)専用のバリデーションテスト。
// SUBMISSION_JSON_PATH環境変数が設定されている場合のみ実行し、そのパスのJSON(共有リンクを
// 伸長した.l3dcad相当のテキスト)を src/project/serialization.ts の deserializeProject() で検証、
// 結果を SUBMISSION_RESULT_PATH(設定されていれば)に { ok, message? } のJSONとして書き出す。
// 通常の `npm test` 実行時(両env変数とも未設定)はまるごとスキップされ、既存のベースライン件数
// (Vitestの合計テスト数)には数えられるが常にスキップ扱いになるため、gate(全件通過)には影響しない。
// GitHub Actionsからは以下のように呼び出す想定:
//   SUBMISSION_JSON_PATH=/path/to/model.json SUBMISSION_RESULT_PATH=/path/to/result.json \
//     npx vitest run tests/project/validateSubmissionEnv.test.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { deserializeProject } from "../../src/project/serialization";

const jsonPath = process.env.SUBMISSION_JSON_PATH;
const resultPath = process.env.SUBMISSION_RESULT_PATH;

describe.skipIf(!jsonPath)("投稿モデルのバリデーション(model-submission.yml専用)", () => {
  it("SUBMISSION_JSON_PATHのモデルがserialization/validationを通過する", () => {
    if (!jsonPath || !existsSync(jsonPath)) {
      throw new Error(`SUBMISSION_JSON_PATHのファイルが見つかりません: ${jsonPath}`);
    }
    const text = readFileSync(jsonPath, "utf-8");
    const result = deserializeProject(text);

    if (resultPath) {
      const output = result.ok ? { ok: true } : { ok: false, message: result.message };
      writeFileSync(resultPath, JSON.stringify(output), "utf-8");
    }

    expect(result.ok, result.ok ? "" : result.message).toBe(true);
  });
});
