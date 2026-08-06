// CadDocument.features を先頭から逐次評価し、Replicadの形状(AnyShape)を組み立てる。
// Worker内でのみimportすること(Replicad = OpenCascade WASM への依存を持つため)。
//
// サポート範囲:
//   - sketch: plane は world XY/XZ/YZ(基準平面) / 面参照(face)の両方
//     - face参照は、参照先フィーチャー評価直後のボディ・スナップショットから面を再解決する。
//       1. 第一候補: face.hashCode(選択時点のfaceId)が一致する面
//       2. フォールバック: 平面(isPlanar)かつ法線がほぼ一致(cos>0.999)し、
//          中心距離が最も近い(バウンディングボックス対角長の50%以内)面
//       3. どちらも失敗したらエラー(featureId付き。UIで再選択を促す)
//   - entities: rectangle / circle / polygon(頂点ごとのフィレット/面取り指定 corners に対応。
//     replicadのDrawingPen#customCorner()/#closeWithCustomCorner()を使う。頂点0(始点)を
//     含む全頂点でコーナー処理可能。OCCT構築前に隣接辺に対して明らかに大きすぎるサイズを
//     弾く粗い事前バリデーションを行う)
//   - extrude: operation "newBody"(最初の1回のみ) / "cut"(既存ボディが必要) / "add"(既存ボディが必要。fuseで結合)
//   - direction: -1 は逆向き押し出し(面参照の場合は面法線の逆方向)
import { Plane, draw, drawCircle, drawRectangle, type Drawing, type Face, type Shape3D } from "replicad";

import type { CadDocument, FeatureId, PolygonCorner, SketchEntity, SketchFeature } from "../model/types";
import { validatePolygonCorners } from "../model/validation";
import { classifySketchEntities } from "../sketch/containment";
import type { SketchPlaneInfo } from "../protocol/messages";

export interface EvaluationSuccess {
  ok: true;
  /**
   * 押し出しフィーチャーが1つも無い(=ボディが存在しない)場合はnull。
   * これはエラーではなく正常なドキュメント状態(空ドキュメント/スケッチのみ)として扱う(Phase 13)。
   * 呼び出し側(Worker)はnullのとき空メッシュを返す。
   */
  shape: Shape3D | null;
  /**
   * 各スケッチフィーチャーの解決済み平面基底(ワールド座標系)。
   * doc.features中の全スケッチが対象(押し出しに使われていないスケッチも含む)。
   * face参照スケッチの解決に失敗した場合は評価全体がエラーになるため、
   * この配列が返る時点(ok:true)では全スケッチが解決済みである。
   */
  sketchPlanes: SketchPlaneInfo[];
}

export interface EvaluationFailure {
  ok: false;
  featureId?: FeatureId;
  message: string;
}

export type EvaluationResult = EvaluationSuccess | EvaluationFailure;

type Tuple3 = [number, number, number];

/** 面法線の一致とみなす角度許容(cos値。0.999 ≈ 約2.6度以内)。 */
const FACE_NORMAL_COS_TOLERANCE = 0.999;
/** 面中心の距離許容(バウンディングボックス対角長に対する比率)。 */
const FACE_DISTANCE_TOLERANCE_RATIO = 0.5;

function subtract(a: Tuple3, b: Tuple3): Tuple3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Tuple3, b: Tuple3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function length(v: Tuple3): number {
  return Math.sqrt(dot(v, v));
}
function distance(a: Tuple3, b: Tuple3): number {
  return length(subtract(a, b));
}
function cross(a: Tuple3, b: Tuple3): Tuple3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(v: Tuple3): Tuple3 {
  const len = length(v);
  if (len < 1e-12) return v;
  return [v[0] / len, v[1] / len, v[2] / len];
}

interface PlaneBasis {
  origin: Tuple3;
  xDir: Tuple3;
  yDir: Tuple3;
  normal: Tuple3;
}

/**
 * world平面(XY/XZ/YZ)の解決済み基底(sketchPlanes用)。
 * replicadのPLANES_CONFIG(node_modules/replicad/dist/replicad.js)が定義する
 * 名前付き平面と厳密に一致させる(xDir/normalがconfig値、yDir = normalize(normal) × normalize(xDir))。
 *   XY: xDir=[1,0,0] normal=[0,0,1]  -> yDir=[0,1,0]
 *   XZ: xDir=[1,0,0] normal=[0,-1,0] -> yDir=[0,0,1]
 *   YZ: xDir=[0,1,0] normal=[1,0,0]  -> yDir=[0,0,1]
 */
