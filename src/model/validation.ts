import type { CadDocument, Feature, FeatureId, PointRef, PolygonCorner, SketchConstraint, SketchEntity, SketchSegment } from "./types";

/** ドキュメント/フィーチャーのバリデーションエラー。featureId が特定できる場合のみ付与する。 */
export interface ValidationError {
  featureId?: FeatureId;
  message: string;
}

function isPositiveFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** 隣接する頂点間の距離がこの値以下なら重複とみなす(mm)。 */
const POLYGON_MIN_VERTEX_DISTANCE = 1e-6;

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
      if (!entity.center.every((c) => Number.isFinite(c))) {
        errors.push({ featureId, message: `図形(${entity.id})の中心座標が不正です` });
      }
      break;
    }
    case "circle": {
      if (!isPositiveFiniteNumber(entity.radius)) {
        errors.push({ featureId, message: `円(${entity.id})の半径は正の数である必要があります` });
      }
      if (!entity.center.every((c) => Number.isFinite(c))) {
        errors.push({ featureId, message: `図形(${entity.id})の中心座標が不正です` });
      }
      break;
    }
    case "polygon": {
      if (entity.points.length < 3) {
        errors.push({ featureId, message: `多角形(${entity.id})は3点以上の頂点が必要です` });
        break;
      }
      if (!entity.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) {
        errors.push({ featureId, message: `多角形(${entity.id})の頂点座標が不正です` });
        break;
      }
      for (let i = 0; i < entity.points.length; i += 1) {
        const [ax, ay] = entity.points[i];
        const [bx, by] = entity.points[(i + 1) % entity.points.length];
        const dx = ax - bx;
        const dy = ay - by;
        if (Math.sqrt(dx * dx + dy * dy) <= POLYGON_MIN_VERTEX_DISTANCE) {
          errors.push({ featureId, message: `多角形(${entity.id})に隣接する重複頂点があります` });
          break;
        }
      }
      errors.push(...validatePolygonCorners(entity.id, entity.points, entity.corners, featureId));
      break;
    }
    case "slot": {
      if (!entity.start.every((c) => Number.isFinite(c)) || !entity.end.every((c) => Number.isFinite(c))) {
        errors.push({ featureId, message: `スロット(${entity.id})の始点・終点座標が不正です` });
        break;
      }
      if (!isPositiveFiniteNumber(entity.width)) {
        errors.push({ featureId, message: `スロット(${entity.id})の幅は正の数である必要があります` });
      }
      const len = Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]);
      if (len <= POLYGON_MIN_VERTEX_DISTANCE) {
        errors.push({ featureId, message: `スロット(${entity.id})の始点と終点が一致しています` });
      }
      break;
    }
    case "regularPolygon": {
      if (!isPositiveFiniteNumber(entity.radius)) {
        errors.push({ featureId, message: `正多角形(${entity.id})の半径は正の数である必要があります` });
      }
      if (!entity.center.every((c) => Number.isFinite(c))) {
        errors.push({ featureId, message: `図形(${entity.id})の中心座標が不正です` });
      }
      if (!Number.isInteger(entity.sides) || entity.sides < 3 || entity.sides > 24) {
        errors.push({ featureId, message: `正多角形(${entity.id})の辺数は3〜24の整数である必要があります` });
      }
      break;
    }
  }
  return errors;
}

/**
 * polygonの頂点コーナー(fillet/chamfer)を検証する。points は既に「3点以上・座標が有限」
 * であることを呼び出し側が確認済みの前提で呼ぶ(壊れた座標に対して隣接辺長を計算しないため)。
 * - size は正の有限数であること
 * - kind は "fillet" | "chamfer" のいずれかであること
 * - 「粗い事前チェック」: size が隣接2辺(頂点iを挟む2辺)のうち短い方の長さの1/2を超える場合は
 *   警告的エラーにする。OCCT側の厳密な破綻判定(自己交差等)はここでは行わず、evaluator評価時の
 *   例外が既存のfeatureId付きエラー経路に乗る。
 */
export function validatePolygonCorners(
  entityId: string,
  points: [number, number][],
  corners: PolygonCorner[] | undefined,
  featureId?: FeatureId,
): ValidationError[] {
  if (!corners) return [];
  const errors: ValidationError[] = [];
  const n = points.length;

  corners.forEach((corner, i) => {
    if (!corner) return;
    if (i >= n) return; // points より長い corners 配列は該当頂点が存在しないため無視する。
    if (corner.kind !== "fillet" && corner.kind !== "chamfer") {
      errors.push({ featureId, message: `多角形(${entityId})の頂点${i + 1}のコーナー種別が不正です` });
      return;
    }
    if (!isPositiveFiniteNumber(corner.size)) {
      errors.push({ featureId, message: `多角形(${entityId})の頂点${i + 1}のコーナーサイズは正の数である必要があります` });
      return;
    }

    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    const edgeInLength = Math.hypot(curr[0] - prev[0], curr[1] - prev[1]);
    const edgeOutLength = Math.hypot(next[0] - curr[0], next[1] - curr[1]);
    const shorterEdge = Math.min(edgeInLength, edgeOutLength);
    if (corner.size > shorterEdge / 2) {
      errors.push({
        featureId,
        message: `多角形(${entityId})の頂点${i + 1}のコーナーサイズ(${corner.size})が隣接辺に対して大きすぎます(目安上限 ${(shorterEdge / 2).toFixed(3)}mm)`,
      });
    }
  });

  return errors;
}

/**
 * セグメント(Phase 19a)のバリデーション。p1・p2は有限であること、距離は
 * POLYGON_MIN_VERTEX_DISTANCE(1e-6mm)を超えること(=同一点でないこと)。
 * kind:"arc" の bulge は有限数であること(0は直線扱いになるだけで不正ではない)。
 */
