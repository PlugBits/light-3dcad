// CadDocument.features を先頭から逐次評価し、Replicadの形状(AnyShape)を組み立てる。
// Worker内でのみimportすること(Replicad = OpenCascade WASM への依存を持つため)。
//
// サポート範囲:
//   - sketch: plane は world XY/XZ/YZ(基準平面) / 面参照(face)の両方
//     - face参照は、参照先フィーチャー評価直後の「全ボディのcompound」スナップショットから
//       面を再解決する(Phase 27a複数ボディ対応。スナップショット自体はcompoundなので単一ボディ時と
//       同じ面/エッジ列挙ロジックがそのまま使える)。
//       1. 第一候補: face.hashCode(選択時点のfaceId)が一致する面
//       2. フォールバック: 平面(isPlanar)かつ法線がほぼ一致(cos>0.999)し、
//          中心距離が最も近い(バウンディングボックス対角長の50%以内)面
//       3. どちらも失敗したらエラー(featureId付き。UIで再選択を促す)
//   - entities: rectangle / circle / polygon(頂点ごとのフィレット/面取り指定 corners に対応。
//     replicadのDrawingPen#customCorner()/#closeWithCustomCorner()を使う。頂点0(始点)を
//     含む全頂点でコーナー処理可能。OCCT構築前に隣接辺に対して明らかに大きすぎるサイズを
//     弾く粗い事前バリデーションを行う)
//   - extrude/revolve: operation "newBody"(常に新しい独立ボディを作る。複数回可、Phase 27a) /
//     "cut"・"add"(targetBodyId省略時は最後に作られたボディが対象。指定時はそのボディのみに適用)
//   - fillet3d/shell/thread: エッジ/面の幾何マッチングを全ボディ横断で行い、最良マッチのボディに適用する
//   - direction: -1 は逆向き押し出し(面参照の場合は面法線の逆方向)
//   - partInstance(簡易アセンブリ、Phase 27b): 埋め込まれた部品CadDocument(part)をevaluateDocument()で
//     評価し(部品内にpartInstanceを含めることは禁止、入れ子なし=再帰は最大1段)、結果compoundを
//     rotation(X→Y→Z順)・positionで変換してbodiesマップに新規ボディとして追加する(newBodyと同じ扱い)。
//     部品docのJSON文字列をキーに変換前compoundをWorkerメモリにLRUキャッシュし(上限5件)、
//     同一部品の再評価(重いフィーチャーの再計算)を避ける。
//
// 複数ボディ管理(Phase 27a): 単一の `body` 変数の代わりに `bodies: Map<FeatureId, Shape3D>`
// (キー=そのボディを作ったnewBodyフィーチャーのid)を評価ループ全体で保持する。各フィーチャー評価後の
// スナップショット・最終結果はいずれも「全ボディのcompound」(buildBodiesCompound())にする。
//
// 干渉チェック(checkInterference()、Phase 28b): doc.featuresを評価してbodiesマップを組み立てる
// コア処理はevaluateFeatures()に切り出してあり、evaluateDocument()(最終compound化)と
// checkInterference()(ボディをペアごとにintersect()して交差体積>1e-6mm³のペアを報告)の両方から
// 使う。オンデマンド実行専用(Worker/UI側は明示的な要求時のみ呼ぶ)。
import {
  loft,
  makeCompound,
  makeCylinder,
  measureVolume,
  Plane,
  draw,
  drawCircle,
  drawRectangle,
  type Drawing,
  type Edge,
  type Face,
  type Sketch,
  type Shape3D,
  type Wire,
} from "replicad";

import type {
  CadDocument,
  FeatureId,
  Fillet3DFeature,
  FilletEdgeRef,
  PartInstanceFeature,
  PolygonCorner,
  ShellFaceRef,
  ShellFeature,
  SketchEntity,
  SketchFeature,
  SketchSegment,
  ThreadFeature,
} from "../model/types";
import { validatePolygonCorners } from "../model/validation";
import { effectivePolygonBulges } from "../sketch/bulge";
import { classifySketchEntities } from "../sketch/containment";
import { computeFacePlaneBasis, facePlaneRawXDir } from "../sketch/facePlaneBasis";
import { findClosedRegions, loopPolyline } from "../sketch/regions";
import { regularPolygonVertices, slotAxisNormal, SLOT_CAP_BULGE } from "../sketch/shapeFromPoints";
import { MALE_THREAD_MAX_LENGTH, THREAD_PRESET_TABLE, threadDrillDiameter } from "../model/threadPresets";
import type { BodyGroup, ReferenceEdgeLine, ReferenceEdgeSet, SketchPlaneInfo } from "../protocol/messages";

export interface EvaluationSuccess {
  ok: true;
  /**
   * newBodyフィーチャーが1つも無い(=ボディが存在しない)場合はnull。
   * これはエラーではなく正常なドキュメント状態(空ドキュメント/スケッチのみ)として扱う(Phase 13)。
   * 呼び出し側(Worker)はnullのとき空メッシュを返す。
   * 複数ボディ(Phase 27a)がある場合は、全ボディをまとめたcompound(replicadのmakeCompound()。
   * mesh/faces/edges/boundingBox/blobSTL/blobSTEP等は単一ボディ同様に使える)になる。
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
  /**
   * 各ボディ(bodies Mapの各要素)を構成する面IDの集合(Phase 28a、部品ドラッグ配置のヒット判定用)。
   * compound化前のbodiesマップから直接収集する(buildBodiesCompound()参照。Shape.clone()は
   * 元のOCCT形状を指すJSラッパーを新規生成するだけ、makeCompound()も各サブシェイプをそのまま
   * Addするだけのため、ここで集めるfaceIdは最終的なcompound[=shape]上のfaceIdと一致する)。
   */
  bodyGroups: BodyGroup[];
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
 * resolveFaceGeometry()の1ボディ分の判定ロジックを、失敗時にエラーを投げず null を返す形に
 * したもの(Phase 27a、複数ボディ横断マッチング用)。一致すればdist(hashCode一致は0、
 * フォールバックは中心距離)付きで返す。
 */
function matchFaceInBody(
  body: Shape3D,
  faceId: number,
  savedCenter: Tuple3,
  savedNormal: Tuple3,
): { center: Tuple3; normal: Tuple3; dist: number } | null {
  const faces = body.faces;
  try {
    const byId = faces.find((f) => f.hashCode === faceId);
    if (byId) {
      const info = faceCenterNormal(byId);
      return { center: info.center, normal: info.normal, dist: 0 };
    }

    const bbox = body.boundingBox;
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
      if (!best || dist < best.dist) best = { center: info.center, normal: info.normal, dist };
    }
    return best;
  } finally {
    faces.forEach((f) => f.delete());
  }
}

