// CadDocument に対する純粋な操作関数群。すべて非破壊(新しい CadDocument を返す)。
import { generateId } from "./id";
import type {
  CadDocument,
  ExtrudeFeature,
  Feature,
  FeatureId,
  PlaneRef,
  SketchEntity,
  SketchFeature,
} from "./types";
import { validateFeature, type ValidationError } from "./validation";

export type { ValidationError } from "./validation";

/** 空のドキュメントを作成する。 */
export function createEmptyDocument(): CadDocument {
  return { version: 1, features: [] };
}

/** フィーチャーをドキュメント末尾に追加する。 */
export function addFeature(doc: CadDocument, feature: Feature): CadDocument {
  return { ...doc, features: [...doc.features, feature] };
}

/** 新しいスケッチフィーチャーを作成して末尾に追加する。IDは自動生成される。 */
export function addSketchFeature(
  doc: CadDocument,
  params: { name: string; plane: PlaneRef; entities: SketchEntity[] },
): { doc: CadDocument; feature: SketchFeature } {
  const feature: SketchFeature = {
    type: "sketch",
    id: generateId("sketch"),
    name: params.name,
    plane: params.plane,
    entities: params.entities,
  };
  return { doc: addFeature(doc, feature), feature };
}

/** 新しい押し出しフィーチャーを作成して末尾に追加する。IDは自動生成される。 */
export function addExtrudeFeature(
  doc: CadDocument,
  params: {
    name: string;
    sketchId: FeatureId;
    distance: number;
    direction: 1 | -1;
    operation: "newBody" | "cut";
  },
): { doc: CadDocument; feature: ExtrudeFeature } {
  const feature: ExtrudeFeature = {
    type: "extrude",
    id: generateId("extrude"),
    name: params.name,
    sketchId: params.sketchId,
    distance: params.distance,
    direction: params.direction,
    operation: params.operation,
  };
  return { doc: addFeature(doc, feature), feature };
}

/** 指定IDのフィーチャーを探す。見つからなければ undefined。 */
export function findFeature(doc: CadDocument, featureId: FeatureId): Feature | undefined {
  return doc.features.find((f) => f.id === featureId);
}

/**
 * 指定IDのフィーチャーを updater で置き換える。フィーチャーが存在しない場合は元のドキュメントをそのまま返す。
 * updater は同じ type を維持したまま新しいフィーチャーを返すこと。
 */
export function updateFeature<T extends Feature>(
  doc: CadDocument,
  featureId: FeatureId,
  updater: (feature: T) => T,
): CadDocument {
  let changed = false;
  const features = doc.features.map((f) => {
    if (f.id !== featureId) return f;
    changed = true;
    return updater(f as T);
  });
  if (!changed) return doc;
  return { ...doc, features };
}

/** extrude フィーチャーの一部フィールドを更新する。 */
export function patchExtrudeFeature(
  doc: CadDocument,
  featureId: FeatureId,
  patch: Partial<Pick<ExtrudeFeature, "name" | "sketchId" | "distance" | "direction" | "operation">>,
): CadDocument {
  return updateFeature<ExtrudeFeature>(doc, featureId, (f) => ({ ...f, ...patch }));
}

/** sketch フィーチャー自体の一部フィールド(name, plane)を更新する。 */
export function patchSketchFeature(
  doc: CadDocument,
  featureId: FeatureId,
  patch: Partial<Pick<SketchFeature, "name" | "plane">>,
): CadDocument {
  return updateFeature<SketchFeature>(doc, featureId, (f) => ({ ...f, ...patch }));
}

/** sketch 内の1エンティティを部分更新する(kind は変更しない)。 */
export function updateSketchEntity(
  doc: CadDocument,
  sketchId: FeatureId,
  entityId: string,
  patch: Partial<SketchEntity>,
): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({
    ...sketch,
    entities: sketch.entities.map((entity) =>
      entity.id === entityId ? ({ ...entity, ...patch } as SketchEntity) : entity,
    ),
  }));
}

/** 指定IDのフィーチャーを削除する。 */
export function removeFeature(doc: CadDocument, featureId: FeatureId): CadDocument {
  const features = doc.features.filter((f) => f.id !== featureId);
  if (features.length === doc.features.length) return doc;
  return { ...doc, features };
}

/** フィーチャー(または追加/更新しようとしているフィーチャー)を検証する。 */
export function validateSingleFeature(feature: Feature, doc: CadDocument): ValidationError[] {
  return validateFeature(feature, doc.features);
}

export { validateDocument, validateFeature, isDocumentValid } from "./validation";
