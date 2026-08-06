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
import { Plane, draw, drawCircle, drawRectangle, type Drawing, type Edge, type Face, type Shape3D } from "replicad";

import type {
  CadDocument,
  FeatureId,
  Fillet3DFeature,
  FilletEdgeRef,
  PolygonCorner,
  ShellFaceRef,
  ShellFeature,
  SketchEntity,
  SketchFeature,
  SketchSegment,
} from "../model/types";
import { validatePolygonCorners } from "../model/validation";
import { effectivePolygonBulges } from "../sketch/bulge";
import { classifySketchEntities } from "../sketch/containment";
import { findClosedRegions, loopPolyline } from "../sketch/regions";
import { regularPolygonVertices, slotAxisNormal, SLOT_CAP_BULGE } from "../sketch/shapeFromPoints";
import type { ReferenceEdgeLine, ReferenceEdgeSet, SketchPlaneInfo } from "../protocol/messages";

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
  /**
   * 各スケッチフィーチャーの、評価時点の「現在ボディ」から抽出したスケッチ平面上の直線エッジ
   * (Phase 22、ボディ端面参照寸法用)。そのスケッチより前にボディが1つも組み立てられていない
   * (押し出しフィーチャーがまだ無い)スケッチは含まれない(空配列ではなく、この配列自体に
   * エントリが無い)。
   */
  referenceEdges: ReferenceEdgeSet[];
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
/** ボディ端面参照エッジ(Phase 22): 端点がスケッチ平面上に載っているとみなす平面距離許容(mm)。 */
const REFERENCE_EDGE_PLANE_TOLERANCE = 1e-4;
/**
 * 3Dフィレット/面取り(Phase 25a)のエッジ幾何マッチング(resolveFilletEdges)で使う許容値。
 * 中点距離はバウンディングボックス対角長に対する比率(面マッチングより厳しめ。エッジは面より
 * 密集しているため誤マッチを避ける)、方向は始点→終点ベクトルのなす角のcos(符号は無視するため
 * abs()を取って比較する。0.999 ≈ 約2.6度以内)。
 */
const EDGE_DISTANCE_TOLERANCE_RATIO = 0.1;
const EDGE_DIRECTION_COS_TOLERANCE = 0.999;

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
/**
 * corners と同様、bulges(Phase 17)は辺i(points[i]→points[i+1]、最後は points[n-1]→points[0])の
 * ふくらみをreplicadの DrawingPen#bulgeArcTo(end, bulge) で構築する。corners優先ルール
 * (同じ頂点にcornerとbulgeが両方指定されている場合はcornerを優先しbulgeを無視)は
 * effectivePolygonBulges()(src/sketch/bulge.ts)で解決する(polygonOutlinePointsと同じ規則)。
 * 閉じる辺(points[n-1]→points[0])にbulgeがある場合はclose()の前に明示的にbulgeArcToで
 * 描いておく(pointerが既にfirstPointと一致するため、close()内の"閉じる直線"はno-opになる)。
 */
function polygonDrawing(points: [number, number][], corners?: PolygonCorner[], bulges?: (number | null)[]): Drawing {
  const n = points.length;
  const effectiveBulges = effectivePolygonBulges(n, corners, bulges);
  let pen = draw(points[0]);
  for (let i = 1; i < n; i += 1) {
    const bulge = effectiveBulges[i - 1];
    pen = bulge ? pen.bulgeArcTo(points[i], bulge) : pen.lineTo(points[i]);
    const corner = corners?.[i];
    if (corner) {
      pen = pen.customCorner(corner.size, corner.kind);
    }
  }
  const closingBulge = effectiveBulges[n - 1];
  if (closingBulge) {
    pen = pen.bulgeArcTo(points[0], closingBulge);
  }
  const corner0 = corners?.[0];
  if (corner0) {
    return pen.closeWithCustomCorner(corner0.size, corner0.kind);
  }
  return pen.close();
}

/**
 * 直線スロット(中心線start→end、全幅width)をDrawingとして構築する(Phase 17)。
 * 両端の半円キャップは replicad の bulgeArcTo(end, ±1)(半円 = tan(±π/4) = ±1)で作る。
 * src/sketch/shapeFromPoints.ts の slotOutlinePoints() と同じ4隅(a,b,c,d)・向きを使うため、
 * オーバーレイ(ポリライン近似)と実際のB-Rep形状が一致する。
 */
