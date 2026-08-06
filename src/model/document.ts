// CadDocument に対する純粋な操作関数群。すべて非破壊(新しい CadDocument を返す)。
import { generateId } from "./id";
import { applySegmentCorner, findSharedEndpoint } from "../sketch/segmentCorner";
import { trimEntityAtPoint, type Point2 } from "../sketch/trim";
import type {
  CadDocument,
  ExtrudeFeature,
  Feature,
  FeatureId,
  PlaneRef,
  PolygonCorner,
  SketchConstraint,
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

/**
 * rectangleエンティティを同寸法のpolygonエンティティ(4頂点、コーナー未指定)へ変換する
 * (フィレット/面取りツールでrectangleの角をクリックしたときの下準備、Phase 24)。頂点順序は
 * src/sketch/explode.tsのexplodeRectangle()・src/sketch/entityEdges.tsのrectangleEdgePoints()と
 * 同じ(下辺左→下辺右→上辺右→上辺左、反時計回り)。idは維持する(参照切れを避けるため)。
 * entity が見つからない・rectangleでない場合は元のドキュメントをそのまま返す。
 */
export function convertRectangleToPolygon(doc: CadDocument, sketchId: FeatureId, entityId: string): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({
    ...sketch,
    entities: sketch.entities.map((entity) => {
      if (entity.id !== entityId || entity.kind !== "rectangle") return entity;
      const [cx, cy] = entity.center;
      const hw = entity.width / 2;
      const hh = entity.height / 2;
      const points: [number, number][] = [
        [cx - hw, cy - hh],
        [cx + hw, cy - hh],
        [cx + hw, cy + hh],
        [cx - hw, cy + hh],
      ];
      return { kind: "polygon", id: entity.id, points };
    }),
  }));
}

/**
 * 2本の自由な線分セグメント(共有端点を持つ)にフィレット/面取りを適用する(Phase 24)。
 * 実際の幾何計算は src/sketch/segmentCorner.ts の applySegmentCorner()。適用不可(円弧が絡む・
 * サイズ過大等)の場合は元のドキュメントをそのまま返す。
 */
export function applySegmentCornerToSketch(
  doc: CadDocument,
  sketchId: FeatureId,
  aSegmentId: string,
  bSegmentId: string,
  kind: "fillet" | "chamfer",
  size: number,
): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => {
    const segments = sketch.segments ?? [];
    const a = segments.find((s) => s.id === aSegmentId);
    const b = segments.find((s) => s.id === bSegmentId);
    if (!a || !b) return sketch;
    const result = applySegmentCorner(a, b, kind, size);
    if (!result) return sketch;
    const nextSegments = segments.map((s) => {
      if (s.id === aSegmentId) return result.a;
      if (s.id === bSegmentId) return result.b;
      return s;
    });
    nextSegments.push(result.corner);

    // a・bが共有していた元の端点を結んでいたcoincident拘束は、フィレット/面取りで両端点が
    // 接点まで短縮されて別の座標になるため、そのまま残すと次のソルバ実行時に接点が元の角の
    // 位置へ引き戻されて円弧が破綻する(隣接する角を連続でフィレットしたときに顕著)。
    // 元のcoincidentを削除し、代わりに「a接点↔挿入セグメント始端」「挿入セグメント末端↔b接点」の
    // coincidentを付け直す(buildAutoConstraintsForChainが線分描画確定時に付与する形式と同じ)。
    const shared = findSharedEndpoint(a, b);
    let nextConstraints = sketch.constraints ?? [];
    if (shared) {
      const { aEnd, bEnd } = shared;
      nextConstraints = nextConstraints.filter((c) => {
        if (c.kind !== "coincident") return true;
        const linksSharedPair =
          (c.a.segmentId === aSegmentId && c.a.end === aEnd && c.b.segmentId === bSegmentId && c.b.end === bEnd) ||
          (c.b.segmentId === aSegmentId && c.b.end === aEnd && c.a.segmentId === bSegmentId && c.a.end === bEnd);
        return !linksSharedPair;
      });
      nextConstraints = [
        ...nextConstraints,
        {
          id: generateId("constraint"),
          kind: "coincident",
          a: { segmentId: aSegmentId, end: aEnd },
          b: { segmentId: result.corner.id, end: "p1" },
        },
        {
          id: generateId("constraint"),
          kind: "coincident",
          a: { segmentId: result.corner.id, end: "p2" },
          b: { segmentId: bSegmentId, end: bEnd },
        },
      ];
    }

    return { ...sketch, segments: nextSegments, constraints: nextConstraints };
  });
}

/**
 * entityId のエンティティ(rectangle/circle/polygon/slot/regularPolygon)を、clickPoint(ローカル2D、
 * mm)に最も近い区間だけ削除した上でsegmentsへ分解する(トリムツールのentity対応、Phase 24)。
 * 実際の幾何計算は src/sketch/trim.ts の trimEntityAtPoint()。entities・segmentsの置き換えを
 * 1回のフィーチャー更新にまとめることで、undo1回で元に戻せるようにする。
 */
export function trimSketchEntityAtPoint(doc: CadDocument, sketchId: FeatureId, entityId: string, clickPoint: Point2): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => {
    const result = trimEntityAtPoint(sketch.entities, entityId, sketch.segments ?? [], clickPoint);
    return { ...sketch, entities: result.entities, segments: result.segments };
  });
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

/**
 * sketch の拘束(SketchConstraint、Phase 20a)配列を丸ごと置き換える(Phase 20b、寸法ツール・
 * 拘束一覧パネルの追加/更新/削除で使う。実際の増分計算はsrc/sketch/constraintDimensions.tsの
 * upsert系関数・removeConstraint()が行い、ここでは置き換えのみを行う)。
 */
export function setSketchConstraints(doc: CadDocument, sketchId: FeatureId, constraints: SketchConstraint[]): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({ ...sketch, constraints }));
}

/**
 * sketch にセグメント(Phase 19a)を追加する(線分作図ツール・分解の確定時に使う、Phase 19b)。
 * constraints(Phase 20a)を同時に渡すと、追加されたセグメントに対する自動拘束
 * (src/sketch/autoConstraints.ts参照)も一緒に既存constraintsへ追記する(省略可、後方互換)。
 */
export function addSketchSegments(
  doc: CadDocument,
  sketchId: FeatureId,
  segments: SketchSegment[],
  constraints?: SketchConstraint[],
): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({
    ...sketch,
    segments: [...(sketch.segments ?? []), ...segments],
    ...(constraints && constraints.length > 0 ? { constraints: [...(sketch.constraints ?? []), ...constraints] } : {}),
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
