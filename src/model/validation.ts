import type {
  ArcRef,
  CadDocument,
  EntityRef,
  EntityVertexRef,
  Feature,
  FeatureId,
  MovableLineRef,
  PointRef,
  PolygonCorner,
  SketchConstraint,
  SketchEntity,
  SketchSegment,
} from "./types";
import { entityVertexCount } from "../sketch/entityEdges";

/** ドキュメント/フィーチャーのバリデーションエラー。featureId が特定できる場合のみ付与する。 */
export interface ValidationError {
  featureId?: FeatureId;
  message: string;
}

function isPositiveFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** 0以上(0を含む)の有限数であること。0を許可する距離系拘束(下記参照)のバリデーションに使う。 */
function isNonNegativeFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * 符号付き軸距離拘束(distance/distancePointOrigin/distanceEntityEntityのaxis:"x"/"y"、寸法値の
 * 符号仕様の明確化、Phase 33)のvalueバリデーション。axis:"x"/"y"は符号(1点目→2点目の向き)・0(軸整列)
 * のいずれも許容するため有限数であればよい。axis:"direct"(直線距離、ユークリッド)は0(点一致)を
 * 許可するが負は不可。
 */
function isValidAxisDistanceValue(value: number, axis: "direct" | "x" | "y" | undefined): boolean {
  if (axis === "x" || axis === "y") return Number.isFinite(value);
  return isNonNegativeFiniteNumber(value);
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
    case "point": {
      if (!entity.position.every((c) => Number.isFinite(c))) {
        errors.push({ featureId, message: `点(${entity.id})の座標が不正です` });
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
    errors.push({ featureId, message: `スケッチ要素(${segment.id})の座標が不正です` });
    return errors;
  }
  const dx = segment.p1[0] - segment.p2[0];
  const dy = segment.p1[1] - segment.p2[1];
  if (Math.sqrt(dx * dx + dy * dy) <= POLYGON_MIN_VERTEX_DISTANCE) {
    errors.push({ featureId, message: `スケッチ要素(${segment.id})の始点と終点が一致しています` });
  }
  if (segment.kind === "arc" && segment.bulge !== undefined && !Number.isFinite(segment.bulge)) {
    errors.push({ featureId, message: `スケッチ要素(${segment.id})のbulge値が不正です` });
  }
  return errors;
}

function findSegmentById(segments: readonly SketchSegment[], id: string): SketchSegment | undefined {
  return segments.find((s) => s.id === id);
}

/**
 * concentric.a/b・tangent.entity(Phase 42bでEntityRef|ArcRefに拡張)が指す先が実在するか検証する。
 * EntityRefはcircleエンティティ、ArcRefは円弧セグメント(kind:"arc"かつbulgeあり)であることを要求する。
 * 見つからない/種類が違う場合のみエラーを返す(見つかった場合は空配列)。
 */
function validateCurveRef(
  ref: EntityRef | ArcRef,
  segments: readonly SketchSegment[],
  entities: readonly SketchEntity[],
  constraintId: string,
  featureId: FeatureId,
): ValidationError[] {
  if ("segmentId" in ref) {
    const seg = findSegmentById(segments, ref.segmentId);
    if (!seg || seg.kind !== "arc" || !seg.bulge) {
      return [{ featureId, message: `拘束(${constraintId})の参照先の円弧(${ref.segmentId})が見つかりません` }];
    }
    return [];
  }
  if (!entities.find((e) => e.id === ref.entityId && e.kind === "circle")) {
    return [{ featureId, message: `拘束(${constraintId})の参照先の円(${ref.entityId})が見つかりません` }];
  }
  return [];
}

/**
 * extrude/revolveのtargetBodyId(Phase 27a複数ボディ対応)を検証する。指定されていなければ
 * (undefined)何もしない(省略時は「最後に作られたボディ」を自動的に対象にするため、評価時に
 * 常に有効)。指定されている場合は、参照先が「先行する(=このフィーチャーより前に登場する)
 * newBody操作のextrude/revolveフィーチャー」であることを要求する。実際のボディ解決・
 * エラー化はsrc/worker/evaluator.tsのapplyBodyOperation()が評価時に行うため、ここでの
 * バリデーションは主にプロジェクトファイルの整合性チェック(validateDocument経由)向け
 * (patchExtrudeFeature等によるライブ編集のエラー表示はevaluator.tsの実行時エラーで賄う)。
 */
function validateTargetBodyId(
  featureId: FeatureId,
  targetBodyId: FeatureId | undefined,
  allFeatures: readonly Feature[],
): ValidationError[] {
  if (targetBodyId === undefined) return [];
  const idx = allFeatures.findIndex((f) => f.id === featureId);
  const targetIdx = allFeatures.findIndex((f) => f.id === targetBodyId);
  const target = targetIdx >= 0 ? allFeatures[targetIdx] : undefined;
  const isNewBodyFeature =
    !!target &&
    (((target.type === "extrude" || target.type === "revolve") && target.operation === "newBody") ||
      target.type === "partInstance");
  if (!isNewBodyFeature) {
    return [
      {
        featureId,
        message: `対象ボディ(${targetBodyId})が見つかりません(New Bodyフィーチャーではありません)`,
      },
    ];
  }
  if (idx >= 0 && targetIdx >= idx) {
    return [{ featureId, message: `対象ボディ(${targetBodyId})は先行するフィーチャーである必要があります` }];
  }
  return [];
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
    return [{ featureId, message: `拘束(${constraintId})の参照先スケッチ要素(${ref.segmentId}、${label})が見つかりません` }];
  }
  return [];
}