function slotDrawing(entity: Extract<SketchEntity, { kind: "slot" }>): Drawing {
  const r = entity.width / 2;
  const n = slotAxisNormal(entity.start, entity.end);
  const [sx, sy] = entity.start;
  const [ex, ey] = entity.end;
  const a: [number, number] = [sx + n[0] * r, sy + n[1] * r];
  const b: [number, number] = [ex + n[0] * r, ey + n[1] * r];
  const c: [number, number] = [ex - n[0] * r, ey - n[1] * r];
  const d: [number, number] = [sx - n[0] * r, sy - n[1] * r];
  return draw(a).lineTo(b).bulgeArcTo(c, SLOT_CAP_BULGE).lineTo(d).bulgeArcTo(a, SLOT_CAP_BULGE).close();
}

/** 正多角形(外接円半径・辺数・回転)をDrawingとして構築する(Phase 17)。頂点計算はpolygonと同じ経路(cornersなし)で構築する。 */
function regularPolygonDrawing(entity: Extract<SketchEntity, { kind: "regularPolygon" }>): Drawing {
  const vertices = regularPolygonVertices(entity.center, entity.radius, entity.sides, entity.rotation ?? 0);
  return polygonDrawing(vertices);
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

/** 1つのエンティティ(rectangle/circle/polygon/slot/regularPolygon)をDrawingに変換する。 */
function entityDrawing(entity: SketchEntity): Drawing {
  if (entity.kind === "rectangle") {
    const [cx, cy] = entity.center;
    return drawRectangle(entity.width, entity.height).translate(cx, cy);
  }
  if (entity.kind === "circle") {
    const [cx, cy] = entity.center;
    return drawCircle(entity.radius).translate(cx, cy);
  }
  if (entity.kind === "slot") {
    return slotDrawing(entity);
  }
  if (entity.kind === "regularPolygon") {
    return regularPolygonDrawing(entity);
  }
  return polygonDrawing(entity.points, entity.corners, entity.bulges);
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
 * 1スケッチ分のプロファイルを「穴を適用する前の外形(solid)」と「穴の輪郭の合成(holes)」に
 * 分けて保持する(Phase 21: 2Dの Drawing#cut() ではなく3D側の Shape3D#cut() で穴を減算するための
 * 中間表現。理由はbuildDrawingParts()のコメント参照)。
 */
interface DrawingParts {
  /** 外形(穴を考慮しない状態)。entities由来の外枠とsegments由来の領域外枠をすべてfuseしたもの。 */
  solid: Drawing;
  /** 穴の輪郭をすべてfuseしたもの。穴が1つも無ければnull。 */
  holes: Drawing | null;
}

/**
 * 1つの閉ループ(src/sketch/regions.tsのLoop)をDrawingに変換する(Phase 19a)。
 * ループのセグメントは既に向き付け・連結済み(各セグメントのp2が次のセグメントのp1と一致し、
 * 最後のセグメントのp2が最初のセグメントのp1に戻る)なので、そのままlineTo/bulgeArcToで辿り、
 * 最後にclose()を呼ぶ(閉じる移動は既にpointerが始点にあるためno-opになる)。
 */
function loopDrawing(loop: SketchSegment[]): Drawing {
  let pen = draw(loop[0].p1);
  for (const segment of loop) {
    pen = segment.kind === "arc" && segment.bulge ? pen.bulgeArcTo(segment.p2, segment.bulge) : pen.lineTo(segment.p2);
  }
  return pen.close();
}

/** src/sketch/regions.tsのRegion由来の疑似polygonエンティティに付けるidの接頭辞(実entityのidと衝突しない前提)。 */
const REGION_PROXY_PREFIX = "__region_outer__";

/**
 * sketch内のentitiesとsegments(Phase 19a)を合成して、「外形(solid)」と「穴(holes)」に分けて返す。
 *
 * Phase 22修正: 以前はentities同士の外枠/穴分類(src/sketch/containment.ts)とsegments由来の
 * 各領域(Region)の外枠/穴分類(src/sketch/regions.ts、領域どうしの入れ子のみ判定)を、それぞれ
 * 独立に行ったうえでsolid同士・holes同士を単純にfuseしていた。そのため「線分ツールで描いた
 * 矩形(segments、閉領域の外枠)の中に円ツールで描いた円(entity)を置く」ような、entityと
 * segments領域をまたぐ包含関係は一切判定されず、円entityは(単独では他のentityに含まれないため)
 * 常にouter側に分類されて穴として減算されず、fuseされてしまっていた(報告バグの根本原因)。
 *
 * 修正方針: 各Regionの外枠ループ(region.outer)を、その頂点列(loopPolyline)を持つ疑似
 * polygonエンティティとしてラップし、実entities配列と合わせた1つの配列に対して
 * classifySketchEntities()(src/sketch/containment.ts、entity-entity間の厳密な包含判定を持つ
 * 既存の関数)を1回だけ適用する。これによりentity-entity・entity-region・region-entity・
 * region-region のすべての組み合わせで同じ包含判定ロジックが使われ、outer/holeの2階層分類が
 * ソース(entity/segments領域)をまたいで一貫する。
 *
 * 各Regionの内部の入れ子穴(region.holes、segments同士のみの入れ子)は、そのRegionの外枠が
 * 最終的にouter側と判定された場合はそのまま穴として保持する(region.outerがholeと判定された
 * 場合、region.holesは加味しない=そのRegion全体を単純な穴として扱う。entities側の「穴の中の島は
 * 既知の制限としてholeのまま扱われる」という既存の2階層制限と同じ設計。src/sketch/containment.ts
 * 冒頭のコメント参照)。
 *
 * 穴の減算(cut)をここでは行わない理由(Phase 21): 外形と穴の輪郭がちょうど接する
 * (タンジェント。例: 幅20の矩形の中心に半径10の円=辺の中点にちょうど接する)場合、OCCTの2D
 * ブーリアン(Drawing#cut())は縮退した境界を正しく扱えず、穴が全く減算されないまま(=無変化)の
 * 形状を返すことがある(実装検証で確認済み)。これは押し出し後の3D立体同士のcut()
 * (Shape3D#cut())では発生しない(実装検証で確認済み: 同じ寸法の組み合わせで2Dは失敗し3Dは
 * 成功する)。そのため呼び出し側のextrudeSketchFeature()で、外形と穴をそれぞれ独立に押し出してから
 * 3D側でcutする方式に変更した。
 *
 * どちらも図形/領域を持たない場合はエラー: segmentsが指定されているのに閉じた領域が
 * 1つも検出できない場合は「閉じた領域がありません」、segments自体が無い(entitiesのみ運用)
 * 場合は従来どおり「スケッチに図形がありません」。
 */
function buildDrawingParts(entities: SketchEntity[], segments: SketchSegment[] | undefined): DrawingParts {
  const regions = segments && segments.length > 0 ? findClosedRegions(segments) : [];

  if (entities.length === 0 && regions.length === 0) {
    if (segments && segments.length > 0) {
      throw new Error("閉じた領域がありません");
    }
    throw new Error("スケッチに図形がありません");
  }

  const regionProxies: SketchEntity[] = regions.map((region, index) => ({
    kind: "polygon",
    id: `${REGION_PROXY_PREFIX}${index}`,
    points: loopPolyline(region.outer),
  }));

  const { outers, holes } = classifySketchEntities([...entities, ...regionProxies]);
  const regionIndexOf = (entity: SketchEntity): number | null =>
    entity.id.startsWith(REGION_PROXY_PREFIX) ? Number(entity.id.slice(REGION_PROXY_PREFIX.length)) : null;

  let solid: Drawing | null = null;
  let holesDrawing: Drawing | null = null;

  const outerEntities: SketchEntity[] = [];
  for (const entity of outers) {
    const regionIndex = regionIndexOf(entity);
    if (regionIndex === null) {
      outerEntities.push(entity);
      continue;
    }
    // outer判定された領域: 自身の外枠に加えて、自身の内部の入れ子穴(region.holes)もそのまま穴に加える
    // (従来どおりの領域内入れ子判定、region-region間のみ)。
    const region = regions[regionIndex];
    const regionOuter = loopDrawing(region.outer);
    solid = solid ? solid.fuse(regionOuter) : regionOuter;
    for (const hole of region.holes) {
      const holeDrawing = loopDrawing(hole);
      holesDrawing = holesDrawing ? holesDrawing.fuse(holeDrawing) : holeDrawing;
    }
  }
  if (outerEntities.length > 0) {
    const entitiesSolid = fuseEntities(outerEntities);
    solid = solid ? solid.fuse(entitiesSolid) : entitiesSolid;
  }

  const holeEntities: SketchEntity[] = [];
  for (const entity of holes) {
    const regionIndex = regionIndexOf(entity);
    if (regionIndex === null) {
      holeEntities.push(entity);
      continue;
    }
    // hole判定された領域全体(その内部の入れ子穴=島は加味しない、上記コメント参照)。
    const regionOuter = loopDrawing(regions[regionIndex].outer);
    holesDrawing = holesDrawing ? holesDrawing.fuse(regionOuter) : regionOuter;
  }
  if (holeEntities.length > 0) {
    const entitiesHoles = fuseEntities(holeEntities);
    holesDrawing = holesDrawing ? holesDrawing.fuse(entitiesHoles) : entitiesHoles;
  }

  // entities/regionsのいずれかが非空である限り、classifySketchEntities()の性質上
  // outersは必ず1件以上になるため、solidは必ず非nullになる。
  return { solid: solid as Drawing, holes: holesDrawing };
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
 * bodyの現在のエッジ群から、fillet3dフィーチャーが選択時に記録したエッジスナップショット
 * (targets)を再解決する(Phase 25a)。
 * 1. 第一候補: edge.hashCode(選択時点のedgeId)が完全一致する、未使用のエッジ。
 * 2. フォールバック: 中点距離が最も近く(バウンディングボックス対角長の
 *    EDGE_DISTANCE_TOLERANCE_RATIO以内)、始点→終点方向がほぼ一致(cos>EDGE_DIRECTION_COS_TOLERANCE、
 *    符号は無視)する、未使用のエッジ。
 * 3. どちらも失敗した場合はエラーを投げる(呼び出し側でallEdgesを解放してから投げる)。
 *
 * 戻り値のmatched(targetsと同じ順序・長さ)とallEdges(bodyの全エッジ、delete()の責務は
 * 呼び出し側)は同じEdgeインスタンスを共有する(matchedはallEdgesの部分集合の参照)。
 * 使用replicad API: Shape.edges / Edge.hashCode / Edge.startPoint / Edge.endPoint /
 * Edge.pointAt(0.5) / Shape.boundingBox。
 */
function resolveFilletEdges(
  body: Shape3D,
  targets: FilletEdgeRef[],
): { matched: Edge[]; allEdges: Edge[] } {
  const allEdges = body.edges;
  const used = new Set<number>();

  const bbox = body.boundingBox;
  const diag = Math.sqrt(bbox.width ** 2 + bbox.height ** 2 + bbox.depth ** 2);
  bbox.delete();
  const maxDist = diag * EDGE_DISTANCE_TOLERANCE_RATIO;

  const matched: Edge[] = [];
  for (const target of targets) {
    let matchIndex = -1;

    for (let i = 0; i < allEdges.length; i += 1) {
      if (used.has(i)) continue;
      if (allEdges[i].hashCode === target.edgeId) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex === -1) {
      const targetDir = normalize(subtract(target.p2, target.p1));
      let bestDist = Infinity;
      for (let i = 0; i < allEdges.length; i += 1) {
        if (used.has(i)) continue;
        const edge = allEdges[i];
        const midVec = edge.pointAt(0.5);
        const mid = midVec.toTuple();
        midVec.delete();
        const dist = distance(mid, target.midpoint);
        if (dist > maxDist || dist >= bestDist) continue;
        const startVec = edge.startPoint;
        const endVec = edge.endPoint;
        const start = startVec.toTuple();
        const end = endVec.toTuple();
        startVec.delete();
        endVec.delete();
        const dir = normalize(subtract(end, start));
        const cosAngle = Math.abs(dot(dir, targetDir));
        if (cosAngle < EDGE_DIRECTION_COS_TOLERANCE) continue;
        bestDist = dist;
        matchIndex = i;
      }
    }

    if (matchIndex === -1) {
      allEdges.forEach((e) => e.delete());
      throw new Error("フィレット/面取りの対象エッジを特定できませんでした。フィーチャーを作り直してください");
    }
    used.add(matchIndex);
    matched.push(allEdges[matchIndex]);
  }

  return { matched, allEdges };
}

/**
 * fillet3dフィーチャーを現在のボディに適用し、新しいボディを返す(古いボディはこの関数内でdelete()する)。
 * replicadの Shape3D#fillet()/#chamfer() は第2引数に「EdgeFinderを受け取り、絞り込んだ
 * EdgeFinderを返す関数」を渡すことで対象エッジを絞り込める。ここでは EdgeFinder#inList()
 * (「渡したEdge配列とisSame()なエッジのみを残す」フィルタ)にresolveFilletEdges()で
 * 幾何マッチングしたエッジをそのまま渡す(カスタム述語が要るケースではないため、汎用の
 * EdgeFinder#when()は使わずinList()で十分)。半径過大等でOCCTが構築に失敗した場合はfillet()/
 * chamfer()がそのままErrorをthrowし、呼び出し元のevaluateDocument()のtry/catchで
 * featureId付きエラーに変換される。
 */
function applyFillet3D(body: Shape3D, feature: Fillet3DFeature): Shape3D {
  const { matched, allEdges } = resolveFilletEdges(body, feature.edges);
  try {
    const newBody =
      feature.kind === "fillet"
        ? body.fillet(feature.size, (finder) => finder.inList(matched))
        : body.chamfer(feature.size, (finder) => finder.inList(matched));
    body.delete();
    return newBody;
  } finally {
    allEdges.forEach((e) => e.delete());
  }
}

/**
 * bodyの現在の面群から、shellフィーチャーが選択時に記録した面スナップショット(targets)を
 * 再解決する(Phase 25b)。resolveFilletEdges()と同じ2段階マッチング方針(resolveFaceGeometry()の
 * 「面ID一致優先→平面かつ法線一致+中心最近傍」判定を、複数面かつ同一面の重複マッチ不可という
 * 条件に拡張したもの)。
 * 1. 第一候補: face.hashCode(選択時点のfaceId)が完全一致する、未使用の面。
 * 2. フォールバック: 平面(isPlanar)かつ法線がほぼ一致(cos>FACE_NORMAL_COS_TOLERANCE)し、
 *    中心距離が最も近い(バウンディングボックス対角長のFACE_DISTANCE_TOLERANCE_RATIO以内)、未使用の面。
 * 3. どちらも失敗した場合はエラーを投げる(呼び出し側でallFacesを解放してから投げる)。
 *
 * 戻り値のmatched(targetsと同じ順序・長さ)とallFaces(bodyの全面、delete()の責務は呼び出し側)は
 * 同じFaceインスタンスを共有する。使用replicad API: Shape.faces / Face.hashCode / Face.geomType /
 * Face.center / Face.normalAt() / Shape.boundingBox。
 */
function resolveShellFaces(body: Shape3D, targets: ShellFaceRef[]): { matched: Face[]; allFaces: Face[] } {
  const allFaces = body.faces;
  const used = new Set<number>();

  const bbox = body.boundingBox;
  const diag = Math.sqrt(bbox.width ** 2 + bbox.height ** 2 + bbox.depth ** 2);
  bbox.delete();
  const maxDist = diag * FACE_DISTANCE_TOLERANCE_RATIO;

  const matched: Face[] = [];
  for (const target of targets) {
    let matchIndex = -1;

    for (let i = 0; i < allFaces.length; i += 1) {
      if (used.has(i)) continue;
      if (allFaces[i].hashCode === target.faceId) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex === -1) {
      let bestDist = Infinity;
      for (let i = 0; i < allFaces.length; i += 1) {
        if (used.has(i)) continue;
        const face = allFaces[i];
        if (face.geomType !== "PLANE") continue;
        const info = faceCenterNormal(face);
        if (dot(info.normal, target.normal) < FACE_NORMAL_COS_TOLERANCE) continue;
        const dist = distance(info.center, target.center);
        if (dist > maxDist || dist >= bestDist) continue;
        bestDist = dist;
        matchIndex = i;
      }
    }

    if (matchIndex === -1) {
      allFaces.forEach((f) => f.delete());
      throw new Error("シェルの対象面を特定できませんでした。フィーチャーを作り直してください");
    }
    used.add(matchIndex);
    matched.push(allFaces[matchIndex]);
  }

  return { matched, allFaces };
}

/**
 * shellフィーチャーを現在のボディに適用し、新しいボディを返す(古いボディはこの関数内でdelete()する)。
 * replicadの Shape3D#shell(thickness, finderFcn) は第2引数に「FaceFinderを受け取り、絞り込んだ
 * FaceFinderを返す関数」を渡すことで開口する面を絞り込める。ここではFaceFinder#inList()
 * (「渡したFace配列とisSame()な面のみを残す」フィルタ)にresolveShellFaces()で幾何マッチングした
 * 面をそのまま渡す。thicknessは正の値で、node_modules/replicad/dist/replicad.jsのshell()実装が
 * 内部で-thicknessをBRepOffsetAPI_MakeThickSolidへ渡すため、選択面を取り除いた残りの面から
 * 内側へthickness(mm)の肉厚を残す(ボディの外形寸法は変わらない)規約になっている。
 * 過大な厚み等でOCCTが構築に失敗した場合はshell()がそのままErrorをthrowし、呼び出し元の
 * evaluateDocument()のtry/catchでfeatureId付きエラーに変換される。
 */
function applyShell3D(body: Shape3D, feature: ShellFeature): Shape3D {
  const { matched, allFaces } = resolveShellFaces(body, feature.faces);
  try {
    const newBody = body.shell(feature.thickness, (finder) => finder.inList(matched));
    body.delete();
    return newBody;
  } finally {
    allFaces.forEach((f) => f.delete());
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
 * bodyの中から、平面basis上に載っている(両端点の平面距離がREFERENCE_EDGE_PLANE_TOLERANCE未満)
 * 直線エッジ(geomType==="LINE")を抽出し、スケッチローカル2D座標(basisのxDir/yDir成分)に投影する
 * (Phase 22、ボディ端面参照寸法)。円弧・自由曲線エッジは対象外(v1)。
 * 使用replicad API: Shape.edges / Edge.geomType / Edge.startPoint / Edge.endPoint(いずれもVectorを
 * 返すため toTuple() 後に delete() する)。
 */
function extractReferenceEdges(body: Shape3D, basis: PlaneBasis): ReferenceEdgeLine[] {
  const result: ReferenceEdgeLine[] = [];
  const edges = body.edges;
  try {
    for (const edge of edges) {
      if (edge.geomType !== "LINE") continue;
      const startVec = edge.startPoint;
      const endVec = edge.endPoint;
      const start = startVec.toTuple();
      const end = endVec.toTuple();
      startVec.delete();
      endVec.delete();
      const relStart = subtract(start, basis.origin);
      const relEnd = subtract(end, basis.origin);
      const dStart = dot(relStart, basis.normal);
      const dEnd = dot(relEnd, basis.normal);
      if (Math.abs(dStart) > REFERENCE_EDGE_PLANE_TOLERANCE || Math.abs(dEnd) > REFERENCE_EDGE_PLANE_TOLERANCE) continue;
      const p1: [number, number] = [dot(relStart, basis.xDir), dot(relStart, basis.yDir)];
      const p2: [number, number] = [dot(relEnd, basis.xDir), dot(relEnd, basis.yDir)];
      result.push({ p1, p2 });
    }
  } finally {
    edges.forEach((e) => e.delete());
  }
  return result;
}

/**
 * 1つのDrawingを指定平面(名前付き平面文字列 または Plane インスタンス)・距離・方向で押し出す。
 * replicadの Sketch#extrude() / Sketches#extrude() は内部で押し出し元の sketch(wire)を
 * 自動的に delete() する実装になっている(CompoundSketchを除く)ため、呼び出し側で
 * sketchOnPlane() の戻り値を重ねて delete() する必要は無い(むしろ二重解放エラーになる)。
 */
function extrudeDrawing(drawing: Drawing, plane: "XY" | "XZ" | "YZ" | Plane, distance: number, direction: 1 | -1): Shape3D {
  const sketched = drawing.sketchOnPlane(plane as never);
  // sketchOnPlane() の戻り値は型上 SketchInterface | Sketches に分かれ、
  // extrude() の戻り値もそれぞれ Shape3D / AnyShape に広がるため明示キャストする。
  // 実際には押し出しは常に立体(Shape3D)を生む。
  return sketched.extrude(distance * direction) as Shape3D;
}

/**
 * sketchFeatureを押し出す。plane.kind === "world" の場合はXY平面上に、"face" の場合は
 * resolvedFacePlanes に事前計算しておいた面情報からスケッチ平面を組み立てて押し出す。
 *
 * 外形(solid)と穴(holes)は別々に押し出し、穴があれば3D側の Shape3D#cut() で減算する
 * (Phase 21: 2Dの Drawing#cut() は外形と穴の輪郭がちょうど接する場合にOCCTが正しく減算できず
 * 無変化の形状を返すことがあるため。buildDrawingParts()のコメント参照)。
 * 同じPlaneインスタンス(face参照の場合)を2回のsketchOnPlane()に使い回して問題ないのは、
 * sketchOnPlane()/extrude()が自動delete()するのは押し出し元のsketch(wire)のみで、
 * 渡したPlane自体は消費されないため(このあとの plane.delete() まで有効なまま)。
 */
function extrudeSketchFeature(
  sketch: SketchFeature,
  distance: number,
  direction: 1 | -1,
  resolvedFacePlanes: Map<FeatureId, { center: Tuple3; normal: Tuple3 }>,
): Shape3D {
  const { solid, holes } = buildDrawingParts(sketch.entities, sketch.segments);

  const plane: "XY" | "XZ" | "YZ" | Plane =
    sketch.plane.kind === "world"
      ? sketch.plane.plane
      : (() => {
          const resolved = resolvedFacePlanes.get(sketch.id);
          if (!resolved) {
            // sketch評価時(ループ内でtype==="sketch"を処理するタイミング)に必ず解決しているため
            // 通常はここに到達しない。
            throw new Error("内部エラー: 面参照スケッチの平面が解決されていません");
          }
          return buildFacePlane(resolved.center, resolved.normal);
        })();

  try {
    let shape = extrudeDrawing(solid, plane, distance, direction);
    if (holes) {
      const holeShape = extrudeDrawing(holes, plane, distance, direction);
      try {
        const cutResult = shape.cut(holeShape);
        shape.delete();
        shape = cutResult;
      } finally {
        holeShape.delete();
      }
    }
    return shape;
  } finally {
    if (sketch.plane.kind !== "world") (plane as Plane).delete();
  }
}

/**
 * 1つのDrawingを指定平面(名前付き平面文字列 または Plane インスタンス)・回転軸・角度で回転体にする
 * (Phase 25b)。replicadの Sketch#revolve()/Sketches#revolve()/CompoundSketch#revolve()(いずれも
 * SketchInterface#revolve(revolutionAxis?, {origin, angle})、node_modules/replicad/dist/replicad.d.ts
 * で確認済み)は内部で revolution(face, origin, revolutionAxis, angle) を呼ぶ。revolutionAxis/origin は
 * drawing.sketchOnPlane()が返すSketchのワールド座標系(wireそのものが既にプレーンの基底で
 * ワールド座標に変換済み)で解釈されるため、呼び出し側(revolveSketchFeature)でスケッチ平面の
 * ワールド基底(basis.origin / basis.xDir / basis.yDir)から求めたワールド方向・原点を渡す。
 * extrudeDrawing()と同様、sketchOnPlane()の戻り値(SketchInterface | Sketches)は
 * revolve()呼び出し時に自動的にdelete()される。
 */
function revolveDrawing(
  drawing: Drawing,
  plane: "XY" | "XZ" | "YZ" | Plane,
  axisDir: Tuple3,
  origin: Tuple3,
  angle: number,
): Shape3D {
  const sketched = drawing.sketchOnPlane(plane as never);
  // sketchOnPlane()の戻り値の型上、revolve()の戻り値はAnyShapeに広がる場合があるが、
  // 実際には回転体は常に立体(Shape3D)を生む(extrudeDrawing()の同様のコメント参照)。
  return sketched.revolve(axisDir, { origin, angle }) as Shape3D;
}

/**
 * sketchFeatureをaxis("x"|"y")周りにangle度回転させる(Phase 25b)。extrudeSketchFeature()と
 * 同様に外形(solid)と穴(holes)を別々に回転させ、穴があれば3D側のShape3D#cut()で減算する
 * (2Dの穴減算がタンジェント形状で失敗しうる問題[Phase 21のextrudeSketchFeature参照]を避けるため、
 * 押し出しと同じ設計を踏襲する)。
 * 回転軸はsketchBasisById(evaluateDocument()がsketch評価時に記録したワールド基底)から、
 * axis:"x"ならxDir、axis:"y"ならyDirを使う(いずれもスケッチ原点=basis.originを通る)。
 */
function revolveSketchFeature(
  sketch: SketchFeature,
  axis: "x" | "y",
  angle: number,
  resolvedFacePlanes: Map<FeatureId, { center: Tuple3; normal: Tuple3 }>,
  sketchBasisById: Map<FeatureId, PlaneBasis>,
): Shape3D {
  const { solid, holes } = buildDrawingParts(sketch.entities, sketch.segments);

  const plane: "XY" | "XZ" | "YZ" | Plane =
    sketch.plane.kind === "world"
      ? sketch.plane.plane
      : (() => {
          const resolved = resolvedFacePlanes.get(sketch.id);
          if (!resolved) {
            throw new Error("内部エラー: 面参照スケッチの平面が解決されていません");
          }
          return buildFacePlane(resolved.center, resolved.normal);
        })();

  const basis = sketchBasisById.get(sketch.id);
  if (!basis) {
    throw new Error("内部エラー: スケッチ平面の基底が見つかりません");
  }
  const axisDir = axis === "x" ? basis.xDir : basis.yDir;
  const origin = basis.origin;

  try {
    let shape = revolveDrawing(solid, plane, axisDir, origin, angle);
    if (holes) {
      const holeShape = revolveDrawing(holes, plane, axisDir, origin, angle);
      try {
        const cutResult = shape.cut(holeShape);
        shape.delete();
        shape = cutResult;
      } finally {
        holeShape.delete();
      }
    }
    return shape;
  } finally {
    if (sketch.plane.kind !== "world") (plane as Plane).delete();
  }
}

/**
 * extrude/revolve共通の「ボディへの適用(newBody/cut/add)」分岐(Phase 25b)。buildToolは
 * 実際にDrawingから立体を組み立てるクロージャ(extrudeSketchFeature()/revolveSketchFeature()を渡す)で、
 * newBody以外の場合にのみ呼ばれる(newBodyはbuildTool()の結果がそのまま新しいボディになる)。
 * 戻り値は新しいボディ(古いbody/toolはこの関数内でdelete()される)。
 */
function applyBodyOperation(
  body: Shape3D | null,
  operation: "newBody" | "cut" | "add",
  buildTool: () => Shape3D,
): Shape3D {
  if (operation === "newBody") {
    if (body) {
      throw new Error("単一ボディのみ対応です(既にボディが存在します)");
    }
    return buildTool();
  }
  if (operation === "cut") {
    if (!body) {
      throw new Error("カット対象のボディがありません");
    }
    const tool = buildTool();
    let cutResult: Shape3D;
    try {
      cutResult = body.cut(tool);
    } finally {
      tool.delete();
    }
    body.delete();
    return cutResult;
  }
  // operation === "add"
  if (!body) {
    throw new Error("追加対象のボディがありません");
  }
  const tool = buildTool();
  let fuseResult: Shape3D;
  try {
    fuseResult = body.fuse(tool);
  } finally {
    tool.delete();
  }
  body.delete();
  return fuseResult;
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
  // 各スケッチの解決済みワールド基底(sketchId -> basis、Phase 25b)。回転体フィーチャーが
  // 回転軸(スケッチローカルX/Y)のワールド方向・原点を求めるために使う。
  const sketchBasisById = new Map<FeatureId, PlaneBasis>();
  // 各extrudeフィーチャー評価直後のボディのスナップショット(featureId -> クローン)。
  // 後続のface参照スケッチが面を再解決するために使う。Shape.clone()はOCCTの参照カウント
  // ベースの軽量コピーであり、live側のbodyを delete() してもスナップショット側は無効化されない
  // (逆も同様)。評価終了時(成功/失敗いずれでも)にすべて delete() する。
  const snapshots = new Map<FeatureId, Shape3D>();
  // 各スケッチが評価された時点の「現在ボディ」から抽出したスケッチ平面上の直線エッジ(Phase 22)。
  // その時点でボディが存在しない(押し出しがまだ無い)スケッチはエントリを作らない。
  const referenceEdgesById = new Map<FeatureId, ReferenceEdgeLine[]>();
  let body: Shape3D | null = null;
  let currentFeatureId: FeatureId | undefined;

  try {
    for (const feature of doc.features) {
      currentFeatureId = feature.id;

      if (feature.type === "sketch") {
        let basis: PlaneBasis;
        if (feature.plane.kind === "world") {
          // world平面はXY/XZ/YZの3枚(PlaneRefの型で保証済み)。追加の検証は不要。
          basis = WORLD_PLANE_BASES[feature.plane.plane];
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
          basis = facePlaneBasis(resolved.center, resolved.normal);
        }
        sketchBasisById.set(feature.id, basis);
        if (body) {
          referenceEdgesById.set(feature.id, extractReferenceEdges(body, basis));
        }
        validateSketchPolygonCorners(feature);
        sketches.set(feature.id, feature);
        continue;
      }

      if (feature.type === "fillet3d") {
        if (!body) {
          throw new Error("フィレット/面取りの対象となるボディがありません");
        }
        body = applyFillet3D(body, feature);
        snapshots.set(feature.id, body.clone());
        continue;
      }

      if (feature.type === "shell") {
        if (!body) {
          throw new Error("シェルの対象となるボディがありません");
        }
        body = applyShell3D(body, feature);
        snapshots.set(feature.id, body.clone());
        continue;
      }

      if (feature.type === "revolve") {
        const sketch = sketches.get(feature.sketchId);
        if (!sketch) {
          throw new Error(`参照先のスケッチ(${feature.sketchId})が見つかりません`);
        }
        body = applyBodyOperation(body, feature.operation, () =>
          revolveSketchFeature(sketch, feature.axis, feature.angle, resolvedFacePlanes, sketchBasisById),
        );
        snapshots.set(feature.id, body.clone());
        continue;
      }

      // feature.type === "extrude"
      const sketch = sketches.get(feature.sketchId);
      if (!sketch) {
        throw new Error(`参照先のスケッチ(${feature.sketchId})が見つかりません`);
      }
      body = applyBodyOperation(body, feature.operation, () =>
        extrudeSketchFeature(sketch, feature.distance, feature.direction, resolvedFacePlanes),
      );
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

  const referenceEdges: ReferenceEdgeSet[] = [];
  for (const [sketchId, edges] of referenceEdgesById) {
    referenceEdges.push({ sketchId, edges });
  }

  return { ok: true, shape: body, sketchPlanes, referenceEdges };
}