const WORLD_PLANE_BASES: Record<"XY" | "XZ" | "YZ", PlaneBasis> = {
  XY: { origin: [0, 0, 0], xDir: [1, 0, 0], yDir: [0, 1, 0], normal: [0, 0, 1] },
  XZ: { origin: [0, 0, 0], xDir: [1, 0, 0], yDir: [0, 0, 1], normal: [0, -1, 0] },
  YZ: { origin: [0, 0, 0], xDir: [0, 1, 0], yDir: [0, 0, 1], normal: [1, 0, 0] },
};

/**
 * polygonエンティティの頂点列(3点以上、閉ループ)からDrawingを構築する。
 * draw(始点).lineTo(...).close() で閉じたプロファイルを作る(replicadのDrawingPen API)。
 * 自己交差の厳密チェックはしない(評価時にOCCTがエラーを出せば既存のfeatureIdエラー経路に乗る)。
 *
 * corners[i] が指定されていれば points[i] の頂点にフィレット/面取りを適用する(Phase 11)。
 * replicadの DrawingPen#customCorner(size, mode) は「直前に描いた曲線」と「次に描く曲線」の間の
 * コーナーに遅延適用される(次のlineTo/close時点のsaveCurve()で実際に適用される)。そのため
 * points[i](i>=1)にコーナーを付けたい場合は、その頂点へのlineTo()の直後・次のlineTo()より前に
 * customCorner()を呼ぶ(呼んだ時点では確定せず、次の曲線が描かれた時に頂点iのコーナーとして
 * 適用される)。
 *
 * 頂点0(始点)のコーナーは通常のcustomCorner()では扱えない(始点にはまだ「前の曲線」が
 * 存在しないため)。replicadは専用の DrawingPen#closeWithCustomCorner(size, mode) を提供しており、
 * これは close()と同様にプロファイルを閉じたうえで、最後に描いた曲線(閉じる辺)と最初に描いた
 * 曲線(始点からの最初の辺)の間、すなわち頂点0、にコーナーを適用する
 * (_customCornerLastWithFirst()がpendingCurvesの先頭と末尾を取り出して処理する実装のため)。
 * これにより頂点0を含む全頂点でフィレット/面取りが可能(回避策の頂点シフトは不要)。
 */
function polygonDrawing(points: [number, number][], corners?: PolygonCorner[]): Drawing {
  let pen = draw(points[0]);
  for (let i = 1; i < points.length; i += 1) {
    pen = pen.lineTo(points[i]);
    const corner = corners?.[i];
    if (corner) {
      pen = pen.customCorner(corner.size, corner.kind);
    }
  }
  const corner0 = corners?.[0];
  if (corner0) {
    return pen.closeWithCustomCorner(corner0.size, corner0.kind);
  }
  return pen.close();
}

/**
 * sketch内のpolygonエンティティのコーナー指定(fillet/chamfer)を検証する(Phase 11)。
 * OCCTでの実際のプロファイル構築(buildDrawing)より前に呼ぶことで、サイズが隣接辺に対して
 * 明らかに大きすぎる場合にわかりやすいメッセージのエラーを早期に返す(「粗い事前チェック」。
 * 自己交差等の厳密な破綻判定はOCCTに任せ、失敗時は通常のtry/catch経由でfeatureId付き
 * エラーになる)。エラーがあれば最初の1件のメッセージでthrowする。
 */
function validateSketchPolygonCorners(sketch: SketchFeature): void {
  for (const entity of sketch.entities) {
    if (entity.kind !== "polygon" || !entity.corners) continue;
    const errors = validatePolygonCorners(entity.id, entity.points, entity.corners);
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }
  }
}

/** 1つのエンティティ(rectangle/circle/polygon)をDrawingに変換する。 */
function entityDrawing(entity: SketchEntity): Drawing {
  if (entity.kind === "rectangle") {
    const [cx, cy] = entity.center;
    return drawRectangle(entity.width, entity.height).translate(cx, cy);
  }
  if (entity.kind === "circle") {
    const [cx, cy] = entity.center;
    return drawCircle(entity.radius).translate(cx, cy);
  }
  return polygonDrawing(entity.points, entity.corners);
}