function validateSegment(segment: SketchSegment, featureId: FeatureId): ValidationError[] {
  const errors: ValidationError[] = [];
  if (
    !Number.isFinite(segment.p1[0]) ||
    !Number.isFinite(segment.p1[1]) ||
    !Number.isFinite(segment.p2[0]) ||
    !Number.isFinite(segment.p2[1])
  ) {
    errors.push({ featureId, message: `セグメント(${segment.id})の座標が不正です` });
    return errors;
  }
  const dx = segment.p1[0] - segment.p2[0];
  const dy = segment.p1[1] - segment.p2[1];
  if (Math.sqrt(dx * dx + dy * dy) <= POLYGON_MIN_VERTEX_DISTANCE) {
    errors.push({ featureId, message: `セグメント(${segment.id})の始点と終点が一致しています` });
  }
  if (segment.kind === "arc" && segment.bulge !== undefined && !Number.isFinite(segment.bulge)) {
    errors.push({ featureId, message: `セグメント(${segment.id})のbulge値が不正です` });
  }
  return errors;
}

function findSegmentById(segments: readonly SketchSegment[], id: string): SketchSegment | undefined {
  return segments.find((s) => s.id === id);
}

/** 拘束が指す点参照(PointRef)のsegmentIdが存在するかを検証する。 */
function validatePointRef(
  ref: PointRef,
  segments: readonly SketchSegment[],
  constraintId: string,
  label: string,
  featureId: FeatureId,
): ValidationError[] {
  if (!findSegmentById(segments, ref.segmentId)) {
    return [{ featureId, message: `拘束(${constraintId})の参照先セグメント(${ref.segmentId}、${label})が見つかりません` }];
  }
  return [];
}

/**
 * スケッチ拘束(Phase 20a)のバリデーション。
 * - coincident/distance/fix: 参照するPointRefのsegmentIdがsegments内に存在すること
 * - horizontal/vertical/length/radius: segmentIdがsegments内に存在すること
 * - length/distance/radius: valueが正の有限数であること
 * - radius: 参照先セグメントがkind:"arc"であること(lineには指定できない)
 */
function validateConstraint(
  constraint: SketchConstraint,
  segments: readonly SketchSegment[],
  featureId: FeatureId,
): ValidationError[] {
  const errors: ValidationError[] = [];
  switch (constraint.kind) {
    case "coincident": {
      errors.push(...validatePointRef(constraint.a, segments, constraint.id, "a", featureId));
      errors.push(...validatePointRef(constraint.b, segments, constraint.id, "b", featureId));
      break;
    }
    case "horizontal":
    case "vertical": {
      if (!findSegmentById(segments, constraint.segmentId)) {
        errors.push({
          featureId,
          message: `拘束(${constraint.id})の参照先セグメント(${constraint.segmentId})が見つかりません`,
        });
      }
      break;
    }
    case "length": {
      if (!findSegmentById(segments, constraint.segmentId)) {
        errors.push({
          featureId,
          message: `拘束(${constraint.id})の参照先セグメント(${constraint.segmentId})が見つかりません`,
        });
      }
      if (!isPositiveFiniteNumber(constraint.value)) {
        errors.push({ featureId, message: `拘束(${constraint.id})の長さは正の数である必要があります` });
      }
      break;
    }
    case "distance": {
      errors.push(...validatePointRef(constraint.a, segments, constraint.id, "a", featureId));
      errors.push(...validatePointRef(constraint.b, segments, constraint.id, "b", featureId));
      if (!isPositiveFiniteNumber(constraint.value)) {
        errors.push({ featureId, message: `拘束(${constraint.id})の距離は正の数である必要があります` });
      }
      break;
    }
    case "radius": {
      const segment = findSegmentById(segments, constraint.segmentId);
      if (!segment) {
        errors.push({
          featureId,
          message: `拘束(${constraint.id})の参照先セグメント(${constraint.segmentId})が見つかりません`,
        });
      } else if (segment.kind !== "arc") {
        errors.push({ featureId, message: `拘束(${constraint.id})は円弧セグメントにのみ指定できます` });
      }
      if (!isPositiveFiniteNumber(constraint.value)) {
        errors.push({ featureId, message: `拘束(${constraint.id})の半径は正の数である必要があります` });
      }
      break;
    }
    case "fix": {
      errors.push(...validatePointRef(constraint.point, segments, constraint.id, "point", featureId));
      break;
    }
  }
  return errors;
}

/** 単一フィーチャーのバリデーション。extrudeの参照先チェックには doc.features 全体が必要。 */
export function validateFeature(feature: Feature, allFeatures: readonly Feature[]): ValidationError[] {
  const errors: ValidationError[] = [];

  if (feature.type === "sketch") {
    // world平面はXY/XZ/YZの3枚(PlaneRefの型で保証済み)。追加のバリデーションは不要。
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
    feature.segments?.forEach((segment) => {
      errors.push(...validateSegment(segment, feature.id));
    });
    feature.constraints?.forEach((constraint) => {
      errors.push(...validateConstraint(constraint, feature.segments ?? [], feature.id));
    });
  } else if (feature.type === "extrude") {
    if (!isPositiveFiniteNumber(feature.distance)) {
      errors.push({ featureId: feature.id, message: "押し出し距離は正の数である必要があります" });
    }
    if (feature.direction !== 1 && feature.direction !== -1) {
      errors.push({ featureId: feature.id, message: "押し出し方向は1または-1である必要があります" });
    }
    if (feature.operation !== "newBody" && feature.operation !== "cut" && feature.operation !== "add") {
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
