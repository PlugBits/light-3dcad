// scripts/model-submission-lib.mjs の単体テスト(Phase 40d)。
// GitHub Action(model-submission.yml)がここに実装されたロジックだけでissue本文をパース・検証
// するため、実際のActionをこの環境で動かせない代わりにこのテストで挙動を保証する。
import { describe, expect, it } from "vitest";

import {
  buildMetaJson,
  buildModelSlug,
  extractSharePayload,
  extractSubmissionFields,
  isChecked,
  parseIssueBody,
  parseTags,
  slugifyTitle,
  validateSubmissionFields,
} from "../../scripts/model-submission-lib.mjs";

const CHECKED_LICENSE_BODY = `### タイトル

L字ブラケット

### 作者名

yourname

### 説明

60×50mm・厚さ15mmのL字形状ブラケットです。

### タグ

ブラケット, L字, 構造材

### モデルデータ

https://plugbits.github.io/light-3dcad/#m=abcXYZ-_123

### ライセンス同意

- [X] 投稿モデルをMITライセンスで公開することに同意します
`;

describe("parseIssueBody / extractSubmissionFields", () => {
  it("issueフォームのmarkdown本文を見出しごとにパースする(完全なURL形式のモデルデータ)", () => {
    const fields = extractSubmissionFields(CHECKED_LICENSE_BODY);
    expect(fields.title).toBe("L字ブラケット");
    expect(fields.author).toBe("yourname");
    expect(fields.description).toBe("60×50mm・厚さ15mmのL字形状ブラケットです。");
    expect(fields.tags).toBe("ブラケット, L字, 構造材");
    expect(fields.modelData).toBe("https://plugbits.github.io/light-3dcad/#m=abcXYZ-_123");
    expect(fields.licenseAgreed).toBe(true);
  });

  it("裸のペイロード(#m=プレフィックス無し)形式のモデルデータも保持する", () => {
    const body = CHECKED_LICENSE_BODY.replace(
      "https://plugbits.github.io/light-3dcad/#m=abcXYZ-_123",
      "abcXYZ-_123",
    );
    const fields = extractSubmissionFields(body);
    expect(fields.modelData).toBe("abcXYZ-_123");
  });

  it("タグ等の任意項目が未入力(_No response_)の場合は空文字列になる", () => {
    const body = CHECKED_LICENSE_BODY.replace(
      "### タグ\n\nブラケット, L字, 構造材",
      "### タグ\n\n_No response_",
    );
    const fields = extractSubmissionFields(body);
    expect(fields.tags).toBe("");
  });

  it("ライセンス同意が未チェックの場合はlicenseAgreed: false", () => {
    const body = CHECKED_LICENSE_BODY.replace(
      "- [X] 投稿モデルをMITライセンスで公開することに同意します",
      "- [ ] 投稿モデルをMITライセンスで公開することに同意します",
    );
    const fields = extractSubmissionFields(body);
    expect(fields.licenseAgreed).toBe(false);
  });

  it("bodyがundefined/空文字列でも例外を投げず全フィールドが空になる", () => {
    expect(extractSubmissionFields("").title).toBe("");
    expect(extractSubmissionFields(undefined).licenseAgreed).toBe(false);
  });

  it("parseIssueBody: 見出しの無い本文は空オブジェクトを返す", () => {
    expect(parseIssueBody("ただの文章です。見出しはありません。")).toEqual({});
  });
});

describe("isChecked", () => {
  it("大文字/小文字どちらの[x]もチェック済みと判定する", () => {
    expect(isChecked("- [x] 同意します")).toBe(true);
    expect(isChecked("- [X] 同意します")).toBe(true);
  });
  it("未チェック・空・undefinedはfalse", () => {
    expect(isChecked("- [ ] 同意します")).toBe(false);
    expect(isChecked("")).toBe(false);
    expect(isChecked(undefined)).toBe(false);
  });
});

describe("validateSubmissionFields", () => {
  it("全フィールドが揃っていれば空配列(エラー無し)", () => {
    const fields = extractSubmissionFields(CHECKED_LICENSE_BODY);
    expect(validateSubmissionFields(fields)).toEqual([]);
  });

  it("必須フィールドの欠落を検知する(タイトル・作者名・説明・モデルデータ・ライセンス同意)", () => {
    const errors = validateSubmissionFields({
      title: "",
      author: "",
      description: "",
      modelData: "",
      licenseAgreed: false,
    });
    expect(errors).toHaveLength(5);
  });
});

