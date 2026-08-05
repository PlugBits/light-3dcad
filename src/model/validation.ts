import type { CadDocument, Feature, FeatureId, SketchEntity } from "./types";

/** ドキュメント/フィーチャーのバリデーションエラー。featureId が特定できる場合のみ付与する。 */
export interface ValidationError {
  featureId?: FeatureId;
  message: string;
}

function isPositiveFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validateEntity(entity: SketchEntity, featureId: FeatureId): ValidationError[] {
  const errors: ValidationError[] = [];
  switch (entity.kind) {
    case "rectangle": {
      if (!isPositiveFiniteNumber(entity.width)) {
        errors.push({ featureId, message: `矩形(${entity.id})の幅は正の数である必要があります` });
      }
      if (!isPositiveFiniteNumber(entity.height)) {
        errors.push({ featureId, message: `矩形(${entity.id})の高さは正の数である必要があります` });
      }
      break;
    }
    case "circle": {
      if (!isPositiveFiniteNumber(entity.radius)) {
        errors.push({ featureId, message: `円(${entity.id})の半径は正の数である必要があります` });
      }
      break;
    }
  }
  if (!entity.center.every((c) => Number.isFinite(c))) {
    errors.push({ featureId, message: `図形(${entity.id})の中心座標が不正です` });
  }
  return errors;
}

/** 単一フィーチャーのバリデーション。extrudeの参照先チェックには doc.features 全体が必要。 */
export function validateFeature(feature: Feature, allFeatures: readonly Feature[]): ValidationError[] {
  const errors: ValidationError[] = [];

  if (feature.type === "sketch") {
    if (feature.plane.kind === "world" && feature.plane.plane !== "XY") {
      errors.push({ featureId: feature.id, message: "対応していないワールド平面です" });
    }
    if (feature.plane.kind === "face") {
      if (!feature.plane.featureId) {
        errors.push({ featureId: feature.id, message: "参照フィーチャーIDが指定されていません" });
      }
      if (!feature.plane.center.every((c) => Number.isFinite(c)) || !feature.plane.normal.every((c) => Number.isFinite(c))) {
        errors.push({ featureId: feature.id, message: "面参照の中心・法線座標が不正です" });
      }
    }
    feature.entities.forEach((entity) => {
      errors.push(...validateEntity(entity, feature.id));
    });
  } else if (feature.type === "extrude") {
    if (!isPositiveFiniteNumber(feature.distance)) {
      errors.push({ featureId: feature.id, message: "押し出し距離は正の数である必要があります" });
    }
    if (feature.direction !== 1 && feature.direction !== -1) {
      errors.push({ featureId: feature.id, message: "押し出し方向は1または-1である必要があります" });
    }
    if (feature.operation !== "newBody" && feature.operation !== "cut") {
      errors.push({ featureId: feature.id, message: "対応していない押し出し操作です" });
    }
    const referenced = allFeatures.find((f) => f.id === feature.sketchId);
    if (!referenced) {
      errors.push({ featureId: feature.id, message: `参照先のスケッチ(${feature.sketchId})が存在しません` });
    } else if (referenced.type !== "sketch") {
      errors.push({ featureId: feature.id, message: `参照先(${feature.sketchId})はスケッチではありません` });
    }
  }

  return errors;
}

/** ドキュメント全体のバリデーション。フィーチャーID重複チェックも行う。 */
export function validateDocument(doc: CadDocument): ValidationError[] {
  const errors: ValidationError[] = [];

  const seenIds = new Set<FeatureId>();
  for (const feature of doc.features) {
    if (seenIds.has(feature.id)) {
      errors.push({ featureId: feature.id, message: `フィーチャーIDが重複しています: ${feature.id}` });
    }
    seenIds.add(feature.id);
  }

  for (const feature of doc.features) {
    errors.push(...validateFeature(feature, doc.features));
  }

  return errors;
}

/** ドキュメントが有効かどうか(エラーが1件もないか)。 */
export function isDocumentValid(doc: CadDocument): boolean {
  return validateDocument(doc).length === 0;
}