/**
 * 拘束が指す点参照(PointRef、またはEntityVertexRef=entityの頂点、Phase 48)の参照先が
 * 存在するかを検証する。distance.a/b・distancePointOrigin/distancePointLine.pointが対象
 * (validatePointRefのPointRef|EntityVertexRef版)。
 */
function validatePointOrVertexRef(
  ref: PointRef | EntityVertexRef,
  segments: readonly SketchSegment[],
  entities: readonly SketchEntity[],
  constraintId: string,
  label: string,
  featureId: FeatureId,
): ValidationError[] {
  if ("segmentId" in ref) return validatePointRef(ref, segments, constraintId, label, featureId);
  const entity = entities.find((e) => e.id === ref.entityId);
  if (!entity) {
    return [{ featureId, message: `拘束(${constraintId})の参照先スケッチ要素(${ref.entityId}、${label})が見つかりません` }];
  }
  const count = entityVertexCount(entity);
  if (!Number.isInteger(ref.vertexIndex) || ref.vertexIndex < 0 || ref.vertexIndex >= count) {
    return [{ featureId, message: `拘束(${constraintId})の頂点番号(${ref.vertexIndex}、${label})が範囲外です` }];
  }
  return [];
}

/**
 * distanceLineLine/angleLineLine(a/b)・distanceLineRefEdge/angleLineRefEdge(segmentId)が
 * 指す線参照(素の文字列=自由な線分のsegmentId、またはMovableLineRef=entityEdge、Phase 48)の
 * 参照先が存在するかを検証する。
 */
function validateMovableLineRef(
  ref: string | MovableLineRef,
  segments: readonly SketchSegment[],
  entities: readonly SketchEntity[],
  constraintId: string,
  label: string,
  featureId: FeatureId,
): ValidationError[] {
  if (typeof ref === "string" || ref.kind === "segmentEdge") {
    const segmentId = typeof ref === "string" ? ref : ref.segmentId;
    const seg = findSegmentById(segments, segmentId);
    if (!seg) return [{ featureId, message: `拘束(${constraintId})の参照先スケッチ要素(${segmentId}、${label})が見つかりません` }];
    if (seg.kind !== "line") return [{ featureId, message: `拘束(${constraintId})は線分にのみ指定できます(${segmentId})` }];
    return [];
  }
  const entity = entities.find((e) => e.id === ref.entityId);
  if (!entity) return [{ featureId, message: `拘束(${constraintId})の参照先スケッチ要素(${ref.entityId}、${label})が見つかりません` }];
  if (entity.kind !== "rectangle" && entity.kind !== "polygon" && entity.kind !== "regularPolygon" && entity.kind !== "slot") {
    return [{ featureId, message: `拘束(${constraintId})は矩形/多角形/正多角形/スロットの辺にのみ指定できます(${ref.entityId})` }];
  }
  return [];
}