/**
 * bodies(複数ボディ、Phase 27a)を横断して、選択時点のfaceId/center/normalに最もよく一致する
 * 面を持つボディを特定する(ねじの配置面用。matchFaceInBody()を各ボディに適用し、一致した中で
 * distが最小[hashCode一致は0扱い]のボディを採用する)。どのボディでも一致しなければエラーを投げる。
 */
function resolveFaceGeometryAcrossBodies(
  bodies: Map<FeatureId, Shape3D>,
  faceId: number,
  savedCenter: Tuple3,
  savedNormal: Tuple3,
): { bodyId: FeatureId; center: Tuple3; normal: Tuple3 } {
  let best: { bodyId: FeatureId; center: Tuple3; normal: Tuple3; dist: number } | null = null;
  for (const [bodyId, body] of bodies) {
    const matched = matchFaceInBody(body, faceId, savedCenter, savedNormal);
    if (!matched) continue;
    if (!best || matched.dist < best.dist) {
      best = { bodyId, center: matched.center, normal: matched.normal, dist: matched.dist };
    }
  }
  if (!best) {
    throw new Error("面を特定できませんでした。面を選択し直してください");
  }
  return best;
}

/**
 * 1ボディ分のfillet3dエッジマッチング(Phase 27a: 複数ボディ横断マッチング用に、resolveFilletEdges
 * 相当のロジックを「失敗時はnullを返す(エラーを投げない)」形にしたもの)。
 * 1. 第一候補: edge.hashCode(選択時点のedgeId)が完全一致する、未使用のエッジ(距離0扱い)。
 * 2. フォールバック: 中点距離が最も近く(バウンディングボックス対角長の
 *    EDGE_DISTANCE_TOLERANCE_RATIO以内)、始点→終点方向がほぼ一致(cos>EDGE_DIRECTION_COS_TOLERANCE、
 *    符号は無視)する、未使用のエッジ。
 * 3. targetsのいずれか1つでもこのボディ内で解決できなければnullを返す(その際allEdgesは
 *    この関数内でdelete()まで済ませる。呼び出し側で二重解放しないこと)。
 *
 * 戻り値のmatched(targetsと同じ順序・長さ)とallEdges(bodyの全エッジ)は同じEdgeインスタンスを
 * 共有する(matchedはallEdgesの部分集合の参照)。成功時、allEdgesのdelete()責務は呼び出し側。
 * totalDistはマッチ全体の距離合計(hashCode一致は0)で、複数ボディ間の「最良マッチ」判定に使う。
 */