describe("extractSharePayload", () => {
  it("完全な共有リンクURL(#m=を含む)からペイロード部分を取り出す", () => {
    const result = extractSharePayload("https://plugbits.github.io/light-3dcad/#m=abcXYZ-_123");
    expect(result).toEqual({ ok: true, payload: "abcXYZ-_123" });
  });

  it("#m=プレフィックスの無い裸のペイロードもそのまま受け付ける", () => {
    const result = extractSharePayload("abcXYZ-_123");
    expect(result).toEqual({ ok: true, payload: "abcXYZ-_123" });
  });

  it("前後に空白・改行があるURLも正しく処理する(textarea経由の折り返し等)", () => {
    const result = extractSharePayload("\n  https://plugbits.github.io/light-3dcad/#m=abc\nXYZ-_123  \n");
    expect(result).toEqual({ ok: true, payload: "abcXYZ-_123" });
  });

  it("コードフェンス(```)で囲まれた入力もフェンスを除去して処理する", () => {
    const result = extractSharePayload("```\nabcXYZ-_123\n```");
    expect(result).toEqual({ ok: true, payload: "abcXYZ-_123" });
  });

  it("空文字列はエラー(モデルデータが空です)", () => {
    const result = extractSharePayload("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("空です");
  });

  it("issueフォームの説明文がそのまま残っている(未入力のプレースホルダのような)本文はエラーになる", () => {
    // ダイアログの案内文や、フィールドの説明文をそのまま貼り付けてしまった長文ケース。
    // base64url以外の文字(句読点・スペース等)を含むため不正な形式として弾かれる。
    const instructionsLeftIn =
      "アプリの「共有リンクをコピー」で得られるURL(#m=...を含む)、または「ギャラリーに投稿」ダイアログでコピーされた文字列をそのまま貼り付けてください。";
    const result = extractSharePayload(instructionsLeftIn);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("形式が不正");
  });

  it("base64url以外の文字を含む不正なペイロードはエラーメッセージ付きで返る(例外を投げない)", () => {
    const result = extractSharePayload("not valid base64url!!!");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.message).toContain("形式が不正");
    }
  });
});

describe("parseTags", () => {
  it("カンマ区切りをtrim済みの配列に変換する", () => {
    expect(parseTags("ブラケット, L字 ,構造材")).toEqual(["ブラケット", "L字", "構造材"]);
  });
  it("空文字列/未指定は空配列", () => {
    expect(parseTags("")).toEqual([]);
    expect(parseTags(undefined)).toEqual([]);
  });
});

describe("slugifyTitle", () => {
  it("ASCII英数字混じりのタイトルはそのまま小文字化・ハイフン区切りになる", () => {
    expect(slugifyTitle("Plate With Hole")).toBe("plate-with-hole");
  });

  it("日本語のみのタイトルは空文字列になる(fallbackはbuildModelSlug側の責務)", () => {
    expect(slugifyTitle("リング")).toBe("");
    expect(slugifyTitle("穴あきプレート")).toBe("");
  });

  it("記号・空白は連続ハイフンに畳み込まれ、前後のハイフンは除去される", () => {
    expect(slugifyTitle("  --Bracket!! (v2)--  ")).toBe("bracket-v2");
  });
});

describe("buildModelSlug", () => {
  it("英数字タイトルはslugifyTitle()の結果をそのまま使う", () => {
    expect(buildModelSlug("Plate With Hole", 42, [])).toBe("plate-with-hole");
  });

  it("日本語のみのタイトル(slugify結果が空)は model-<issue番号> にfallbackする", () => {
    expect(buildModelSlug("リング", 7, [])).toBe("model-7");
    expect(buildModelSlug("穴あきプレート", 99, [])).toBe("model-99");
  });

  it("既存slugと衝突する場合は連番を付与する", () => {
    expect(buildModelSlug("Plate With Hole", 42, ["plate-with-hole"])).toBe("plate-with-hole-2");
    expect(buildModelSlug("Plate With Hole", 42, ["plate-with-hole", "plate-with-hole-2"])).toBe(
      "plate-with-hole-3",
    );
  });
});

describe("buildMetaJson", () => {
  it("投稿フィールドからmodels/<slug>/meta.jsonの内容を組み立てる", () => {
    const fields = extractSubmissionFields(CHECKED_LICENSE_BODY);
    expect(buildMetaJson(fields)).toEqual({
      title: "L字ブラケット",
      author: "yourname",
      description: "60×50mm・厚さ15mmのL字形状ブラケットです。",
      tags: ["ブラケット", "L字", "構造材"],
    });
  });

  it("タグ未指定の場合はtags: []", () => {
    const fields = { title: "T", author: "A", description: "D", tags: "" };
    expect(buildMetaJson(fields).tags).toEqual([]);
  });
});