/**
 * スケッチ拘束(Phase 20a)のバリデーション。
 * - coincident/distance/fix: 参照するPointRefのsegmentIdがsegments内に存在すること
 * - horizontal/vertical/length/radius: segmentIdがsegments内に存在すること
 * - length/radius: valueが正の有限数であること
 * - distance/distancePointOrigin/distanceEntityEntity: axis:"x"/"y"は符号付きのため有限数であれば
 *   よい(0・負を許可)、axis:"direct"/省略(直線距離)は0以上(点一致を許可、負は不可、寸法値の符号仕様の
 *   明確化Phase 33)
 * - distancePointLine/distanceLineLine/distanceLineRefEdge: valueが0以上の有限数であること
 *   (線上一致を許可、負は不可、Phase 33)
 * - radius: 参照先セグメントがkind:"arc"であること(lineには指定できない)
 * - perpendicular: 参照先セグメントが2本ともkind:"line"であること(Phase 23)
 * - concentric/tangent: 参照先entityがcircleエンティティとして存在すること(Phase 23)
 */
function validateConstraint(
  constraint: SketchConstraint,
  segments: readonly SketchSegment[],
  entities: readonly SketchEntity[],
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
          message: `拘束(${constraint.id})の参照先スケッチ要素(${constraint.segmentId})が見つかりません`,
        });
      }
      break;
    }
    case "length": {
      if (!findSegmentById(segments, constraint.segmentId)) {
        errors.push({
          featureId,
          message: `拘束(${constraint.id})の参照先スケッチ要素(${constraint.segmentId})が見つかりません`,
        });
      }
      if (!isPositiveFiniteNumber(constraint.value)) {
        errors.push({ featureId, message: `拘束(${constraint.id})の長さは正の数である必要があります` });
      }
      break;
    }
    case "distance": {
      errors.push(...validatePointOrVertexRef(constraint.a, segments, entities, constraint.id, "a", featureId));
      errors.push(...validatePointOrVertexRef(constraint.b, segments, entities, constraint.id, "b", featureId));
      // 0を許可(整列)。axis:"x"/"y"は符号付き(寸法値の符号仕様の明確化、Phase 33)のため負も許可、
      // axis:"direct"/省略(直線距離)は0以上(点一致)のみ許可(負は不可)。
      if (!isValidAxisDistanceValue(constraint.value, constraint.axis)) {
        errors.push({
          featureId,
          message:
            constraint.axis === "x" || constraint.axis === "y"
              ? `拘束(${constraint.id})の距離は有限の数である必要があります`
              : `拘束(${constraint.id})の距離は0以上の数である必要があります`,
        });
      }
      break;
    }
    case "distancePointOrigin": {
      errors.push(...validatePointOrVertexRef(constraint.point, segments, entities, constraint.id, "point", featureId));
      if (!isValidAxisDistanceValue(constraint.value, constraint.axis)) {
        errors.push({
          featureId,
          message:
            constraint.axis === "x" || constraint.axis === "y"
              ? `拘束(${constraint.id})の距離は有限の数である必要があります`
              : `拘束(${constraint.id})の距離は0以上の数である必要があります`,
        });
      }
      break;
    }
    case "distanceEntityEntity": {
      // Phase 47: 点エンティティも円と同様に参照できる(どちらも「代表点」1つを持つmovable entity)。
      if (!entities.find((e) => e.id === constraint.a.entityId && (e.kind === "circle" || e.kind === "point"))) {
        errors.push({ featureId, message: `拘束(${constraint.id})の参照先の円/点(${constraint.a.entityId})が見つかりません` });
      }
      if (!entities.find((e) => e.id === constraint.b.entityId && (e.kind === "circle" || e.kind === "point"))) {
        errors.push({ featureId, message: `拘束(${constraint.id})の参照先の円/点(${constraint.b.entityId})が見つかりません` });
      }
      if (!isValidAxisDistanceValue(constraint.value, constraint.axis)) {
        errors.push({
          featureId,
          message:
            constraint.axis === "x" || constraint.axis === "y"
              ? `拘束(${constraint.id})の距離は有限の数である必要があります`
              : `拘束(${constraint.id})の距離は0以上の数である必要があります`,
        });
      }
      break;
    }
    case "distancePointLine": {
      errors.push(...validatePointOrVertexRef(constraint.point, segments, entities, constraint.id, "point", featureId));
      // 点↔線距離は0を許可(線上一致として機能、寸法値の符号仕様の明確化、Phase 33)。負は不可。
      if (!isNonNegativeFiniteNumber(constraint.value)) {
        errors.push({ featureId, message: `拘束(${constraint.id})の距離は0以上の数である必要があります` });
      }
      break;
    }
    case "radius": {
      const segment = findSegmentById(segments, constraint.segmentId);
      if (!segment) {
        errors.push({
          featureId,
          message: `拘束(${constraint.id})の参照先スケッチ要素(${constraint.segmentId})が見つかりません`,
        });
      } else if (segment.kind !== "arc") {
        errors.push({ featureId, message: `拘束(${constraint.id})は円弧にのみ指定できます` });
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
    case "fixArc": {
      const segment = findSegmentById(segments, constraint.segmentId);
      if (!segment) {
        errors.push({
          featureId,
          message: `拘束(${constraint.id})の参照先スケッチ要素(${constraint.segmentId})が見つかりません`,
        });
      } else if (segment.kind !== "arc" || !segment.bulge) {
        errors.push({ featureId, message: `拘束(${constraint.id})は円弧にのみ指定できます` });
      }
      break;
    }
    case "perpendicular": {
      const a = findSegmentById(segments, constraint.a);
      const b = findSegmentById(segments, constraint.b);
      if (!a) errors.push({ featureId, message: `拘束(${constraint.id})の参照先スケッチ要素(${constraint.a})が見つかりません` });
      else if (a.kind !== "line") errors.push({ featureId, message: `拘束(${constraint.id})は線分にのみ指定できます(${constraint.a})` });
      if (!b) errors.push({ featureId, message: `拘束(${constraint.id})の参照先スケッチ要素(${constraint.b})が見つかりません` });
      else if (b.kind !== "line") errors.push({ featureId, message: `拘束(${constraint.id})は線分にのみ指定できます(${constraint.b})` });
      break;
    }
    case "distanceLineLine": {
      // Phase 48: a/bは自由な線分のsegmentId(素の文字列)に加えMovableLineRef(entityEdge)も指定できる。
      errors.push(...validateMovableLineRef(constraint.a, segments, entities, constraint.id, "a", featureId));
      errors.push(...validateMovableLineRef(constraint.b, segments, entities, constraint.id, "b", featureId));
      // 線↔線距離は0を許可(平行かつ線上一致として機能、寸法値の符号仕様の明確化、Phase 33)。負は不可。
      if (!isNonNegativeFiniteNumber(constraint.value)) {
        errors.push({ featureId, message: `拘束(${constraint.id})の距離は0以上の数である必要があります` });
      }
      break;
    }
    case "angleLineLine": {
      errors.push(...validateMovableLineRef(constraint.a, segments, entities, constraint.id, "a", featureId));
      errors.push(...validateMovableLineRef(constraint.b, segments, entities, constraint.id, "b", featureId));
      if (!isPositiveFiniteNumber(constraint.value)) {
        errors.push({ featureId, message: `拘束(${constraint.id})の角度は正の数である必要があります` });
      }
      break;
    }
    case "distanceLineRefEdge": {
      // Phase 48: segmentId(フィールド名は後方互換)は素の文字列に加えMovableLineRef(entityEdge)も指定できる。
      errors.push(...validateMovableLineRef(constraint.segmentId, segments, entities, constraint.id, "segmentId", featureId));
      // 線↔参照エッジ距離も線↔線距離と同じく0を許可(Phase 33)。負は不可。
      if (!isNonNegativeFiniteNumber(constraint.value)) {
        errors.push({ featureId, message: `拘束(${constraint.id})の距離は0以上の数である必要があります` });
      }
      break;
    }
    case "angleLineRefEdge": {
      errors.push(...validateMovableLineRef(constraint.segmentId, segments, entities, constraint.id, "segmentId", featureId));
      if (!isPositiveFiniteNumber(constraint.value)) {
        errors.push({ featureId, message: `拘束(${constraint.id})の角度は正の数である必要があります` });
      }
      break;
    }
    case "concentric": {
      errors.push(...validateCurveRef(constraint.a, segments, entities, constraint.id, featureId));
      errors.push(...validateCurveRef(constraint.b, segments, entities, constraint.id, featureId));
      break;
    }
    case "tangent": {
      errors.push(...validateCurveRef(constraint.entity, segments, entities, constraint.id, featureId));
      const isArcEntity = "segmentId" in constraint.entity;
      const target = constraint.target;
      if (target.kind === "segment") {
        const seg = findSegmentById(segments, target.segmentId);
        if (!seg) errors.push({ featureId, message: `拘束(${constraint.id})の参照先スケッチ要素(${target.segmentId})が見つかりません` });
        else if (seg.kind !== "line") errors.push({ featureId, message: `拘束(${constraint.id})は線分にのみ指定できます(${target.segmentId})` });
      } else if (isArcEntity) {
        // 円弧(ArcRef)は「線分への接線」のみ対応(円↔円の外接/内接は円エンティティ同士のみ)。
        errors.push({ featureId, message: `拘束(${constraint.id})の円弧は線分への接線のみ指定できます` });
      } else {
        if (!entities.find((e) => e.id === target.entityId && e.kind === "circle")) {
          errors.push({ featureId, message: `拘束(${constraint.id})の参照先の円(${target.entityId})が見つかりません` });
        }
        if (target.mode !== "external" && target.mode !== "internal") {
          errors.push({ featureId, message: `拘束(${constraint.id})の接線モードが不正です` });
        }
      }
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
      errors.push(...validateConstraint(constraint, feature.segments ?? [], feature.entities, feature.id));
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
    errors.push(...validateTargetBodyId(feature.id, feature.targetBodyId, allFeatures));
  } else if (feature.type === "fillet3d") {
    if (!isPositiveFiniteNumber(feature.size)) {
      errors.push({ featureId: feature.id, message: "フィレット/面取りのサイズは正の数である必要があります" });
    }
    if (feature.edges.length === 0) {
      errors.push({ featureId: feature.id, message: "フィレット/面取りの対象エッジが選択されていません" });
    }
  } else if (feature.type === "shell") {
    if (!isPositiveFiniteNumber(feature.thickness)) {
      errors.push({ featureId: feature.id, message: "シェルの肉厚は正の数である必要があります" });
    }
    if (feature.faces.length === 0) {
      errors.push({ featureId: feature.id, message: "シェルの対象面が選択されていません" });
    }
  } else if (feature.type === "revolve") {
    if (feature.axis !== "x" && feature.axis !== "y") {
      errors.push({ featureId: feature.id, message: "回転体の軸はxまたはyである必要があります" });
    }
    if (!Number.isFinite(feature.angle) || feature.angle <= 0 || feature.angle > 360) {
      errors.push({ featureId: feature.id, message: "回転体の角度は0より大きく360以下である必要があります" });
    }
    if (feature.operation !== "newBody" && feature.operation !== "cut" && feature.operation !== "add") {
      errors.push({ featureId: feature.id, message: "対応していない回転体操作です" });
    }
    const referenced = allFeatures.find((f) => f.id === feature.sketchId);
    if (!referenced) {
      errors.push({ featureId: feature.id, message: `参照先のスケッチ(${feature.sketchId})が存在しません` });
    } else if (referenced.type !== "sketch") {
      errors.push({ featureId: feature.id, message: `参照先(${feature.sketchId})はスケッチではありません` });
    }
    errors.push(...validateTargetBodyId(feature.id, feature.targetBodyId, allFeatures));
  } else if (feature.type === "thread") {
    if (!isPositiveFiniteNumber(feature.length)) {
      errors.push({ featureId: feature.id, message: "ねじの長さは正の数である必要があります" });
    }
    if (feature.hand !== "male" && feature.hand !== "female") {
      errors.push({ featureId: feature.id, message: "ねじの種別(雄/雌)が不正です" });
    }
    if (feature.direction !== 1 && feature.direction !== -1) {
      errors.push({ featureId: feature.id, message: "ねじの向きは1または-1である必要があります" });
    }
    if (!feature.face.center.every((c) => Number.isFinite(c)) || !feature.face.normal.every((c) => Number.isFinite(c))) {
      errors.push({ featureId: feature.id, message: "ねじの配置面の中心・法線座標が不正です" });
    }
    // 配置基準参照(positionRef、Phase 46)の構造チェック。実際の「同じ面かどうか」の幾何検証は
    // ジオメトリ解決が必要なためsrc/worker/evaluator.tsが評価時に行う(見つからない/面が違う場合は
    // 評価エラーになる。extrude/revolveのsketchId・validateTargetBodyIdと同じ考え方)。
    if (feature.positionRef) {
      const refSketch = allFeatures.find((f) => f.id === feature.positionRef?.sketchId);
      if (!refSketch) {
        errors.push({ featureId: feature.id, message: `配置基準のスケッチ(${feature.positionRef.sketchId})が存在しません` });
      } else if (refSketch.type !== "sketch") {
        errors.push({ featureId: feature.id, message: `配置基準の参照先(${feature.positionRef.sketchId})はスケッチではありません` });
      } else if (!refSketch.entities.find((e) => e.id === feature.positionRef?.entityId && (e.kind === "circle" || e.kind === "point"))) {
        errors.push({ featureId: feature.id, message: `配置基準の円/点(${feature.positionRef.entityId})が見つかりません` });
      }
    }
  } else if (feature.type === "mate") {
    if (feature.kind !== "coincident" && feature.kind !== "distance" && feature.kind !== "concentric") {
      errors.push({ featureId: feature.id, message: `合致(${feature.name})の種別が不正です` });
    }
    if (!feature.a.center.every((c) => Number.isFinite(c)) || !feature.a.normal.every((c) => Number.isFinite(c))) {
      errors.push({ featureId: feature.id, message: `合致(${feature.name})の面Aの中心・法線座標が不正です` });
    }
    if (!feature.b.center.every((c) => Number.isFinite(c)) || !feature.b.normal.every((c) => Number.isFinite(c))) {
      errors.push({ featureId: feature.id, message: `合致(${feature.name})の面Bの中心・法線座標が不正です` });
    }
    if (feature.kind === "coincident" || feature.kind === "distance") {
      if (feature.a.surface !== "plane" || feature.b.surface !== "plane") {
        errors.push({ featureId: feature.id, message: `合致(${feature.name})は両方の面が平面である必要があります` });
      }
    } else if (feature.a.surface !== "cylinder" || feature.b.surface !== "cylinder") {
      errors.push({ featureId: feature.id, message: `合致(${feature.name})は両方の面が円筒面である必要があります` });
    }
    if (feature.kind === "distance" && !isPositiveFiniteNumber(feature.value ?? NaN)) {
      errors.push({ featureId: feature.id, message: `合致(${feature.name})の距離は正の数である必要があります` });
    }
    // 少なくとも一方の面がpartInstance(部品配置)のボディに属していること(動かせる対象が必要)。
    const aOwner = allFeatures.find((f) => f.id === feature.a.bodyFeatureId);
    const bOwner = allFeatures.find((f) => f.id === feature.b.bodyFeatureId);
    if (aOwner?.type !== "partInstance" && bOwner?.type !== "partInstance") {
      errors.push({
        featureId: feature.id,
        message: `合致(${feature.name})は少なくとも一方の面が部品配置(パーツ)のボディに属している必要があります`,
      });
    }
    if (!aOwner) {
      errors.push({ featureId: feature.id, message: `合致(${feature.name})の対象ボディA(${feature.a.bodyFeatureId})が見つかりません` });
    }
    if (!bOwner) {
      errors.push({ featureId: feature.id, message: `合致(${feature.name})の対象ボディB(${feature.b.bodyFeatureId})が見つかりません` });
    }
  } else if (feature.type === "partInstance") {
    if (!feature.position.every((c) => Number.isFinite(c))) {
      errors.push({ featureId: feature.id, message: `部品配置(${feature.name})の位置座標が不正です` });
    }
    if (!feature.rotation.every((c) => Number.isFinite(c))) {
      errors.push({ featureId: feature.id, message: `部品配置(${feature.name})の回転角が不正です` });
    }
    if (
      typeof feature.part !== "object" ||
      feature.part === null ||
      feature.part.version !== 1 ||
      !Array.isArray(feature.part.features)
    ) {
      errors.push({ featureId: feature.id, message: `部品配置(${feature.name})の部品データの構造が不正です` });
    } else if (feature.part.features.some((f) => f.type === "partInstance")) {
      // 入れ子(アセンブリのアセンブリ)禁止。src/model/types.tsのPartInstanceFeatureコメント参照。
      errors.push({
        featureId: feature.id,
        message: `部品配置(${feature.name})の部品内に入れ子の部品配置を含めることはできません`,
      });
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