function matchFilletEdgesInBody(
  body: Shape3D,
  targets: FilletEdgeRef[],
): { matched: Edge[]; allEdges: Edge[]; totalDist: number } | null {
  const allEdges = body.edges;
  const used = new Set<number>();

  const bbox = body.boundingBox;
  const diag = Math.sqrt(bbox.width ** 2 + bbox.height ** 2 + bbox.depth ** 2);
  bbox.delete();
  const maxDist = diag * EDGE_DISTANCE_TOLERANCE_RATIO;

  const matched: Edge[] = [];
  let totalDist = 0;
  for (const target of targets) {
    let matchIndex = -1;
    let matchDist = 0;

    for (let i = 0; i < allEdges.length; i += 1) {
      if (used.has(i)) continue;
      if (allEdges[i].hashCode === target.edgeId) {
        matchIndex = i;
        matchDist = 0;
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
      matchDist = bestDist;
    }

    if (matchIndex === -1) {
      allEdges.forEach((e) => e.delete());
      return null;
    }
    used.add(matchIndex);
    matched.push(allEdges[matchIndex]);
    totalDist += matchDist;
  }

  return { matched, allEdges, totalDist };
}

/**
 * bodies(複数ボディ、Phase 27a)を横断してfillet3dの対象エッジを解決し、最良マッチ(全targetsが
 * 解決でき、totalDistが最小)のボディを特定する。どのボディでも全targetsが解決できなければ
 * エラーを投げる(既存のfeatureId付きエラー経路に乗る)。
 */
function resolveFilletEdgesAcrossBodies(
  bodies: Map<FeatureId, Shape3D>,
  targets: FilletEdgeRef[],
): { bodyId: FeatureId; matched: Edge[]; allEdges: Edge[] } {
  let best: { bodyId: FeatureId; matched: Edge[]; allEdges: Edge[]; totalDist: number } | null = null;
  for (const [bodyId, body] of bodies) {
    const result = matchFilletEdgesInBody(body, targets);
    if (!result) continue;
    if (!best || result.totalDist < best.totalDist) {
      if (best) best.allEdges.forEach((e) => e.delete());
      best = { bodyId, matched: result.matched, allEdges: result.allEdges, totalDist: result.totalDist };
    } else {
      result.allEdges.forEach((e) => e.delete());
    }
  }
  if (!best) {
    throw new Error("フィレット/面取りの対象エッジを特定できませんでした。フィーチャーを作り直してください");
  }
  return best;
}

/**
 * fillet3dフィーチャーを、全ボディ横断のエッジマッチング(resolveFilletEdgesAcrossBodies())で
 * 特定した最良マッチのボディに適用する(Phase 27a。bodiesマップを直接書き換える)。
 * replicadの Shape3D#fillet()/#chamfer() は第2引数に「EdgeFinderを受け取り、絞り込んだ
 * EdgeFinderを返す関数」を渡すことで対象エッジを絞り込める。ここでは EdgeFinder#inList()
 * (「渡したEdge配列とisSame()なエッジのみを残す」フィルタ)に幾何マッチングしたエッジを
 * そのまま渡す。半径過大等でOCCTが構築に失敗した場合はfillet()/chamfer()がそのままErrorをthrowし、
 * 呼び出し元のevaluateDocument()のtry/catchでfeatureId付きエラーに変換される。
 */
function applyFillet3DToBodies(bodies: Map<FeatureId, Shape3D>, feature: Fillet3DFeature): void {
  const { bodyId, matched, allEdges } = resolveFilletEdgesAcrossBodies(bodies, feature.edges);
  const body = bodies.get(bodyId) as Shape3D;
  try {
    const newBody =
      feature.kind === "fillet"
        ? body.fillet(feature.size, (finder) => finder.inList(matched))
        : body.chamfer(feature.size, (finder) => finder.inList(matched));
    body.delete();
    bodies.set(bodyId, newBody);
  } finally {
    allEdges.forEach((e) => e.delete());
  }
}

/**
 * 1ボディ分のshell対象面マッチング(Phase 27a: 複数ボディ横断マッチング用に、matchFilletEdgesInBody()と
 * 同じ方針[resolveFaceGeometry()の「面ID一致優先→平面かつ法線一致+中心最近傍」判定を、複数面かつ
 * 同一面の重複マッチ不可という条件に拡張]で、失敗時はnullを返す形にしたもの)。
 * 1. 第一候補: face.hashCode(選択時点のfaceId)が完全一致する、未使用の面(距離0扱い)。
 * 2. フォールバック: 平面(isPlanar)かつ法線がほぼ一致(cos>FACE_NORMAL_COS_TOLERANCE)し、
 *    中心距離が最も近い(バウンディングボックス対角長のFACE_DISTANCE_TOLERANCE_RATIO以内)、未使用の面。
 * 3. targetsのいずれか1つでもこのボディ内で解決できなければnullを返す(allFacesはこの関数内で
 *    delete()まで済ませる)。
 *
 * 戻り値のmatched(targetsと同じ順序・長さ)とallFaces(bodyの全面)は同じFaceインスタンスを共有する。
 * 成功時、allFacesのdelete()責務は呼び出し側。totalDistは複数ボディ間の「最良マッチ」判定に使う。
 */
function matchShellFacesInBody(
  body: Shape3D,
  targets: ShellFaceRef[],
): { matched: Face[]; allFaces: Face[]; totalDist: number } | null {
  const allFaces = body.faces;
  const used = new Set<number>();

  const bbox = body.boundingBox;
  const diag = Math.sqrt(bbox.width ** 2 + bbox.height ** 2 + bbox.depth ** 2);
  bbox.delete();
  const maxDist = diag * FACE_DISTANCE_TOLERANCE_RATIO;

  const matched: Face[] = [];
  let totalDist = 0;
  for (const target of targets) {
    let matchIndex = -1;
    let matchDist = 0;

    for (let i = 0; i < allFaces.length; i += 1) {
      if (used.has(i)) continue;
      if (allFaces[i].hashCode === target.faceId) {
        matchIndex = i;
        matchDist = 0;
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
      matchDist = bestDist;
    }

    if (matchIndex === -1) {
      allFaces.forEach((f) => f.delete());
      return null;
    }
    used.add(matchIndex);
    matched.push(allFaces[matchIndex]);
    totalDist += matchDist;
  }

  return { matched, allFaces, totalDist };
}

/**
 * bodies(複数ボディ、Phase 27a)を横断してshellの対象面を解決し、最良マッチ(全targetsが解決でき、
 * totalDistが最小)のボディを特定する。どのボディでも全targetsが解決できなければエラーを投げる。
 */
function resolveShellFacesAcrossBodies(
  bodies: Map<FeatureId, Shape3D>,
  targets: ShellFaceRef[],
): { bodyId: FeatureId; matched: Face[]; allFaces: Face[] } {
  let best: { bodyId: FeatureId; matched: Face[]; allFaces: Face[]; totalDist: number } | null = null;
  for (const [bodyId, body] of bodies) {
    const result = matchShellFacesInBody(body, targets);
    if (!result) continue;
    if (!best || result.totalDist < best.totalDist) {
      if (best) best.allFaces.forEach((f) => f.delete());
      best = { bodyId, matched: result.matched, allFaces: result.allFaces, totalDist: result.totalDist };
    } else {
      result.allFaces.forEach((f) => f.delete());
    }
  }
  if (!best) {
    throw new Error("シェルの対象面を特定できませんでした。フィーチャーを作り直してください");
  }
  return best;
}

/**
 * shellフィーチャーを、全ボディ横断の面マッチング(resolveShellFacesAcrossBodies())で特定した
 * 最良マッチのボディに適用する(Phase 27a。bodiesマップを直接書き換える)。
 * replicadの Shape3D#shell(thickness, finderFcn) は第2引数に「FaceFinderを受け取り、絞り込んだ
 * FaceFinderを返す関数」を渡すことで開口する面を絞り込める。ここではFaceFinder#inList()
 * (「渡したFace配列とisSame()な面のみを残す」フィルタ)に幾何マッチングした面をそのまま渡す。
 * thicknessは正の値で、node_modules/replicad/dist/replicad.jsのshell()実装が内部で-thicknessを
 * BRepOffsetAPI_MakeThickSolidへ渡すため、選択面を取り除いた残りの面から内側へthickness(mm)の
 * 肉厚を残す(ボディの外形寸法は変わらない)規約になっている。過大な厚み等でOCCTが構築に失敗した
 * 場合はshell()がそのままErrorをthrowし、呼び出し元のevaluateDocument()のtry/catchでfeatureId付き
 * エラーに変換される。
 */
function applyShell3DToBodies(bodies: Map<FeatureId, Shape3D>, feature: ShellFeature): void {
  const { bodyId, matched, allFaces } = resolveShellFacesAcrossBodies(bodies, feature.faces);
  const body = bodies.get(bodyId) as Shape3D;
  try {
    const newBody = body.shell(feature.thickness, (finder) => finder.inList(matched));
    body.delete();
    bodies.set(bodyId, newBody);
  } finally {
    allFaces.forEach((f) => f.delete());
  }
}

/**
 * ISO並目ねじの外ねじ実効かみ合い深さ係数(h3 ≈ 0.61343*pitch)。理論山高さ(0.866*pitch、鋭いV形状)
 * ではなくISO 68-1の外ねじ実用値に近い、より浅い値を使う(Phase 25c)。事前スパイクで理論山高さの
 * 鋭いV形状を使うと、ヘリカル形状の構築(後述のbuildMaleThreadSolidLocal)が自己交差ぎみになり
 * 体積計算・ブーリアン演算が不安定になる(バウンディングボックスが理論値の2倍以上に膨らむ、
 * 体積が負値になる等)ことが判明したため、浅い実用値を採用した。
 */
const THREAD_ENGAGEMENT_FACTOR = 0.61343;

/**
 * 雄ねじの実ねじ山リブを離散断面のloft(輪列、replicadのloft()=BRepOffsetAPI_ThruSections)で
 * 近似する際の、ねじ山1回転あたりの断面数(Phase 25c)。
 *
 * 事前スパイクの結論は「sketchHelix()でヘリックスを作りSketch#sweepSketch()でスパインに沿って
 * 三角プロファイルを掃引する」方式だったが、実装検証の結果、このプロジェクトが使用する
 * replicad/OpenCascade WASMの組み合わせでは実際の掃引結果(sweepSketch内部でtwistExtrude()を
 * 使う経路も含む)が幾何的に破綻する(バウンディングボックスが理論値の2倍以上に膨らむ、
 * 体積が負値になる等。半径・ピッチの値に関わらず再現)ことが確認されたため、この実装では
 * 採用していない。代わりに、三角プロファイル(底辺=ピッチ、根本=谷径、先端=呼び径)を
 * 少しずつ回転・上昇させた断面群を作り、loft(ruled: true)で結んでリブ形状を作る方式にした。
 * 16は実装検証で「10以下では隣接断面の間隔が広すぎてリブが自己交差し、体積が負値・過小値になる」
 * ことを確認した上での安全側の値(16回転で常に正しい形状[外形半径どおりのbounding box、
 * 体積が円柱単体より大きい]になることを確認済み)。
 */
const THREAD_SECTIONS_PER_TURN = 16;

/**
 * 雄ねじの実ねじ山ソリッドを、ローカル座標系(原点=ねじ開始点、+Z=ねじが伸びる方向、
 * 谷径の円柱がz=0〜lengthに乗る)で構築する(Phase 25c)。呼び出し側でワールド座標
 * (配置面の位置・法線)へtranslate/rotate()して配置する。
 * 実測(M6×5mm、16断面/回転): loft構築が数百ms、rod.fuse()がoptimisation:"sameFace"で
 * 十数秒程度(ねじが長い=断面数が多いほど比例して増える。MALE_THREAD_MAX_LENGTHで上限を設けている)。
 */
function buildMaleThreadSolidLocal(preset: ThreadFeature["preset"], length: number): Shape3D {
  const { nominal, pitch } = THREAD_PRESET_TABLE[preset];
  const majorRadius = nominal / 2;
  const threadHeight = THREAD_ENGAGEMENT_FACTOR * pitch;
  const minorRadius = majorRadius - threadHeight;

  const rod = makeCylinder(minorRadius, length, [0, 0, 0], [0, 0, 1]);

  const nTurns = length / pitch;
  const totalSections = Math.max(2, Math.round(THREAD_SECTIONS_PER_TURN * nTurns) + 1);
  const wires: Wire[] = [];
  for (let i = 0; i < totalSections; i += 1) {
    const frac = i / (totalSections - 1);
    const z = frac * length;
    const angleDeg = frac * nTurns * 360;
    const plane = new Plane([0, 0, z], [1, 0, 0], [0, 0, 1]);
    // 単一の閉ループ(コンパウンドではない)の.sketchOnPlane(Plane)は常に具象のSketchを返すため、
    // .wire(具象クラスのみが持つプロパティ、SketchInterfaceには無い)を使うためにキャストする。
    const sketch = draw([minorRadius, -pitch / 2])
      .lineTo([majorRadius, 0])
      .lineTo([minorRadius, pitch / 2])
      .close()
      .rotate(angleDeg, [0, 0])
      .sketchOnPlane(plane) as Sketch;
    wires.push(sketch.wire.clone());
    sketch.delete();
    plane.delete();
  }

  let threadRidge: Shape3D;
  try {
    threadRidge = loft(wires, { ruled: true });
  } finally {
    wires.forEach((w) => w.delete());
  }

  try {
    const fused = rod.fuse(threadRidge, { optimisation: "sameFace" });
    return fused;
  } finally {
    rod.delete();
    threadRidge.delete();
  }
}

/**
 * ローカル座標系(原点=配置基準点、+Z=軸方向)で構築した回転体(円柱・ねじ山ソリッド等)を、
 * ワールド座標(position/axisDir)へ配置する(Phase 25c)。+Zをaxisdir(単位ベクトル)へ向ける
 * 回転(axis-angle、cross(+Z, axisDir)を回転軸に取る。ほぼ平行/反平行の場合はそれぞれ
 * 無回転/垂直な軸まわり180度回転にフォールバックする)を行った後、positionへ平行移動する。
 * shapeはこの関数内でconsumeされる(rotate/translateはreplicadのShape3D APIどおり、
 * 呼び出し側のshapeをdelete()して新しいインスタンスを返す)。
 */
function orientLocalSolidToWorld(shape: Shape3D, position: Tuple3, axisDir: Tuple3): Shape3D {
  const dir = normalize(axisDir);
  const zAxis: Tuple3 = [0, 0, 1];
  const cosAngle = dot(zAxis, dir);
  let result = shape;
  if (cosAngle < 1 - 1e-9) {
    if (cosAngle < -1 + 1e-9) {
      // ほぼ真逆(-Z)。回転軸の向きが定まらないため、Z軸に垂直な任意軸(+X)まわりに180度回転する。
      result = result.rotate(180, [0, 0, 0], [1, 0, 0]);
    } else {
      const axis = cross(zAxis, dir);
      const angleDeg = (Math.acos(Math.min(1, Math.max(-1, cosAngle))) * 180) / Math.PI;
      result = result.rotate(angleDeg, [0, 0, 0], axis);
    }
  }
  return result.translate(position);
}

/**
 * ねじフィーチャーを、全ボディ横断の面マッチング(resolveFaceGeometryAcrossBodies())で特定した
 * 最良マッチのボディに適用する(Phase 25c、Phase 27aで複数ボディ対応に変更。bodiesマップを
 * 直接書き換える)。配置面はShellFeatureと同様、featureId参照ではなく直前までの各ボディに対して
 * 幾何マッチングして解決する。
 * 雄(hand:"male")は呼び径の谷径円柱+実ねじ山リブ(buildMaleThreadSolidLocal)をfuseで追加する。
 * 雌(hand:"female")は規格の下穴径(呼び径−ピッチ)の円柱をcutする簡易表現にとどめる(v1では
 * 雌ねじの実ねじ山cutは評価時間が実用的でなくなることがスパイクで判明したため、下穴のみ)。
 */
function applyThreadToBodies(bodies: Map<FeatureId, Shape3D>, feature: ThreadFeature): void {
  const resolved = resolveFaceGeometryAcrossBodies(bodies, feature.face.faceId, feature.face.center, feature.face.normal);
  const basis = computeFacePlaneBasis(resolved.center, resolved.normal);
  const [u, v] = feature.position;
  const position: Tuple3 = [
    basis.origin[0] + u * basis.xDir[0] + v * basis.yDir[0],
    basis.origin[1] + u * basis.xDir[1] + v * basis.yDir[1],
    basis.origin[2] + u * basis.xDir[2] + v * basis.yDir[2],
  ];
  const axisDir: Tuple3 = [
    resolved.normal[0] * feature.direction,
    resolved.normal[1] * feature.direction,
    resolved.normal[2] * feature.direction,
  ];
  const body = bodies.get(resolved.bodyId) as Shape3D;

  if (feature.hand === "male") {
    if (feature.length > MALE_THREAD_MAX_LENGTH) {
      throw new Error(`雄ねじの長さは${MALE_THREAD_MAX_LENGTH}mm以下である必要があります`);
    }
    const localSolid = buildMaleThreadSolidLocal(feature.preset, feature.length);
    const worldSolid = orientLocalSolidToWorld(localSolid, position, axisDir);
    try {
      const newBody = body.fuse(worldSolid);
      body.delete();
      bodies.set(resolved.bodyId, newBody);
    } finally {
      worldSolid.delete();
    }
    return;
  }

  // hand === "female": 下穴径の円柱をcutする簡易表現(実ねじ山は作らない)。
  const drillRadius = threadDrillDiameter(feature.preset) / 2;
  const localHole = makeCylinder(drillRadius, feature.length, [0, 0, 0], [0, 0, 1]);
  const worldHole = orientLocalSolidToWorld(localHole, position, axisDir);
  try {
    const newBody = body.cut(worldHole);
    body.delete();
    bodies.set(resolved.bodyId, newBody);
  } finally {
    worldHole.delete();
  }
}

/**
 * 部品配置(簡易アセンブリ、Phase 27b)フィーチャーの評価キャッシュの上限件数(LRU)。
 * 部品にねじ等の重いフィーチャーが含まれる場合、毎回の再評価(数秒〜十数秒)を避けるため、
 * 部品docのJSON文字列をキーに「変換(rotate/translate)前」の評価済みcompoundをWorkerメモリに
 * 保持する(位置・回転の変更だけでは部品の再評価を伴わない)。キャッシュ本体は取り出し時に
 * clone()してから返し、delete()しない(他のpartInstanceフィーチャーが同じキーを再利用できるように
 * 保つ。buildBodiesCompound()と同じ「clone()して渡す、原本は生かしたまま」の方針)。上限を超えたら
 * 最も古く使われたエントリを1件delete()して破棄する(単純なLRU。Mapは同一キーへのset()で
 * 挿入順が末尾に更新される性質を使い、挿入順=最終アクセス順とみなす)。
 */
const PART_CACHE_MAX_SIZE = 5;
const partShapeCache = new Map<string, Shape3D>();

/**
 * partInstanceフィーチャーの埋め込みdoc(feature.part)を評価し、変換(rotate/translate)前の
 * compoundを返す(呼び出し側が所有する、都度clone()されたインスタンス。呼び出し側でdelete()すること)。
 * 同一内容(JSON文字列が一致)の部品docはWorkerメモリ内でキャッシュされ、2回目以降は
 * evaluateDocument()を再実行しない(キャッシュヒット時はclone()のみで済む)。
 * 部品側の評価が失敗した場合・部品にボディが1つも無い場合は、呼び出し元
 * (evaluateDocument()のtry/catch)がfeatureId付きエラーに変換できる通常のErrorをthrowする。
 */
function evaluatePartDocumentCached(part: CadDocument, partName: string): Shape3D {
  const key = JSON.stringify(part);
  const cached = partShapeCache.get(key);
  if (cached) {
    // LRU: 再利用したキーをMapの末尾へ移動する(delete()してからset()し直すと挿入順が更新される)。
    partShapeCache.delete(key);
    partShapeCache.set(key, cached);
    return cached.clone();
  }

  // ネスト禁止の防御的チェック(v1ではUI・model/validation.tsの両方で弾いている想定だが、
  // 手編集/旧バージョンのプロジェクトファイルを直接開いた場合に備え、evaluator側でも明確な
  // エラーにする。この時点で弾いておけば、直後のevaluateDocument(part)呼び出しがpartInstanceの
  // 評価に再突入することはなく、実際の再帰は発生しない)。
  if (part.features.some((f) => f.type === "partInstance")) {
    throw new Error(`部品『${partName}』の評価に失敗: 部品内に入れ子の部品配置が含まれています`);
  }

  const result = evaluateDocument(part);
  if (!result.ok) {
    throw new Error(`部品『${partName}』の評価に失敗: ${result.message}`);
  }
  if (!result.shape) {
    throw new Error(`部品『${partName}』の評価に失敗: 部品にボディがありません`);
  }

  partShapeCache.set(key, result.shape);
  if (partShapeCache.size > PART_CACHE_MAX_SIZE) {
    const oldestKey = partShapeCache.keys().next().value;
    if (oldestKey !== undefined) {
      partShapeCache.get(oldestKey)?.delete();
      partShapeCache.delete(oldestKey);
    }
  }
  return result.shape.clone();
}

/**
 * 部品配置(簡易アセンブリ、Phase 27b)フィーチャーを評価し、bodiesマップに新規ボディとして
 * 追加する(常に「このpartInstance自身が作った1つの新規ボディ」。newBodyフィーチャーと同じ扱いで、
 * 以降のextrude/revolveのtargetBodyIdで参照できる)。
 * 変換はrotation(X軸→Y軸→Z軸の順、いずれも部品ローカル原点[0,0,0]周り)→position(平行移動)の順に
 * 適用する。replicadのShape3D#rotate()/#translate()はいずれも呼び出し元のシェイプをdelete()して
 * 新しいインスタンスを返す(node_modules/replicad/dist/replicad.jsのShape.rotate/translate実装、
 * このファイルのorientLocalSolidToWorld()と同じパターン)。
 */
function applyPartInstanceToBodies(bodies: Map<FeatureId, Shape3D>, feature: PartInstanceFeature): void {
  let shape = evaluatePartDocumentCached(feature.part, feature.name);
  const [rx, ry, rz] = feature.rotation;
  if (rx !== 0) shape = shape.rotate(rx, [0, 0, 0], [1, 0, 0]);
  if (ry !== 0) shape = shape.rotate(ry, [0, 0, 0], [0, 1, 0]);
  if (rz !== 0) shape = shape.rotate(rz, [0, 0, 0], [0, 0, 1]);
  shape = shape.translate(feature.position);
  bodies.set(feature.id, shape);
}

/**
 * 面の中心・法線から、決定的なxDirを持つスケッチ平面(Plane)を構築する。
 * 呼び出し側で使用後に plane.delete() すること。xDirの決定則はsrc/sketch/facePlaneBasis.tsの
 * facePlaneRawXDir()(ビューア側の面クリック点ローカル2D化と共通)。
 */
function buildFacePlane(center: Tuple3, normal: Tuple3): Plane {
  return new Plane(center, facePlaneRawXDir(normal), normal);
}

/**
 * buildFacePlane()が構築するreplicad Planeと同一の基底を、プレーンなタプルとして計算する
 * (sketchPlanes応答用。Plane自身はOCCTオブジェクトを保持するため使い回さない)。
 * 実体はsrc/sketch/facePlaneBasis.tsのcomputeFacePlaneBasis()(ビューア側と共通の純粋関数)。
 */
function facePlaneBasis(center: Tuple3, normal: Tuple3): PlaneBasis {
  return computeFacePlaneBasis(center, normal);
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
 * bodiesマップの全ボディを1つのcompoundにまとめる(Phase 27a)。各ボディをclone()してから
 * replicadのmakeCompound()に渡す(makeCompound()は渡した配列の各要素をdelete()して消費するため、
 * bodiesマップ自体が保持する生存中のシェイプはこの関数呼び出し後も無傷のまま)。戻り値のdelete()の
 * 責務は呼び出し側。単一ボディのみでも常にcompoundにラップする(呼び出し側の分岐を単純にするため。
 * Compoundは他のShape3D同様mesh/faces/edges/boundingBox/blobSTL/blobSTEP等をサポートするため実害は無い)。
 */
function buildBodiesCompound(bodies: Map<FeatureId, Shape3D>): Shape3D {
  const clones = Array.from(bodies.values(), (b) => b.clone());
  return makeCompound(clones) as Shape3D;
}

/**
 * bodiesマップの中で最後に作られたボディ(newBodyフィーチャーの評価順で最後)のfeatureIdを返す
 * (Phase 27a、targetBodyId省略時の既定対象)。JSのMapはキーの挿入順を保持し、既存キーへの
 * set()は順序を変えない(新しいキーのみ末尾に追加される)ため、bodies.keys()の最後の要素が
 * 「最後に作られたボディ」と一致する(その後cut/add/fillet等で中身が更新されていても、キー自体は
 * 動かないため常に正しい)。bodiesが空ならundefined。
 */
function lastBodyId(bodies: Map<FeatureId, Shape3D>): FeatureId | undefined {
  let last: FeatureId | undefined;
  for (const id of bodies.keys()) last = id;
  return last;
}

/**
 * extrude/revolve共通の「ボディへの適用(newBody/cut/add)」分岐(Phase 25b、Phase 27aで複数ボディ
 * 対応に変更)。bodiesマップを直接書き換える: newBodyはfeatureIdをキーに新しいボディを追加する
 * (既存ボディがあってもエラーにしない=単一ボディ制限は撤廃)。cut/addはtargetBodyId
 * (省略時はlastBodyId()=最後に作られたボディ)が指すボディのみを書き換える。buildToolは
 * 実際にDrawingから立体を組み立てるクロージャ(extrudeSketchFeature()/revolveSketchFeature()を渡す)で、
 * newBody以外の場合にのみ呼ばれる。
 */
function applyBodyOperation(
  bodies: Map<FeatureId, Shape3D>,
  featureId: FeatureId,
  operation: "newBody" | "cut" | "add",
  targetBodyId: FeatureId | undefined,
  buildTool: () => Shape3D,
): void {
  if (operation === "newBody") {
    bodies.set(featureId, buildTool());
    return;
  }

  const resolvedTargetId = targetBodyId ?? lastBodyId(bodies);
  if (resolvedTargetId === undefined) {
    throw new Error(operation === "cut" ? "カット対象のボディがありません" : "追加対象のボディがありません");
  }
  const target = bodies.get(resolvedTargetId);
  if (!target) {
    throw new Error(`対象ボディ(${resolvedTargetId})が見つかりません`);
  }

  const tool = buildTool();
  let result: Shape3D;
  try {
    result = operation === "cut" ? target.cut(tool) : target.fuse(tool);
  } finally {
    tool.delete();
  }
  target.delete();
  bodies.set(resolvedTargetId, result);
}

/**
 * evaluateFeatures()の成功時の戻り値(Phase 28b切り出し)。bodiesマップは生きたまま返す
 * (呼び出し側がdelete()する責務を持つ。evaluateDocument()は最終compound化後に、
 * checkInterference()はペア間の交差計算に使ってから、それぞれ個別にdelete()する)。
 * sketches/resolvedFacePlanes/referenceEdgesByIdはevaluateDocument()がsketchPlanes/referenceEdges
 * 応答を組み立てるために必要な中間結果で、checkInterference()側では使わない。
 */
interface FeatureEvalSuccess {
  ok: true;
  bodies: Map<FeatureId, Shape3D>;
  sketches: Map<FeatureId, SketchFeature>;
  resolvedFacePlanes: Map<FeatureId, { center: Tuple3; normal: Tuple3 }>;
  referenceEdgesById: Map<FeatureId, ReferenceEdgeLine[]>;
}

type FeatureEvalResult = FeatureEvalSuccess | EvaluationFailure;

/**
 * doc.featuresを先頭から逐次評価し、bodiesマップ(+付随する中間結果)を組み立てるコア処理
 * (Phase 28b、evaluateDocument()とcheckInterference()の共通部分として切り出した)。
 * 失敗時は featureId(特定できれば) 付きのエラーを返す。
 * 成功時に返るbodiesマップの各Shape3Dの解放は呼び出し側の責務。失敗時は内部で生成した
 * 中間形状(bodies・snapshots)をすべてこの関数内で解放する。
 */
function evaluateFeatures(doc: CadDocument): FeatureEvalResult {
  const sketches = new Map<FeatureId, SketchFeature>();
  // face参照スケッチの解決済み平面情報(sketchId -> center/normal)。sketch評価時に確定する。
  const resolvedFacePlanes = new Map<FeatureId, { center: Tuple3; normal: Tuple3 }>();
  // 各スケッチの解決済みワールド基底(sketchId -> basis、Phase 25b)。回転体フィーチャーが
  // 回転軸(スケッチローカルX/Y)のワールド方向・原点を求めるために使う。
  const sketchBasisById = new Map<FeatureId, PlaneBasis>();
  // 各フィーチャー(ボディを作る/変更するもの)評価直後の「全ボディのcompound」スナップショット
  // (featureId -> クローンベースのcompound、Phase 27a)。後続のface参照スケッチが面を再解決する
  // ために使う。buildBodiesCompound()はbodiesマップの各シェイプをclone()してから合成するため、
  // live側のbodiesを delete() してもスナップショット側は無効化されない(逆も同様)。
  // 評価終了時(成功/失敗いずれでも)にすべて delete() する。
  const snapshots = new Map<FeatureId, Shape3D>();
  // 各スケッチが評価された時点の「現在の全ボディ」から抽出したスケッチ平面上の直線エッジ(Phase 22)。
  // その時点でボディが1つも存在しない(押し出し/回転体がまだ無い)スケッチはエントリを作らない。
  const referenceEdgesById = new Map<FeatureId, ReferenceEdgeLine[]>();
  // 複数ボディ管理(Phase 27a): キー=そのボディを作ったnewBodyフィーチャーのid。
  // 単一の`body`変数を廃止し、常にこのMap経由でボディを読み書きする。
  const bodies = new Map<FeatureId, Shape3D>();
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
        if (bodies.size > 0) {
          const combined = buildBodiesCompound(bodies);
          try {
            referenceEdgesById.set(feature.id, extractReferenceEdges(combined, basis));
          } finally {
            combined.delete();
          }
        }
        validateSketchPolygonCorners(feature);
        sketches.set(feature.id, feature);
        continue;
      }

      if (feature.type === "fillet3d") {
        if (bodies.size === 0) {
          throw new Error("フィレット/面取りの対象となるボディがありません");
        }
        applyFillet3DToBodies(bodies, feature);
        snapshots.set(feature.id, buildBodiesCompound(bodies));
        continue;
      }

      if (feature.type === "shell") {
        if (bodies.size === 0) {
          throw new Error("シェルの対象となるボディがありません");
        }
        applyShell3DToBodies(bodies, feature);
        snapshots.set(feature.id, buildBodiesCompound(bodies));
        continue;
      }

      if (feature.type === "thread") {
        if (bodies.size === 0) {
          throw new Error("ねじの対象となるボディがありません");
        }
        applyThreadToBodies(bodies, feature);
        snapshots.set(feature.id, buildBodiesCompound(bodies));
        continue;
      }

      if (feature.type === "partInstance") {
        applyPartInstanceToBodies(bodies, feature);
        snapshots.set(feature.id, buildBodiesCompound(bodies));
        continue;
      }

      if (feature.type === "revolve") {
        const sketch = sketches.get(feature.sketchId);
        if (!sketch) {
          throw new Error(`参照先のスケッチ(${feature.sketchId})が見つかりません`);
        }
        applyBodyOperation(bodies, feature.id, feature.operation, feature.targetBodyId, () =>
          revolveSketchFeature(sketch, feature.axis, feature.angle, resolvedFacePlanes, sketchBasisById),
        );
        snapshots.set(feature.id, buildBodiesCompound(bodies));
        continue;
      }

      // feature.type === "extrude"
      const sketch = sketches.get(feature.sketchId);
      if (!sketch) {
        throw new Error(`参照先のスケッチ(${feature.sketchId})が見つかりません`);
      }
      applyBodyOperation(bodies, feature.id, feature.operation, feature.targetBodyId, () =>
        extrudeSketchFeature(sketch, feature.distance, feature.direction, resolvedFacePlanes),
      );
      snapshots.set(feature.id, buildBodiesCompound(bodies));
    }
  } catch (err) {
    for (const b of bodies.values()) b.delete();
    for (const snap of snapshots.values()) snap.delete();
    return {
      ok: false,
      featureId: currentFeatureId,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  for (const snap of snapshots.values()) snap.delete();

  // ここに到達した時点でループは最後まで例外なく完走しているため、sketchesに登録された
  // 全スケッチ(world/faceいずれも)の平面基底が解決済みである。bodies(bodies.size===0は
  // newBodyフィーチャーが1つも無い、空ドキュメント/スケッチのみの正常なケース。Phase 13)は
  // 生きたまま返す(delete()は呼び出し側の責務)。
  return { ok: true, bodies, sketches, resolvedFacePlanes, referenceEdgesById };
}

/**
 * ドキュメントを評価してひとつのAnyShapeを返す。
 * 失敗時は featureId(特定できれば) 付きのエラーを返す。
 * 成功時に返るshapeの解放は呼び出し側の責務。失敗時は内部で生成した中間形状をすべて解放する。
 */
export function evaluateDocument(doc: CadDocument): EvaluationResult {
  const result = evaluateFeatures(doc);
  if (!result.ok) return result;
  const { bodies, sketches, resolvedFacePlanes, referenceEdgesById } = result;

  // 各ボディの面ID集合(Phase 28a)を、compound化してbodiesをdelete()する前に集めておく。
  const bodyGroups: BodyGroup[] = [];
  for (const [featureId, body] of bodies) {
    const faces = body.faces;
    bodyGroups.push({ featureId, faceIds: faces.map((f) => f.hashCode) });
    faces.forEach((f) => f.delete());
  }

  // 最終結果は全ボディのcompound(単一ボディでも常にcompoundにラップする、Phase 27a)。
  // buildBodiesCompound()はクローンを合成するため、その後にbodies自体は個別にdelete()する。
  const shape = bodies.size > 0 ? buildBodiesCompound(bodies) : null;
  for (const b of bodies.values()) b.delete();

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

  return { ok: true, shape, sketchPlanes, referenceEdges, bodyGroups };
}

/**
 * 干渉チェック(Phase 28b)で、交差体積がこの値(mm³)を超えるペアのみ「干渉あり」として報告する。
 * 浮動小数点誤差・ちょうど接する(タンジェント)ボディ同士の名目上ほぼゼロの交差を誤検出しないための閾値。
 */
const INTERFERENCE_VOLUME_THRESHOLD = 1e-6;

/** 干渉ペア1件(交差ソリッドつき、Phase 28b)。shapeはメッシュ化後、呼び出し側(Worker)がdelete()する責務を持つ。 */
export interface InterferencePairShape {
  aFeatureId: FeatureId;
  aName: string;
  bFeatureId: FeatureId;
  bName: string;
  volume: number;
  shape: Shape3D;
}

export interface InterferenceCheckSuccess {
  ok: true;
  pairs: InterferencePairShape[];
}

export type InterferenceCheckResult = InterferenceCheckSuccess | EvaluationFailure;

/**
 * 全ボディ(部品配置[partInstance]による追加ボディも含む)をペアごとに交差(replicadの
 * Shape3D#intersect()、BRepAlgoAPI_Common)し、交差体積がINTERFERENCE_VOLUME_THRESHOLDを超える
 * ペアを干渉として報告する(Phase 28b)。ボディが1個以下の場合は空配列を返す(エラーではない)。
 * オンデマンド実行専用(呼び出し側のUIが明示的に要求したときのみ呼ぶ想定。ドキュメント評価の
 * たびに自動実行すると重くなるため)。
 *
 * ボディの名前は、そのボディを作ったフィーチャー(newBody操作のextrude/revolve、または
 * partInstance)のnameフィールドをdoc.featuresから引く(bodiesマップのキー=そのフィーチャーのid、
 * evaluateFeatures()冒頭のコメント参照)。
 *
 * 交差(intersect())が何らかの理由で失敗した場合(OCCTが空/縮退した交差からShape3Dを構築できない
 * 等)は、そのペアは「干渉なし」として扱う(評価全体を失敗させない。ボディが完全に離れている場合は
 * 通常は空のCompoundが返るため到達しないはずだが、念のため防御的に扱う)。
 *
 * 戻り値の各ペアのshapeは呼び出し側(Worker)がメッシュ化後にdelete()する責務を持つ。
 */
export function checkInterference(doc: CadDocument): InterferenceCheckResult {
  const result = evaluateFeatures(doc);
  if (!result.ok) return result;
  const { bodies } = result;

  if (bodies.size < 2) {
    for (const b of bodies.values()) b.delete();
    return { ok: true, pairs: [] };
  }

  const nameOf = (id: FeatureId): string => doc.features.find((f) => f.id === id)?.name ?? id;
  const ids = Array.from(bodies.keys());
  const pairs: InterferencePairShape[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const aId = ids[i];
      const bId = ids[j];
      const a = bodies.get(aId) as Shape3D;
      const b = bodies.get(bId) as Shape3D;
      let intersection: Shape3D | null = null;
      try {
        intersection = a.intersect(b);
      } catch {
        intersection = null;
      }
      if (!intersection) continue;
      const volume = measureVolume(intersection);
      if (volume > INTERFERENCE_VOLUME_THRESHOLD) {
        pairs.push({ aFeatureId: aId, aName: nameOf(aId), bFeatureId: bId, bName: nameOf(bId), volume, shape: intersection });
      } else {
        intersection.delete();
      }
    }
  }

  for (const b of bodies.values()) b.delete();
  return { ok: true, pairs };
}
