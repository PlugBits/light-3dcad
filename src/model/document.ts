// CadDocument に対する純粋な操作関数群。すべて非破壊(新しい CadDocument を返す)。
import { generateId } from "./id";
import type {
  CadDocument,
  ExtrudeFeature,
  Feature,
  FeatureId,
  PlaneRef,
  PolygonCorner,
  SketchEntity,
  SketchFeature,
  SketchSegment,
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

/**
 * 新しいスケッチフィーチャーを作成して末尾に追加する。IDは自動生成される。
 * segments(Phase 19a)は省略可(後方互換。省略時は既存どおりentitiesのみのスケッチになる)。
 */
export function addSketchFeature(
  doc: CadDocument,
  params: { name: string; plane: PlaneRef; entities: SketchEntity[]; segments?: SketchSegment[] },
): { doc: CadDocument; feature: SketchFeature } {
  const feature: SketchFeature = {
    type: "sketch",
    id: generateId("sketch"),
    name: params.name,
    plane: params.plane,
    entities: params.entities,
    ...(params.segments ? { segments: params.segments } : {}),
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
    operation: ExtrudeFeature["operation"];
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

/**
 * polygonエンティティの1頂点(vertexIndex)のコーナー指定(fillet/chamfer/null)を設定する。
 * entity.corners が未設定の場合は points と同じ長さのnull配列から始める。
 * entity が見つからない・polygonでない・vertexIndexが範囲外の場合は元のドキュメントをそのまま返す。
 */
export function setPolygonVertexCorner(
  doc: CadDocument,
  sketchId: FeatureId,
  entityId: string,
  vertexIndex: number,
  corner: PolygonCorner,
): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({
    ...sketch,
    entities: sketch.entities.map((entity) => {
      if (entity.id !== entityId || entity.kind !== "polygon") return entity;
      if (vertexIndex < 0 || vertexIndex >= entity.points.length) return entity;
      const nextCorners: PolygonCorner[] = entity.corners
        ? entity.corners.slice()
        : entity.points.map(() => null);
      while (nextCorners.length < entity.points.length) nextCorners.push(null);
      nextCorners[vertexIndex] = corner;
      return { ...entity, corners: nextCorners };
    }),
  }));
}

/** sketch に1エンティティを追加する。 */
export function addSketchEntity(doc: CadDocument, sketchId: FeatureId, entity: SketchEntity): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({
    ...sketch,
    entities: [...sketch.entities, entity],
  }));
}

/** sketch から1エンティティを削除する。 */
export function removeSketchEntity(doc: CadDocument, sketchId: FeatureId, entityId: string): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({
    ...sketch,
    entities: sketch.entities.filter((entity) => entity.id !== entityId),
  }));
}

/** sketch の自由な線分・円弧セグメント(Phase 19a)配列を丸ごと置き換える(Phase 19b)。 */
export function setSketchSegments(doc: CadDocument, sketchId: FeatureId, segments: SketchSegment[]): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({ ...sketch, segments }));
}

/** sketch にセグメント(Phase 19a)を追加する(線分作図ツール・分解の確定時に使う、Phase 19b)。 */
export function addSketchSegments(doc: CadDocument, sketchId: FeatureId, segments: SketchSegment[]): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({
    ...sketch,
    segments: [...(sketch.segments ?? []), ...segments],
  }));
}

/**
 * sketch のentityを削除し、代わりに等価なsegments(src/sketch/explode.ts の explodeEntity())を
 * 既存segmentsへ追記する(「分解」ボタン、Phase 19b)。分解後はトリムツールの対象になる。
 */
export function explodeSketchEntity(doc: CadDocument, sketchId: FeatureId, entityId: string, segments: SketchSegment[]): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({
    ...sketch,
    entities: sketch.entities.filter((entity) => entity.id !== entityId),
    segments: [...(sketch.segments ?? []), ...segments],
  }));
}

/** 指定IDのフィーチャーを削除する(依存フィーチャーはそのまま残る=参照切れの可能性あり)。 */
export function removeFeature(doc: CadDocument, featureId: FeatureId): CadDocument {
  const features = doc.features.filter((f) => f.id !== featureId);
  if (features.length === doc.features.length) return doc;
  return { ...doc, features };
}

/** featureId に直接依存している(参照している)フィーチャーIDの一覧を返す。 */
export function getDirectDependentFeatureIds(doc: CadDocument, featureId: FeatureId): FeatureId[] {
  const dependents: FeatureId[] = [];
  for (const feature of doc.features) {
    if (feature.type === "extrude" && feature.sketchId === featureId) {
      dependents.push(feature.id);
    }
    if (feature.type === "sketch" && feature.plane.kind === "face" && feature.plane.featureId === featureId) {
      dependents.push(feature.id);
    }
  }
  return dependents;
}

/** featureId に(直接・間接を問わず)依存している全フィーチャーIDの一覧を返す(featureId自体は含まない)。 */
export function getDependentFeatureIds(doc: CadDocument, featureId: FeatureId): FeatureId[] {
  const result = new Set<FeatureId>();
  const queue = [featureId];
  while (queue.length > 0) {
    const id = queue.shift() as FeatureId;
    for (const dep of getDirectDependentFeatureIds(doc, id)) {
      if (!result.has(dep)) {
        result.add(dep);
        queue.push(dep);
      }
    }
  }
  return [...result];
}

/**
 * 指定IDのフィーチャーと、それに(再帰的に)依存する全フィーチャーをまとめて削除する。
 * 例: sketchを削除すると、そのsketchIdを参照するextrudeも一緒に削除される。
 */
export function removeFeatureCascade(doc: CadDocument, featureId: FeatureId): CadDocument {
  const toRemove = new Set<FeatureId>([featureId, ...getDependentFeatureIds(doc, featureId)]);
  const features = doc.features.filter((f) => !toRemove.has(f.id));
  if (features.length === doc.features.length) return doc;
  return { ...doc, features };
}

/** フィーチャー(または追加/更新しようとしているフィーチャー)を検証する。 */
export function validateSingleFeature(feature: Feature, doc: CadDocument): ValidationError[] {
  return validateFeature(feature, doc.features);
}

export { validateDocument, validateFeature, isDocumentValid } from "./validation";
