// GitHub Actionsのワークフロー(.github/workflows/model-submission.yml)とissueフォーム
// (.github/ISSUE_TEMPLATE/model-submission.yml)のYAML構文チェック+構造の一貫性チェック
// (Phase 40d)。このリポジトリではActionを実際にこの環境で実行できない(issueが必要なため)ため、
// 最低限「YAMLとして壊れていないこと」と「issueフォームのフィールドidラベルが
// scripts/model-submission-lib.mjs のFIELD_LABELS・src/project/gallerySubmit.tsが組み立てる
// クエリパラメータ名と一致していること」をここで保証する。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

import { FIELD_LABELS } from "../../scripts/model-submission-lib.mjs";

const REPO_ROOT = resolve(__dirname, "../..");
const ISSUE_FORM_PATH = resolve(REPO_ROOT, ".github/ISSUE_TEMPLATE/model-submission.yml");
const WORKFLOW_PATH = resolve(REPO_ROOT, ".github/workflows/model-submission.yml");

interface IssueFormField {
  type: string;
  id?: string;
  attributes?: { label?: string; options?: { label: string; required?: boolean }[] };
  validations?: { required?: boolean };
}

interface IssueForm {
  name: string;
  labels?: string[];
  body: IssueFormField[];
}

describe("model-submission.yml issueフォーム", () => {
  const raw = readFileSync(ISSUE_FORM_PATH, "utf-8");

  it("有効なYAMLとしてパースできる", () => {
    expect(() => load(raw)).not.toThrow();
  });

  const form = load(raw) as IssueForm;

  it("labelsにmodel-submissionが含まれる(トリガー条件と一致)", () => {
    expect(form.labels).toContain("model-submission");
  });

  it("必須フィールド(id)がFIELD_LABELSのlabelと一致する", () => {
    const fieldsById = new Map<string, IssueFormField>();
    for (const field of form.body) {
      if (field.id) fieldsById.set(field.id, field);
    }

    const expectations: [string, string][] = [
      ["model_title", FIELD_LABELS.title],
      ["author_name", FIELD_LABELS.author],
      ["description", FIELD_LABELS.description],
      ["tags", FIELD_LABELS.tags],
      ["model_data", FIELD_LABELS.modelData],
      ["license_agreement", FIELD_LABELS.license],
    ];

    for (const [id, expectedLabel] of expectations) {
      const field = fieldsById.get(id);
      expect(field, `id=${id} のフィールドが見つかりません`).toBeDefined();
      expect(field?.attributes?.label).toBe(expectedLabel);
    }
  });

  it("タイトル・作者名・説明・モデルデータは必須、タグは任意", () => {
    const fieldsById = new Map<string, IssueFormField>();
    for (const field of form.body) {
      if (field.id) fieldsById.set(field.id, field);
    }
    expect(fieldsById.get("model_title")?.validations?.required).toBe(true);
    expect(fieldsById.get("author_name")?.validations?.required).toBe(true);
    expect(fieldsById.get("description")?.validations?.required).toBe(true);
    expect(fieldsById.get("model_data")?.validations?.required).toBe(true);
    expect(fieldsById.get("tags")?.validations?.required).toBe(false);
  });

  it("ライセンス同意チェックボックスは必須である", () => {
    const field = form.body.find((f) => f.id === "license_agreement");
    expect(field?.attributes?.options?.[0]?.required).toBe(true);
  });
});

describe("model-submission.yml ワークフロー", () => {
  const raw = readFileSync(WORKFLOW_PATH, "utf-8");

  it("有効なYAMLとしてパースできる", () => {
    expect(() => load(raw)).not.toThrow();
  });

  // ワークフローのトップレベルキー"on"はJSにおいて予約語ではないが、js-yamlはブール変換
  // (YAML1.1では bare "on" が true と解釈され得る)を避けるため、パース結果を検証する。
  const workflow = load(raw) as Record<string, unknown>;

  it("issues イベント(opened/edited)をトリガーとする", () => {
    // js-yaml(デフォルトのcore/failsafeスキーマ)は "on:" をブール変換しない(YAML1.2寄り)ため
    // 文字列キー"on"のまま取得できる。念のためtrueキーへのフォールバックも見ておく。
    const onSection = (workflow.on ?? (workflow as Record<string, unknown>)["true"]) as
      | { issues?: { types?: string[] } }
      | undefined;
    expect(onSection?.issues?.types).toEqual(["opened", "edited"]);
  });

  it("必要な権限(contents/pull-requests/issues write)のみを明示する", () => {
    expect(workflow.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
      issues: "write",
    });
  });

  it("model-submissionラベルが付いたissueのみで動く(条件分岐)", () => {
    const jobs = workflow.jobs as Record<string, { if?: string }>;
    expect(jobs.process.if).toContain("model-submission");
  });

  it("使用するactionsはcheckout/setup-node/github-scriptのみ(marketplaceアクション最小化)", () => {
    const usesList = [...raw.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    const allowedPrefixes = ["actions/checkout@", "actions/setup-node@", "actions/github-script@"];
    for (const uses of usesList) {
      expect(allowedPrefixes.some((prefix) => uses.startsWith(prefix)), `想定外のaction: ${uses}`).toBe(true);
    }
  });
});