/** エンティティ列をfuseで1つのDrawingに合成する(entitiesは非空を前提)。 */
function fuseEntities(entities: SketchEntity[]): Drawing {
  let drawing: Drawing | null = null;
  for (const entity of entities) {
    const piece = entityDrawing(entity);
    drawing = drawing ? drawing.fuse(piece) : piece;
  }
  // 呼び出し側で entities.length > 0 を保証しているため drawing は必ず非null。
  return drawing as Drawing;
}

/**
 * sketch内のentities(rectangle/circle/polygon)を1つのDrawingに合成する(Phase 15: 入れ子穴対応)。
 * src/sketch/containment.ts の分類(2階層: 外枠/穴)に基づき、
 * 外枠(outers)同士をfuseしたのち、穴(holes)を外枠に含まれる他のいずれのエンティティにも
 * 完全に含まれるエンティティ)をまとめてfuseしてcutする。部分的に重なる(包含ではない)
 * エンティティは従来どおりfuse対象のまま(いずれもoutersに分類される)。
 */
function buildDrawing(entities: SketchEntity[]): Drawing {
  if (entities.length === 0) {
    throw new Error("スケッチに図形がありません");
  }

  const { outers, holes } = classifySketchEntities(entities);
  // entitiesが非空である限り、包含関係に循環は起こり得ないため outers は必ず1件以上になる。
  let drawing = fuseEntities(outers);
  if (holes.length > 0) {
    const holeDrawing = fuseEntities(holes);
    drawing = drawing.cut(holeDrawing);
  }
  return drawing;
}

/** faceの中心・法線をプレーンなタプルとして取り出す(Vectorラッパーは即delete)。 */
function faceCenterNormal(face: Face): { center: Tuple3; normal: Tuple3 } {
  const centerVec = face.center;
  const normalVec = face.normalAt();
  const center = centerVec.toTuple();
  const normal = normalVec.toTuple();
  centerVec.delete();
  normalVec.delete();
  return { center, normal };
}

/**
 * 参照ボディ(スナップショット)の中から、選択時点のfaceId/center/normalを手がかりに面を再解決する。
 * 1. face.hashCode(faceId)が完全一致する面を最優先で採用する。
 * 2. 一致しなければ、平面(isPlanar)かつ法線がほぼ一致(cos>0.999)し、
 *    中心距離が最も近い面を採用する(距離がバウンディングボックス対角長の50%を超えるものは除外)。
 * 3. どちらも失敗した場合はエラーを投げる。
 *
 * 使用replicad API: Shape.faces / Face.hashCode / Face.geomType / Face.center / Face.normalAt() / Shape.boundingBox。
 */
function resolveFaceGeometry(
  shape: Shape3D,
  faceId: number,
  savedCenter: Tuple3,
  savedNormal: Tuple3,
): { center: Tuple3; normal: Tuple3 } {
  const faces = shape.faces;
  try {
    const byId = faces.find((f) => f.hashCode === faceId);
    if (byId) {
      return faceCenterNormal(byId);
    }

    const bbox = shape.boundingBox;
    const diag = Math.sqrt(bbox.width ** 2 + bbox.height ** 2 + bbox.depth ** 2);
    bbox.delete();
    const maxDist = diag * FACE_DISTANCE_TOLERANCE_RATIO;

    let best: { center: Tuple3; normal: Tuple3; dist: number } | null = null;
    for (const face of faces) {
      if (face.geomType !== "PLANE") continue;
      const info = faceCenterNormal(face);
      if (dot(info.normal, savedNormal) < FACE_NORMAL_COS_TOLERANCE) continue;
      const dist = distance(info.center, savedCenter);
      if (dist > maxDist) continue;
      if (!best || dist < best.dist) {
        best = { center: info.center, normal: info.normal, dist };
      }
    }
    if (best) {
      return { center: best.center, normal: best.normal };
    }

    throw new Error("面を特定できませんでした。面を選択し直してください");
  } finally {
    faces.forEach((f) => f.delete());
  }
}

