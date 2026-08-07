// プロジェクトファイル(.l3dcad = JSON)のシリアライズ/デシリアライズ。
// このファイルは副作用のない純粋TypeScript(Replicad等の重い依存はimportしない)。

import type { CadDocument } from "../model/types";
import { validateDocument } from "../model/validation";

/** プロジェクトファイルのフォーマット識別子(拡張子.l3dcadのJSON)。 */
export const PROJECT_FORMAT = "l3dcad";

/**
 * プロジェクトファイルのスキーマバージョン。CadDocument.version(=1、B-Repフィーチャーデータ型自体の
 * バージョン)とは別の概念で、こちらはプロジェクトファイル(封筒)側の形式バージョン。
 * 将来フィールド追加等で上げる場合はdeserializeProject()にマイグレーション処理を追加する。
 */
export const PROJECT_SCHEMA_VERSION = 1;

/** .l3dcadファイルの中身(JSON化される最上位オブジェクト)。 */
export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  schemaVersion: number;
  document: CadDocument;
}

/** CadDocumentをプロジェクトファイル形式のJSON文字列に変換する。 */
export function serializeProject(doc: CadDocument): string {
  const file: ProjectFile = {
    format: PROJECT_FORMAT,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    document: doc,
  };
  return JSON.stringify(file, null, 2);
}

export type DeserializeProjectResult = { ok: true; doc: CadDocument } | { ok: false; message: string };

/**
 * プロジェクトファイルのJSON文字列をCadDocumentに変換する。以下の順で検証する。
 * 1. JSONとして解析できること
 * 2. オブジェクトであり format が "l3dcad" であること
 * 3. schemaVersion が既知の値であること(将来のマイグレーションの受け口。現状はv1のみ対応)
 * 4. document が最低限の構造(version:1、features配列)を持つこと
 * 5. 既存のvalidateDocument()(model/validation.ts)を通過すること(フィーチャー内容の整合性)
 */
export function deserializeProject(text: string): DeserializeProjectResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, message: `JSONの解析に失敗しました: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, message: "不正なプロジェクトファイルです(オブジェクトではありません)" };
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.format !== PROJECT_FORMAT) {
    return { ok: false, message: `未対応のフォーマットです(format: ${JSON.stringify(obj.format)})。light-3dcadの.l3dcadファイルではありません` };
  }

  if (typeof obj.schemaVersion !== "number") {
    return { ok: false, message: "schemaVersionが不正です" };
  }
  // 将来のバージョン移行の受け口。現状はv1のみ対応(それ以外は未対応として拒否する)。
  if (obj.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    return { ok: false, message: `未対応のschemaVersionです: ${obj.schemaVersion}` };
  }

  const doc = obj.document as CadDocument | undefined;
  if (
    typeof doc !== "object" ||
    doc === null ||
    (doc as CadDocument).version !== 1 ||
    !Array.isArray((doc as CadDocument).features)
  ) {
    return { ok: false, message: "documentの構造が不正です" };
  }

  const errors = validateDocument(doc);
  if (errors.length > 0) {
    return { ok: false, message: `ドキュメントのバリデーションに失敗しました: ${errors[0].message}` };
  }

  return { ok: true, doc };
}