/**
 * 面の法線から、決定的なxDir(未正規化)を求める。
 * xDir は 法線とグローバルZの外積(normal × Z)。ほぼ平行(Z軸自体を向く面)な場合はグローバルXにフォールバックする。
 * buildFacePlane() と facePlaneBasis() の両方がこの関数を使うことで、
 * evaluatorが実際に押し出しに使うPlaneの基底とsketchPlanes応答の基底を一致させる。
 */
function facePlaneRawXDir(normal: Tuple3): Tuple3 {
  const GLOBAL_Z: Tuple3 = [0, 0, 1];
  const xDir = cross(normal, GLOBAL_Z);
  if (length(xDir) < 1e-8) {
    return [1, 0, 0];
  }
  return xDir;
}

/**
 * 面の中心・法線から、決定的なxDirを持つスケッチ平面(Plane)を構築する。
 * 呼び出し側で使用後に plane.delete() すること。
 */
function buildFacePlane(center: Tuple3, normal: Tuple3): Plane {
  return new Plane(center, facePlaneRawXDir(normal), normal);
}

/**
 * buildFacePlane()が構築するreplicad Planeと同一の基底を、プレーンなタプルとして計算する
 * (sketchPlanes応答用。Plane自身はOCCTオブジェクトを保持するため使い回さない)。
 * replicadのPlaneコンストラクタと同じ正規化手順(zDir=normalize(normal),
 * xDir=normalize(rawXDir), yDir=normalize(zDir×xDir))を踏襲する。
 */
function facePlaneBasis(center: Tuple3, normal: Tuple3): PlaneBasis {
  const zDir = normalize(normal);
  const xDir = normalize(facePlaneRawXDir(normal));
  const yDir = normalize(cross(zDir, xDir));
  return { origin: center, xDir, yDir, normal: zDir };
}

/**
 * sketchFeatureをDrawingに変換し、指定距離・方向で押し出す。
 * plane.kind === "world" の場合はXY平面上に、"face" の場合は resolvedFacePlanes に
 * 事前計算しておいた面情報からスケッチ平面を組み立てて押し出す。
 *
 * 注意: replicadの Sketch#extrude() / Sketches#extrude() は内部で押し出し元の
 * sketch(wire)を自動的に delete() する実装になっている(CompoundSketchを除く)。
 * そのため呼び出し側でsketchOnPlane()の戻り値を重ねて delete() すると
 * 「This object has been deleted」の二重解放エラーになる。ここでは呼ばない。
 */
function extrudeSketchFeature(
  sketch: SketchFeature,
  distance: number,
  direction: 1 | -1,
  resolvedFacePlanes: Map<FeatureId, { center: Tuple3; normal: Tuple3 }>,
): Shape3D {
  const drawing = buildDrawing(sketch.entities);

  if (sketch.plane.kind === "world") {
    // replicadは"XY"/"XZ"/"YZ"を名前付き平面としてそのまま受け付ける(sketchOnPlane参照)。
    const sketched = drawing.sketchOnPlane(sketch.plane.plane);
    // sketchOnPlane() の戻り値は型上 SketchInterface | Sketches に分かれ、
    // extrude() の戻り値もそれぞれ Shape3D / AnyShape に広がるため明示キャストする。
    // 実際には押し出しは常に立体(Shape3D)を生む。
    return sketched.extrude(distance * direction) as Shape3D;
  }

  const resolved = resolvedFacePlanes.get(sketch.id);
  if (!resolved) {
    // sketch評価時(ループ内でtype==="sketch"を処理するタイミング)に必ず解決しているため
    // 通常はここに到達しない。
    throw new Error("内部エラー: 面参照スケッチの平面が解決されていません");
  }
  const plane = buildFacePlane(resolved.center, resolved.normal);
  try {
    const sketched = drawing.sketchOnPlane(plane);
    return sketched.extrude(distance * direction) as Shape3D;
  } finally {
    plane.delete();
  }
}

/**
 * ドキュメントを評価してひとつのAnyShapeを返す。
 * 失敗時は featureId(特定できれば) 付きのエラーを返す。
 * 成功時に返るshapeの解放は呼び出し側の責務。失敗時は内部で生成した中間形状をすべて解放する。
 */
export function evaluateDocument(doc: CadDocument): EvaluationResult {
  const sketches = new Map<FeatureId, SketchFeature>();
  // face参照スケッチの解決済み平面情報(sketchId -> center/normal)。sketch評価時に確定する。
  const resolvedFacePlanes = new Map<FeatureId, { center: Tuple3; normal: Tuple3 }>();
  // 各extrudeフィーチャー評価直後のボディのスナップショット(featureId -> クローン)。
  // 後続のface参照スケッチが面を再解決するために使う。Shape.clone()はOCCTの参照カウント
  // ベースの軽量コピーであり、live側のbodyを delete() してもスナップショット側は無効化されない
  // (逆も同様)。評価終了時(成功/失敗いずれでも)にすべて delete() する。
  const snapshots = new Map<FeatureId, Shape3D>();
  let body: Shape3D | null = null;
  let currentFeatureId: FeatureId | undefined;

  try {
    for (const feature of doc.features) {
      currentFeatureId = feature.id;

      if (feature.type === "sketch") {
        if (feature.plane.kind === "world") {
          // world平面はXY/XZ/YZの3枚(PlaneRefの型で保証済み)。追加の検証は不要。
        } else {
          const refShape = snapshots.get(feature.plane.featureId);
          if (!refShape) {
            throw new Error(`参照先のフィーチャー(${feature.plane.featureId})の形状が見つかりません`);
          }
          const resolved = resolveFaceGeometry(
            refShape,
            feature.plane.faceId,
            feature.plane.center,
            feature.plane.normal,
          );
          resolvedFacePlanes.set(feature.id, resolved);
        }
        validateSketchPolygonCorners(feature);
        sketches.set(feature.id, feature);
        continue;
      }

      // feature.type === "extrude"
      const sketch = sketches.get(feature.sketchId);
      if (!sketch) {
        throw new Error(`参照先のスケッチ(${feature.sketchId})が見つかりません`);
      }

      if (feature.operation === "newBody") {
        if (body) {
          throw new Error("単一ボディのみ対応です(既にボディが存在します)");
        }
        body = extrudeSketchFeature(sketch, feature.distance, feature.direction, resolvedFacePlanes);
      } else if (feature.operation === "cut") {
        if (!body) {
          throw new Error("カット対象のボディがありません");
        }
        const tool = extrudeSketchFeature(sketch, feature.distance, feature.direction, resolvedFacePlanes);
        let cutResult: Shape3D;
        try {
          cutResult = body.cut(tool);
        } finally {
          tool.delete();
        }
        body.delete();
        body = cutResult;
      } else {
        // feature.operation === "add"
        if (!body) {
          throw new Error("追加対象のボディがありません");
        }
        const tool = extrudeSketchFeature(sketch, feature.distance, feature.direction, resolvedFacePlanes);
        let fuseResult: Shape3D;
        try {
          fuseResult = body.fuse(tool);
        } finally {
          tool.delete();
        }
        body.delete();
        body = fuseResult;
      }

      snapshots.set(feature.id, body.clone());
    }
  } catch (err) {
    if (body) body.delete();
    for (const snap of snapshots.values()) snap.delete();
    return {
      ok: false,
      featureId: currentFeatureId,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  for (const snap of snapshots.values()) snap.delete();

  // body===null(押し出しフィーチャーが1つも無い)は、空ドキュメント/スケッチのみの
  // ドキュメントとして正常なケースである(Phase 13)。エラーにはしない。
  // ここに到達した時点でループは最後まで例外なく完走しているため、
  // sketchesに登録された全スケッチ(world/faceいずれも)の平面基底が解決済みである。
  const sketchPlanes: SketchPlaneInfo[] = [];
  for (const [sketchId, sketch] of sketches) {
    if (sketch.plane.kind === "world") {
      sketchPlanes.push({ sketchId, ...WORLD_PLANE_BASES[sketch.plane.plane] });
      continue;
    }
    const resolved = resolvedFacePlanes.get(sketchId);
    if (!resolved) continue; // 到達しないはずのガード。
    const basis = facePlaneBasis(resolved.center, resolved.normal);
    sketchPlanes.push({ sketchId, ...basis });
  }

  return { ok: true, shape: body, sketchPlanes };
}
