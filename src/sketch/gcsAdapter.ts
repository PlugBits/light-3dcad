// PlaneGCS(FreeCADのSketcherが使う2D幾何拘束ソルバのWASM移植、LGPL-2.1-or-later、
// @salusoft89/planegcs)アダプタ(Phase 35b-1)。src/sketch/solver.ts の solveSketch() から
// 常に呼ばれる(Phase 35cで自前実装のLevenberg-Marquardt法[旧ソルバ]のフォールバックを撤去し、
// 拘束solveはこのファイルのみが担う)。
//
// このファイルもsolver.ts同様、ReactにもThree.jsにもReplicad(OCCT)にも依存しない純粋TS方針
// だが、PlaneGCSのWASMモジュールという重い依存を持つため、実際のロードは遅延させる
// (initGcs()を呼ぶまでWASMは読み込まれない。src/sketch/solver.tsのensureGcsInitialized()が
// アプリ起動時に一度だけ呼び、完了前のsolveSketch()呼び出しはそのPromiseの完了を待つ
// [solveDocumentSketchesAsync()参照]、または同期呼び出し元では例外になる)。
//
// 変数モデルは旧ソルバ(solver.ts)と同一にする(既存モデルと差分最小、スパイクPhase 35aの結論):
// - 全セグメントの両端点(p1・p2)を独立したGCS点として持つ(coincident拘束は端点マージせず
//   p2p_coincidentで結ぶ)。
// - 可動エンティティ(circle/rectangle/regularPolygon/polygon/slot)は「代表点」1つ(2変数)を持つ。
//   circle/rectangle/regularPolygonは中心そのもの、polygon/slotは剛体並進オフセット(0,0始点)。
// - rectangle/polygonの辺(entityEdge)がdistanceEntityLine/distancePointLineから参照されている
//   場合のみ、4隅(またはpolygonの全頂点)を代表点からの固定オフセット(difference拘束)で
//   剛体的に連結した補助点・辺を追加で作る。
//
// GCS呼び出しは1個のGcsWrapperを使い回し、solveSketch()呼び出しのたびに clear_data() して
// 全primitiveを再構築する(スパイクの計測で複合ケースでも1ms未満、毎フレームのドラッグでも
// 十分高速なことを確認済み。sketch_param経由の差分更新は複雑さに見合わないため採用しない)。
import { Algorithm, GcsWrapper, make_gcs_wrapper, type SketchPrimitive } from "@salusoft89/planegcs";
import type { EntityRef, LineRef, PointRef, SketchConstraint, SketchEntity, SketchSegment } from "../model/types";
import { constraintFullLabel } from "./constraintLabels";
import { rectangleEdgePointsAtCenter, resolveLineRefPoints } from "./entityEdges";
import type { DragTarget, Point2, SolveOptions, SolveResult } from "./solver";

/** solver.tsのROUND_GRIDと同じ意図(丸め誤差の累積ドリフト対策)。値も同じにして挙動を揃える。 */
const ROUND_GRID = 1e-6;
/** solver.tsのEARLY_RETURN_TOLERANCEと同じ意図・同じ値(既に満たされているなら入力をそのまま返す)。 */
const EARLY_RETURN_TOLERANCE = 1e-7;
/** ドラッグ中(temporary拘束あり)の緩和後の最大反復回数(スパイクの06-drag-tuning.mjsで確認)。 */
const DRAG_MAX_ITERATIONS = 1000;

type MovableEntity = Extract<SketchEntity, { kind: "circle" | "rectangle" | "polygon" | "regularPolygon" | "slot" }>;

function isMovableEntity(entity: SketchEntity): entity is MovableEntity {
  return (
    entity.kind === "circle" ||
    entity.kind === "rectangle" ||
    entity.kind === "polygon" ||
    entity.kind === "regularPolygon" ||
    entity.kind === "slot"
  );
}

// ------- id命名規則(GCSのidは全primitive[点・線・拘束]を通じてユニークな文字列) -------
const pointId = (segmentId: string, end: "p1" | "p2") => `SP:${segmentId}:${end}`;
const chordLineId = (segmentId: string) => `SL:${segmentId}`;
const repPointId = (entityId: string) => `EP:${entityId}`;
const cornerPointId = (entityId: string, i: number) => `EC:${entityId}:${i}`;
const edgeLineId = (entityId: string, edgeIndex: number) => `EE:${entityId}:${edgeIndex}`;
const originPointId = (constraintId: string) => `OR:${constraintId}`;
const refPointId = (constraintId: string, which: "p1" | "p2") => `RF:${constraintId}:${which}`;
const refLineId = (constraintId: string) => `RL:${constraintId}`;
const gcsConstraintId = (constraintId: string, part = 0) => `K:${constraintId}#${part}`;
/** gcsConstraintId()で作ったidから元のSketchConstraint.idを復元する(矛盾メッセージ用)。 */
function originalConstraintId(gcsId: string): string | null {
  if (!gcsId.startsWith("K:")) return null;
  const withoutPrefix = gcsId.slice(2);
  const hashIdx = withoutPrefix.lastIndexOf("#");
  return hashIdx >= 0 ? withoutPrefix.slice(0, hashIdx) : withoutPrefix;
}

// ------- 遅延初期化 -------
let wrapper: GcsWrapper | null = null;
let wrapperReady = false;
let initPromise: Promise<void> | null = null;
let defaultMaxIterations = 32;
let wasmPathOverride: string | null = null;

/** Vitest(Node環境)向け: `?url`インポートに頼らず絶対パスを直接注入する(テストのbeforeAllで呼ぶ)。 */
export function setGcsWasmPathForTests(path: string): void {
  wasmPathOverride = path;
}

/** GCSソルバの初期化(WASMロード)が完了しているかどうか。 */
export function isGcsReady(): boolean {
  return wrapperReady;
}

/**
 * GCSソルバの初期化を開始する(アプリ起動時に1回呼ぶ想定、src/sketch/solver.tsの
 * ensureGcsInitialized()から)。複数回呼んでも初回のPromiseを使い回す。完了前に
 * solveSketch()系が呼ばれた場合、呼び出し元(src/state/store.tsのupdateDocument()等)は
 * solveDocumentSketchesAsync()経由でこの完了を待つ(Phase 35c、旧ソルバのフォールバックは撤去済み)。
 */
export function initGcs(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    let path = wasmPathOverride;
    if (!path) {
      // Vite: ?urlで別アセット化(replicad-opencascadejsと同型、src/worker/cad.worker.ts参照)。
      // このimport自体は動的import(初期化を呼ぶまでチャンクをロードしない)。
      const mod = await import("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url");
      path = mod.default;
    }
    const w = await make_gcs_wrapper(path);
    defaultMaxIterations = w.get_max_iterations();
    wrapper = w;
    wrapperReady = true;
  })();
  return initPromise;
}

// ------- primitive/constraint組み立て -------

/** ctx.pointsは常に"point"種別のprimitiveのみを持つ(GcsWrapperの構造上の要請、pointFromWarm()参照)。 */
interface GcsPointPrim {
  id: string;
  type: "point";
  x: number;
  y: number;
  fixed: boolean;
}

interface BuildContext {
  segments: readonly SketchSegment[];
  segmentsById: Map<string, SketchSegment>;
  entities: readonly SketchEntity[];
  entitiesById: Map<string, SketchEntity>;
  movableEntities: MovableEntity[];
  points: Map<string, GcsPointPrim>;
  lines: Map<string, SketchPrimitive>;
  constraints: SketchPrimitive[];
}

function addPoint(ctx: BuildContext, id: string, x: number, y: number, fixed: boolean) {
  if (ctx.points.has(id)) return;
  ctx.points.set(id, { id, type: "point", x, y, fixed });
}

function addLine(ctx: BuildContext, id: string, p1: string, p2: string) {
  if (ctx.lines.has(id)) return;
  ctx.lines.set(id, { id, type: "line", p1_id: p1, p2_id: p2 });
}

/** entity(可動)の「代表点」の初期座標(circle/rectangle/regularPolygonは中心、polygon/slotは並進オフセット0,0)。 */
function repInit(entity: MovableEntity): Point2 {
  return entity.kind === "circle" || entity.kind === "rectangle" || entity.kind === "regularPolygon" ? entity.center : [0, 0];
}

/** entity(可動)の「代表点」の現在座標(拘束構築時点の符号決定に使う。repInitと同じ値)。 */
function currentRep(entity: SketchEntity): Point2 {
  if (!isMovableEntity(entity)) return [0, 0];
  return repInit(entity);
}

function currentPoint(segmentsById: Map<string, SketchSegment>, ref: PointRef): Point2 {
  const seg = segmentsById.get(ref.segmentId);
  if (!seg) return [0, 0];
  return ref.end === "p1" ? seg.p1 : seg.p2;
}

/**
 * rectangle/polygonの補助頂点・辺(entityEdgeライン参照解決用)を必要なentityId分だけ作る。
 * 代表点からの固定オフセットをdifference拘束(param2-param1=difference)で連結することで、
 * 代表点が動けば補助頂点・辺も追従する剛体並進を実現する(スパイクレポートの表の通り)。
 */
function ensureEntityEdges(ctx: BuildContext, entityId: string) {
  const entity = ctx.entitiesById.get(entityId);
  if (!entity) return;
  const rep = repPointId(entityId);
  if (entity.kind === "rectangle") {
    if (ctx.lines.has(edgeLineId(entityId, 0))) return;
    const corners: Point2[] = [0, 1, 2, 3].map((i) => rectangleEdgePointsAtCenter(entity.center, entity.width, entity.height, i)[0]);
    const [cx, cy] = entity.center;
    corners.forEach((corner, i) => {
      addPoint(ctx, cornerPointId(entityId, i), corner[0], corner[1], false);
      pushDifference(ctx, `${entityId}#cx${i}`, rep, "x", cornerPointId(entityId, i), "x", corner[0] - cx);
      pushDifference(ctx, `${entityId}#cy${i}`, rep, "y", cornerPointId(entityId, i), "y", corner[1] - cy);
    });
    for (let i = 0; i < 4; i += 1) {
      addLine(ctx, edgeLineId(entityId, i), cornerPointId(entityId, i), cornerPointId(entityId, (i + 1) % 4));
    }
  } else if (entity.kind === "polygon") {
    const n = entity.points.length;
    if (n === 0 || ctx.lines.has(edgeLineId(entityId, 0))) return;
    entity.points.forEach((pt, i) => {
      addPoint(ctx, cornerPointId(entityId, i), pt[0], pt[1], false);
      pushDifference(ctx, `${entityId}#cx${i}`, rep, "x", cornerPointId(entityId, i), "x", pt[0]);
      pushDifference(ctx, `${entityId}#cy${i}`, rep, "y", cornerPointId(entityId, i), "y", pt[1]);
    });
    for (let i = 0; i < n; i += 1) {
      addLine(ctx, edgeLineId(entityId, i), cornerPointId(entityId, i), cornerPointId(entityId, (i + 1) % n));
    }
  }
}

/**
 * difference拘束を1件積む。PlaneGCSの実際の意味は `param2 - param1 = difference` である
 * (フィールド名の直感[param1-param2]とは逆順、node上の実機確認[スパイク]で判明した仕様)。
 * よって「a[axis] - b[axis] = value」を表したいときは a=param1側 / b=param2側 として呼ぶ。
 */
function pushDifference(
  ctx: BuildContext,
  idSuffix: string,
  aPointId: string,
  aProp: "x" | "y",
  bPointId: string,
  bProp: "x" | "y",
  value: number,
) {
  ctx.constraints.push({
    id: gcsConstraintId(`aux:${idSuffix}`),
    type: "difference",
    param1: { o_id: aPointId, prop: aProp },
    param2: { o_id: bPointId, prop: bProp },
    difference: value,
  } as SketchPrimitive);
}

/**
 * 直線距離(p2p_distance、非0値)拘束を追加する直前に呼ぶ: 対象2点の初期座標が一致していると
 * (例: 追加直後の円は既定で原点[0,0]、追加直後は距離拘束の対象がまだ動いていない等)、Euclid距離の
 * 勾配が原点で不定形(0/0)になり、LM・DogLegどちらも解を進められず「距離0→非0への到達不能」という
 * 偽の矛盾になることを実機確認した(distanceEntityOrigin/distancePointOrigin/distanceEntityEntity/
 * distanceのdirect[非axis]モード全てで起こりうる。ドラッグ編集の一時拘束で見つかった同種の特異点
 * [addDragConstraintsのコメント参照]と同じ根本原因)。value=0(=一致させたい)のときはこの特異点が
 * そもそも正解[残差0]なので対象外。可動点(fixedでない方)の初期x座標をごくわずか(1e-3mm)ずらして
 * 特異点から逃がすことで回避する(可視の形状には影響しない微小値。両方fixedなら動かせないため何もしない
 * [別途fixEntity同士の矛盾として検出される])。
 */
const DEGENERATE_DISTANCE_NUDGE = 1e-3;
function nudgeIfCoincidentForDirectDistance(ctx: BuildContext, idA: string, idB: string, value: number) {
  if (value === 0) return;
  const a = ctx.points.get(idA);
  const b = ctx.points.get(idB);
  if (!a || !b) return;
  if (Math.hypot(a.x - b.x, a.y - b.y) > 1e-9) return;
  if (!b.fixed) {
    b.x += DEGENERATE_DISTANCE_NUDGE;
  } else if (!a.fixed) {
    a.x += DEGENERATE_DISTANCE_NUDGE;
  }
}

/** LineRefを解決してGCSの"line"primitive idを返す(必要なら補助点・辺・固定スナップショット線を作る)。 */
function resolveLineToGcsLineId(ctx: BuildContext, constraintId: string, line: LineRef): string | null {
  if (line.kind === "segmentEdge") {
    const seg = ctx.segmentsById.get(line.segmentId);
    return seg ? chordLineId(line.segmentId) : null;
  }
  if (line.kind === "entityEdge") {
    ensureEntityEdges(ctx, line.entityId);
    const id = edgeLineId(line.entityId, line.edgeIndex);
    return ctx.lines.has(id) ? id : null;
  }
  // refEdge: ピック時点のスナップショット座標を持つ固定点2つ+線分を、この拘束専用に作る。
  const p1Id = refPointId(constraintId, "p1");
  const p2Id = refPointId(constraintId, "p2");
  const lId = refLineId(constraintId);
  if (!ctx.lines.has(lId)) {
    addPoint(ctx, p1Id, line.p1[0], line.p1[1], true);
    addPoint(ctx, p2Id, line.p2[0], line.p2[1], true);
    addLine(ctx, lId, p1Id, p2Id);
  }
  return lId;
}

function entityRepId(ref: EntityRef): string {
  return repPointId(ref.entityId);
}

function pointRefId(ref: PointRef): string {
  return pointId(ref.segmentId, ref.end);
}

/** distance/distanceEntityEntity/distancePointOriginのaxis指定(signed省略時)の符号を、現在の座標から決める。 */
function signOf(delta: number): 1 | -1 {
  return delta >= 0 ? 1 : -1;
}

/**
 * 劣拘束(自由度が余る)方向の解を「入力形状に最も近い解」に誘導する正則化のスケール
 * (旧ソルバのREGULARIZATION_WEIGHTと同じ役割)。solveSketchGcs()のウォームアップ段階でのみ
 * 全ての可動点(セグメント端点・エンティティ代表点、fixedを除く)へ「現在位置に留まりたい」
 * 弱いcoordinate_x/coordinate_y拘束(低scale)として追加する。実際の拘束(scale省略=1)より
 * 十分弱いため、拘束を満たす解が複数ある場合にのみ効き、拘束が一意に解を決める場合は
 * 実質的に無視される。ただし単独のウォームアップ解だけだと正則化ぶんの系統的なズレ(バイアス)が
 * 拘束の残差にわずかに残るため、solveSketchGcs()はウォームアップの解を初期値として正則化なしの
 * 「仕上げ」solveをもう一度行う(旧ソルバのattemptSolve()と同じ2段階方式)。
 */
const REGULARIZATION_SCALE = 1e-2;

function buildContext(
  segments: readonly SketchSegment[],
  constraints: readonly SketchConstraint[],
  entities: readonly SketchEntity[],
  regularize = false,
): BuildContext {
  const segmentsById = new Map(segments.map((s) => [s.id, s]));
  const entitiesById = new Map(entities.map((e) => [e.id, e]));
  const movableEntities = entities.filter(isMovableEntity);

  const ctx: BuildContext = {
    segments,
    segmentsById,
    entities,
    entitiesById,
    movableEntities,
    points: new Map(),
    lines: new Map(),
    constraints: [],
  };

  const fixedPointIds = new Set<string>();
  const fixedEntityIds = new Set<string>();
  for (const c of constraints) {
    if (c.kind === "fix") fixedPointIds.add(pointRefId(c.point));
    if (c.kind === "fixEntity") fixedEntityIds.add(c.entity.entityId);
  }

  const addRegularizer = (pointGcsId: string, value: Point2) => {
    if (!regularize) return;
    ctx.constraints.push({
      id: gcsConstraintId(`reg:${pointGcsId}`, 0),
      type: "coordinate_x",
      p_id: pointGcsId,
      x: value[0],
      scale: REGULARIZATION_SCALE,
    } as SketchPrimitive);
    ctx.constraints.push({
      id: gcsConstraintId(`reg:${pointGcsId}`, 1),
      type: "coordinate_y",
      p_id: pointGcsId,
      y: value[1],
      scale: REGULARIZATION_SCALE,
    } as SketchPrimitive);
  };

  for (const seg of segments) {
    const p1Fixed = fixedPointIds.has(pointId(seg.id, "p1"));
    const p2Fixed = fixedPointIds.has(pointId(seg.id, "p2"));
    addPoint(ctx, pointId(seg.id, "p1"), seg.p1[0], seg.p1[1], p1Fixed);
    addPoint(ctx, pointId(seg.id, "p2"), seg.p2[0], seg.p2[1], p2Fixed);
    addLine(ctx, chordLineId(seg.id), pointId(seg.id, "p1"), pointId(seg.id, "p2"));
    if (!p1Fixed) addRegularizer(pointId(seg.id, "p1"), seg.p1);
    if (!p2Fixed) addRegularizer(pointId(seg.id, "p2"), seg.p2);
  }

  for (const e of movableEntities) {
    const init = repInit(e);
    const fixed = fixedEntityIds.has(e.id);
    addPoint(ctx, repPointId(e.id), init[0], init[1], fixed);
    if (!fixed) addRegularizer(repPointId(e.id), init);
  }

  // entityEdgeを参照する拘束を先にスキャンして必要な補助点・辺を用意する(constraint本体の
  // 変換ループの中でも都度ensureEntityEdges()を呼ぶので、ここでの事前スキャンは無くても
  // 動作上は問題ないが、参照順に依存しないことを明確にするため先にやっておく)。
  for (const c of constraints) {
    if (c.kind === "distanceEntityLine" || c.kind === "distancePointLine") {
      if (c.line.kind === "entityEdge") ensureEntityEdges(ctx, c.line.entityId);
    }
  }

  for (const c of constraints) addConstraint(ctx, c);

  return ctx;
}

function addConstraint(ctx: BuildContext, c: SketchConstraint) {
  switch (c.kind) {
    case "coincident": {
      const a = ctx.segmentsById.get(c.a.segmentId);
      const b = ctx.segmentsById.get(c.b.segmentId);
      if (!a || !b) return;
      ctx.constraints.push({ id: gcsConstraintId(c.id), type: "p2p_coincident", p1_id: pointRefId(c.a), p2_id: pointRefId(c.b) });
      break;
    }
    case "horizontal": {
      if (!ctx.segmentsById.has(c.segmentId)) return;
      ctx.constraints.push({ id: gcsConstraintId(c.id), type: "horizontal_l", l_id: chordLineId(c.segmentId) });
      break;
    }
    case "vertical": {
      if (!ctx.segmentsById.has(c.segmentId)) return;
      ctx.constraints.push({ id: gcsConstraintId(c.id), type: "vertical_l", l_id: chordLineId(c.segmentId) });
      break;
    }
    case "length": {
      if (!ctx.segmentsById.has(c.segmentId)) return;
      ctx.constraints.push({
        id: gcsConstraintId(c.id),
        type: "p2p_distance",
        p1_id: pointId(c.segmentId, "p1"),
        p2_id: pointId(c.segmentId, "p2"),
        distance: c.value,
      });
      break;
    }
    case "distance": {
      const a = ctx.segmentsById.get(c.a.segmentId);
      const b = ctx.segmentsById.get(c.b.segmentId);
      if (!a || !b) return;
      if (c.axis === "x" || c.axis === "y") {
        const axisIdx = c.axis === "x" ? 0 : 1;
        const prop = c.axis;
        const cur = currentPoint(ctx.segmentsById, c.b)[axisIdx] - currentPoint(ctx.segmentsById, c.a)[axisIdx];
        const target = c.signed === true ? c.value : signOf(cur) * c.value;
        pushDifference(ctx, c.id, pointRefId(c.a), prop, pointRefId(c.b), prop, target);
      } else {
        nudgeIfCoincidentForDirectDistance(ctx, pointRefId(c.a), pointRefId(c.b), c.value);
        ctx.constraints.push({
          id: gcsConstraintId(c.id),
          type: "p2p_distance",
          p1_id: pointRefId(c.a),
          p2_id: pointRefId(c.b),
          distance: c.value,
        });
      }
      break;
    }
    case "radius": {
      const segment = ctx.segmentsById.get(c.segmentId);
      if (!segment || segment.kind !== "arc" || !segment.bulge) return;
      const theta = 4 * Math.atan(segment.bulge);
      const chord = 2 * c.value * Math.abs(Math.sin(theta / 2));
      ctx.constraints.push({
        id: gcsConstraintId(c.id),
        type: "p2p_distance",
        p1_id: pointId(c.segmentId, "p1"),
        p2_id: pointId(c.segmentId, "p2"),
        distance: chord,
      });
      break;
    }
    case "fix":
    case "fixEntity": {
      // 値を持たない: 該当点をfixed:trueで作ることで表現済み(buildContext参照)。
      break;
    }
    case "distanceEntityOrigin": {
      if (!ctx.entitiesById.has(c.entity.entityId)) return;
      const origin = c.originLocal ?? [0, 0];
      const oid = originPointId(c.id);
      addPoint(ctx, oid, origin[0], origin[1], true);
      if (c.axis === "x" || c.axis === "y") {
        const axisIdx = c.axis === "x" ? 0 : 1;
        const prop = c.axis;
        const cur = currentRep(ctx.entitiesById.get(c.entity.entityId)!)[axisIdx] - origin[axisIdx];
        const target = c.signed === true ? c.value : signOf(cur) * c.value;
        pushDifference(ctx, c.id, oid, prop, entityRepId(c.entity), prop, target);
      } else {
        nudgeIfCoincidentForDirectDistance(ctx, entityRepId(c.entity), oid, c.value);
        ctx.constraints.push({ id: gcsConstraintId(c.id), type: "p2p_distance", p1_id: entityRepId(c.entity), p2_id: oid, distance: c.value });
      }
      break;
    }
    case "distancePointOrigin": {
      if (!ctx.segmentsById.has(c.point.segmentId)) return;
      const origin = c.originLocal ?? [0, 0];
      const oid = originPointId(c.id);
      addPoint(ctx, oid, origin[0], origin[1], true);
      if (c.axis === "x" || c.axis === "y") {
        const axisIdx = c.axis === "x" ? 0 : 1;
        const prop = c.axis;
        const cur = currentPoint(ctx.segmentsById, c.point)[axisIdx] - origin[axisIdx];
        const target = c.signed === true ? c.value : signOf(cur) * c.value;
        pushDifference(ctx, c.id, oid, prop, pointRefId(c.point), prop, target);
      } else {
        nudgeIfCoincidentForDirectDistance(ctx, pointRefId(c.point), oid, c.value);
        ctx.constraints.push({ id: gcsConstraintId(c.id), type: "p2p_distance", p1_id: pointRefId(c.point), p2_id: oid, distance: c.value });
      }
      break;
    }
    case "coincidentOrigin": {
      const origin = c.originLocal ?? [0, 0];
      const oid = originPointId(c.id);
      addPoint(ctx, oid, origin[0], origin[1], true);
      const targetId = "segmentId" in c.point ? pointRefId(c.point) : entityRepId(c.point);
      if ("segmentId" in c.point ? !ctx.segmentsById.has(c.point.segmentId) : !ctx.entitiesById.has(c.point.entityId)) return;
      ctx.constraints.push({ id: gcsConstraintId(c.id), type: "p2p_coincident", p1_id: targetId, p2_id: oid });
      break;
    }
    case "distanceEntityEntity": {
      if (!ctx.entitiesById.has(c.a.entityId) || !ctx.entitiesById.has(c.b.entityId)) return;
      if (c.axis === "x" || c.axis === "y") {
        const axisIdx = c.axis === "x" ? 0 : 1;
        const prop = c.axis;
        const entityA = ctx.entitiesById.get(c.a.entityId);
        const entityB = ctx.entitiesById.get(c.b.entityId);
        const cur = (entityB ? currentRep(entityB)[axisIdx] : 0) - (entityA ? currentRep(entityA)[axisIdx] : 0);
        const target = c.signed === true ? c.value : signOf(cur) * c.value;
        pushDifference(ctx, c.id, entityRepId(c.a), prop, entityRepId(c.b), prop, target);
      } else {
        nudgeIfCoincidentForDirectDistance(ctx, entityRepId(c.a), entityRepId(c.b), c.value);
        ctx.constraints.push({
          id: gcsConstraintId(c.id),
          type: "p2p_distance",
          p1_id: entityRepId(c.a),
          p2_id: entityRepId(c.b),
          distance: c.value,
        });
      }
      break;
    }
    case "distanceEntityLine": {
      if (!ctx.entitiesById.has(c.entity.entityId)) return;
      const lineId = resolveLineToGcsLineId(ctx, c.id, c.line);
      if (!lineId) return;
      ctx.constraints.push({ id: gcsConstraintId(c.id), type: "p2l_distance", p_id: entityRepId(c.entity), l_id: lineId, distance: c.value });
      break;
    }
    case "distancePointLine": {
      if (!ctx.segmentsById.has(c.point.segmentId)) return;
      const lineId = resolveLineToGcsLineId(ctx, c.id, c.line);
      if (!lineId) return;
      ctx.constraints.push({ id: gcsConstraintId(c.id), type: "p2l_distance", p_id: pointRefId(c.point), l_id: lineId, distance: c.value });
      break;
    }
    case "perpendicular": {
      if (!ctx.segmentsById.has(c.a) || !ctx.segmentsById.has(c.b)) return;
      ctx.constraints.push({ id: gcsConstraintId(c.id), type: "perpendicular_ll", l1_id: chordLineId(c.a), l2_id: chordLineId(c.b) });
      break;
    }
    case "concentric": {
      if (!ctx.entitiesById.has(c.a.entityId) || !ctx.entitiesById.has(c.b.entityId)) return;
      ctx.constraints.push({ id: gcsConstraintId(c.id), type: "p2p_coincident", p1_id: entityRepId(c.a), p2_id: entityRepId(c.b) });
      break;
    }
    case "tangent": {
      const entity = ctx.entitiesById.get(c.entity.entityId);
      if (!entity || entity.kind !== "circle") return;
      if (c.target.kind === "segment") {
        if (!ctx.segmentsById.has(c.target.segmentId)) return;
        // 円の中心↔直線の垂直距離=半径。p2l_distanceは初期位置側を保つ(不符号だが側を維持する、
        // node実機確認済み)ため、旧ソルバのtarget.side(符号の永続化)は不要になる。
        ctx.constraints.push({
          id: gcsConstraintId(c.id),
          type: "p2l_distance",
          p_id: entityRepId(c.entity),
          l_id: chordLineId(c.target.segmentId),
          distance: entity.radius,
        });
      } else {
        const other = ctx.entitiesById.get(c.target.entityId);
        if (!other || other.kind !== "circle") return;
        const value = c.target.mode === "internal" ? Math.abs(entity.radius - other.radius) : entity.radius + other.radius;
        ctx.constraints.push({
          id: gcsConstraintId(c.id),
          type: "p2p_distance",
          p1_id: entityRepId(c.entity),
          p2_id: entityRepId({ entityId: c.target.entityId }),
          distance: value,
        });
      }
      break;
    }
    case "distanceLineLine": {
      if (!ctx.segmentsById.has(c.a) || !ctx.segmentsById.has(c.b)) return;
      ctx.constraints.push({ id: gcsConstraintId(c.id, 0), type: "parallel", l1_id: chordLineId(c.a), l2_id: chordLineId(c.b) });
      ctx.constraints.push({
        id: gcsConstraintId(c.id, 1),
        type: "p2l_distance",
        p_id: pointId(c.a, "p1"),
        l_id: chordLineId(c.b),
        distance: c.value,
      });
      break;
    }
    case "angleLineLine": {
      if (!ctx.segmentsById.has(c.a) || !ctx.segmentsById.has(c.b)) return;
      ctx.constraints.push({
        id: gcsConstraintId(c.id),
        type: "l2l_angle_ll",
        l1_id: chordLineId(c.a),
        l2_id: chordLineId(c.b),
        angle: (c.value * Math.PI) / 180,
      });
      break;
    }
    case "distanceLineRefEdge": {
      if (!ctx.segmentsById.has(c.segmentId)) return;
      const lineId = resolveLineToGcsLineId(ctx, c.id, c.line);
      if (!lineId) return;
      ctx.constraints.push({ id: gcsConstraintId(c.id, 0), type: "parallel", l1_id: chordLineId(c.segmentId), l2_id: lineId });
      ctx.constraints.push({
        id: gcsConstraintId(c.id, 1),
        type: "p2l_distance",
        p_id: pointId(c.segmentId, "p1"),
        l_id: lineId,
        distance: c.value,
      });
      break;
    }
    case "angleLineRefEdge": {
      if (!ctx.segmentsById.has(c.segmentId)) return;
      const lineId = resolveLineToGcsLineId(ctx, c.id, c.line);
      if (!lineId) return;
      ctx.constraints.push({
        id: gcsConstraintId(c.id),
        type: "l2l_angle_ll",
        l1_id: chordLineId(c.segmentId),
        l2_id: lineId,
        angle: (c.value * Math.PI) / 180,
      });
      break;
    }
  }
}

function roundToGrid(v: number): number {
  return Math.round(v / ROUND_GRID) * ROUND_GRID;
}

function readPoint(w: GcsWrapper, id: string): Point2 {
  const p = w.sketch_index.get_sketch_point(id);
  return [roundToGrid(p.x), roundToGrid(p.y)];
}

/**
 * 直近のsolve()+apply_solution()後、ctxが持つ全点(補助点=rectangle/polygonの隅・原点・参照エッジの
 * スナップショット点も含む)の座標をGCSから読み出す(丸めなし、生値)。
 * 2段階solve(warmup→finishing)の「ウォームアップの結果を次のsolveの初期値にする」ために使う
 * (overrideInitCoords()と対で使う)。SketchSegment/SketchEntityへ一度変換してから作り直すと、
 * rectangle/polygonの補助点のオフセット計算基準[代表点=0や中心]が「今の絶対座標」に化けてしまい、
 * 2回目のsolveで代表点の意味(基準からの並進量)がウォームアップ時とズレて収束を乱すことが
 * 実機確認で分かったため、GCSの生の点idベースでそのまま引き継ぐ)。
 */
function readAllPointCoords(w: GcsWrapper, ctx: BuildContext): Map<string, Point2> {
  const result = new Map<string, Point2>();
  for (const id of ctx.points.keys()) {
    const p = w.sketch_index.get_sketch_point(id);
    result.set(id, [p.x, p.y]);
  }
  return result;
}

/** readAllPointCoords()で読んだ座標を、同じ構造(同じ点id集合)を持つ新しいctxの初期値として書き戻す。 */
function overrideInitCoords(ctx: BuildContext, coords: Map<string, Point2>) {
  for (const [id, prim] of ctx.points) {
    const c = coords.get(id);
    if (!c) continue;
    ctx.points.set(id, { ...prim, x: c[0], y: c[1] });
  }
}

function segmentsFromGcs(w: GcsWrapper, segments: readonly SketchSegment[]): SketchSegment[] {
  return segments.map((seg) => ({ ...seg, p1: readPoint(w, pointId(seg.id, "p1")), p2: readPoint(w, pointId(seg.id, "p2")) }));
}

function entitiesFromGcs(w: GcsWrapper, entities: readonly SketchEntity[]): SketchEntity[] {
  return entities.map((entity) => {
    if (isMovableEntity(entity)) {
      const [rx, ry] = readPoint(w, repPointId(entity.id));
      if (entity.kind === "circle" || entity.kind === "rectangle" || entity.kind === "regularPolygon") {
        return { ...entity, center: [rx, ry] as Point2 };
      }
      if (rx !== 0 || ry !== 0) {
        if (entity.kind === "polygon") {
          return { ...entity, points: entity.points.map((p) => [p[0] + rx, p[1] + ry] as Point2) };
        }
        return {
          ...entity,
          start: [entity.start[0] + rx, entity.start[1] + ry] as Point2,
          end: [entity.end[0] + rx, entity.end[1] + ry] as Point2,
        };
      }
    }
    return { ...entity };
  });
}

/** 入力(cloneした状態)と解いた結果の最大移動量(mm)を計算する(累積ドリフト対策の早期リターン判定用)。 */
function maxCoordDelta(
  origSegments: readonly SketchSegment[],
  newSegments: readonly SketchSegment[],
  origEntities: readonly SketchEntity[],
  newEntities: readonly SketchEntity[],
): number {
  let m = 0;
  for (let i = 0; i < origSegments.length; i += 1) {
    const a = origSegments[i];
    const b = newSegments[i];
    m = Math.max(m, Math.abs(a.p1[0] - b.p1[0]), Math.abs(a.p1[1] - b.p1[1]), Math.abs(a.p2[0] - b.p2[0]), Math.abs(a.p2[1] - b.p2[1]));
  }
  for (let i = 0; i < origEntities.length; i += 1) {
    const a = origEntities[i];
    const b = newEntities[i];
    if (a.kind === "circle" && b.kind === "circle") {
      m = Math.max(m, Math.abs(a.center[0] - b.center[0]), Math.abs(a.center[1] - b.center[1]));
    } else if (a.kind === "rectangle" && b.kind === "rectangle") {
      m = Math.max(m, Math.abs(a.center[0] - b.center[0]), Math.abs(a.center[1] - b.center[1]));
    } else if (a.kind === "regularPolygon" && b.kind === "regularPolygon") {
      m = Math.max(m, Math.abs(a.center[0] - b.center[0]), Math.abs(a.center[1] - b.center[1]));
    } else if (a.kind === "polygon" && b.kind === "polygon") {
      for (let j = 0; j < a.points.length; j += 1) {
        m = Math.max(m, Math.abs(a.points[j][0] - b.points[j][0]), Math.abs(a.points[j][1] - b.points[j][1]));
      }
    } else if (a.kind === "slot" && b.kind === "slot") {
      m = Math.max(
        m,
        Math.abs(a.start[0] - b.start[0]),
        Math.abs(a.start[1] - b.start[1]),
        Math.abs(a.end[0] - b.end[0]),
        Math.abs(a.end[1] - b.end[1]),
      );
    }
  }
  return m;
}

/**
 * ドラッグ目標(Phase 34)に応じたtemporary coordinate_x/coordinate_y拘束を積む。
 * 当初はtemporary p2p_distance(対象点↔ダミーの目標点)=0で実装していたが、Phase 35b-2の実機調査で
 * 「本体ドラッグ(kind:"segment"、両端点を同時に引く)+lengthのような別のp2p_distance系拘束が
 * 同時に存在する」組み合わせでPlaneGCSのDogLeg(temporary拘束経由でSQPに切り替わる)がNaNを返す
 * バグを発見した(delta=0[目標=現在位置]でも再現するため、反復途中の収束ではなく初期のヤコビアン
 * 評価自体が原因: p2p_distanceの残差はEuclid距離のsqrtで、目標点=対象点[距離0]のときの勾配が
 * (p-target)/0という不定形になる。この特異点由来と見られる不具合が、同種のp2p_distance拘束
 * [lengthなど]と組み合わさったときにSQPの内部で表面化する)。coordinate_x/coordinate_yは対象点の
 * 片方の成分を直接目標値に等置する線形な拘束で、そのような特異性が原理的に存在しないため、
 * これに置き換えて回避する(実機確認: 同じシナリオでNaNが解消し、旧実装と同じ「カーソル位置へ
 * ソフトに引く」挙動を維持できることを確認済み)。
 */
function addDragConstraints(ctx: BuildContext, dragTarget: DragTarget) {
  const delta: Point2 = [dragTarget.target[0] - dragTarget.grabPoint[0], dragTarget.target[1] - dragTarget.grabPoint[1]];
  const pull = (pointGcsId: string, desired: Point2) => {
    ctx.constraints.push({
      id: gcsConstraintId(`drag:${pointGcsId}`, 0),
      type: "coordinate_x",
      p_id: pointGcsId,
      x: desired[0],
      temporary: true,
    });
    ctx.constraints.push({
      id: gcsConstraintId(`drag:${pointGcsId}`, 1),
      type: "coordinate_y",
      p_id: pointGcsId,
      y: desired[1],
      temporary: true,
    });
  };

  if (dragTarget.kind === "point") {
    const cur = currentPoint(ctx.segmentsById, dragTarget.point);
    pull(pointRefId(dragTarget.point), [cur[0] + delta[0], cur[1] + delta[1]]);
  } else if (dragTarget.kind === "segment") {
    const seg = ctx.segmentsById.get(dragTarget.segmentId);
    if (!seg) return;
    pull(pointId(dragTarget.segmentId, "p1"), [seg.p1[0] + delta[0], seg.p1[1] + delta[1]]);
    pull(pointId(dragTarget.segmentId, "p2"), [seg.p2[0] + delta[0], seg.p2[1] + delta[1]]);
  } else {
    const entity = ctx.entitiesById.get(dragTarget.entityId);
    if (!entity) return;
    const cur = currentRep(entity);
    pull(repPointId(dragTarget.entityId), [cur[0] + delta[0], cur[1] + delta[1]]);
  }
}

// ------- 矛盾検出(GCSの矛盾拘束id一覧だけでは不十分なため、解いた後の座標から
//         残差を再計算して裏取りする、実機確認済みの必要な二重チェック) -------
//
// get_gcs_conflicting_constraints()はFreeCADの実装上、主に「同じ変数に対する重複した等式」の
// ような冗長性由来の矛盾を検出するもので、三角不等式違反(3点間の距離3本が幾何学的に両立しない)
// のような純粋に距離的な矛盾や、固定点どうしの矛盾する要求では空配列を返すことがある
// (get_gcs_conflicting_constraints()が空でもsolve()のSolveStatusはFailedになるケースがあり、
// 解けなかった証拠にはなる)。そのため、解いた後の具体的な座標から各拘束の残差を再計算し、
// CONFLICT_TOLERANCEを超えていれば矛盾とみなす(旧ソルバのCONFLICT_TOLERANCE判定と同じ考え方・
// 同じ値。既存のsolveSketch()呼び出し側は「収束後の残差」で矛盾を判定する前提のため踏襲する)。
const CONFLICT_TOLERANCE = 1e-4;
const RESIDUAL_MIN_SAFE_LENGTH = 1e-9;

function ptDist(a: Point2, b: Point2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function dirVec(a: Point2, b: Point2): Point2 {
  return [b[0] - a[0], b[1] - a[1]];
}

/** 点pから直線(a→b、無限直線扱い)への符号付き垂直距離。 */
function perpDistanceSigned(p: Point2, a: Point2, b: Point2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.max(Math.hypot(dx, dy), RESIDUAL_MIN_SAFE_LENGTH);
  return ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

/** 2方向ベクトルのなす角(度、0〜180、向きの区別をしない)。 */
function angleBetweenDeg(a: Point2, b: Point2): number {
  const cross = a[0] * b[1] - a[1] * b[0];
  const dot = a[0] * b[0] + a[1] * b[1];
  return (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI;
}

/** entity(可動)の代表点を、解いた後の具体的な座標から求める(残差再計算専用の簡易版)。 */
function repPointConcrete(entity: SketchEntity | undefined): Point2 {
  if (!entity) return [0, 0];
  if (entity.kind === "circle" || entity.kind === "rectangle" || entity.kind === "regularPolygon") return entity.center;
  if (entity.kind === "polygon") return entity.points[0] ?? [0, 0];
  if (entity.kind === "slot") return [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2];
  return [0, 0];
}

/** 1件の拘束について、解いた後の座標での残差(絶対値、mmまたは度)を計算する。参照先が無ければ0。 */
function evaluateResidual(
  c: SketchConstraint,
  segments: readonly SketchSegment[],
  entities: readonly SketchEntity[],
  segmentsById: Map<string, SketchSegment>,
  entitiesById: Map<string, SketchEntity>,
): number {
  const segPoint = (ref: PointRef): Point2 => currentPoint(segmentsById, ref);
  const axisSignedOrAbs = (d: number, value: number, signed: boolean | undefined): number =>
    signed === true ? Math.abs(d - value) : Math.abs(Math.abs(d) - value);

  switch (c.kind) {
    case "coincident":
      return ptDist(segPoint(c.a), segPoint(c.b));
    case "horizontal": {
      const s = segmentsById.get(c.segmentId);
      return s ? Math.abs(s.p1[1] - s.p2[1]) : 0;
    }
    case "vertical": {
      const s = segmentsById.get(c.segmentId);
      return s ? Math.abs(s.p1[0] - s.p2[0]) : 0;
    }
    case "length": {
      const s = segmentsById.get(c.segmentId);
      return s ? Math.abs(ptDist(s.p1, s.p2) - c.value) : 0;
    }
    case "distance": {
      const a = segPoint(c.a);
      const b = segPoint(c.b);
      if (c.axis === "x" || c.axis === "y") {
        const i = c.axis === "x" ? 0 : 1;
        return axisSignedOrAbs(b[i] - a[i], c.value, c.signed);
      }
      return Math.abs(ptDist(a, b) - c.value);
    }
    case "radius": {
      const s = segmentsById.get(c.segmentId);
      if (!s || s.kind !== "arc" || !s.bulge) return 0;
      const theta = 4 * Math.atan(s.bulge);
      const chord = 2 * c.value * Math.abs(Math.sin(theta / 2));
      return Math.abs(ptDist(s.p1, s.p2) - chord);
    }
    case "fix":
    case "fixEntity":
      return 0;
    case "distanceEntityOrigin": {
      const e = entitiesById.get(c.entity.entityId);
      if (!e) return 0;
      const p = repPointConcrete(e);
      const origin = c.originLocal ?? [0, 0];
      if (c.axis === "x" || c.axis === "y") {
        const i = c.axis === "x" ? 0 : 1;
        return axisSignedOrAbs(p[i] - origin[i], c.value, c.signed);
      }
      return Math.abs(ptDist(p, origin) - c.value);
    }
    case "distancePointOrigin": {
      const p = segPoint(c.point);
      const origin = c.originLocal ?? [0, 0];
      if (c.axis === "x" || c.axis === "y") {
        const i = c.axis === "x" ? 0 : 1;
        return axisSignedOrAbs(p[i] - origin[i], c.value, c.signed);
      }
      return Math.abs(ptDist(p, origin) - c.value);
    }
    case "coincidentOrigin": {
      const origin = c.originLocal ?? [0, 0];
      const p = "segmentId" in c.point ? segPoint(c.point) : repPointConcrete(entitiesById.get(c.point.entityId));
      return ptDist(p, origin);
    }
    case "distanceEntityEntity": {
      const a = entitiesById.get(c.a.entityId);
      const b = entitiesById.get(c.b.entityId);
      if (!a || !b) return 0;
      const pa = repPointConcrete(a);
      const pb = repPointConcrete(b);
      if (c.axis === "x" || c.axis === "y") {
        const i = c.axis === "x" ? 0 : 1;
        return axisSignedOrAbs(pb[i] - pa[i], c.value, c.signed);
      }
      return Math.abs(ptDist(pa, pb) - c.value);
    }
    case "distanceEntityLine": {
      const e = entitiesById.get(c.entity.entityId);
      if (!e) return 0;
      const line = resolveLineRefPoints(c.line, entities, segments);
      if (!line) return 0;
      return Math.abs(Math.abs(perpDistanceSigned(repPointConcrete(e), line[0], line[1])) - c.value);
    }
    case "distancePointLine": {
      const p = segPoint(c.point);
      const line = resolveLineRefPoints(c.line, entities, segments);
      if (!line) return 0;
      return Math.abs(Math.abs(perpDistanceSigned(p, line[0], line[1])) - c.value);
    }
    case "perpendicular": {
      const a = segmentsById.get(c.a);
      const b = segmentsById.get(c.b);
      if (!a || !b) return 0;
      const da = dirVec(a.p1, a.p2);
      const db = dirVec(b.p1, b.p2);
      const la = Math.max(Math.hypot(da[0], da[1]), RESIDUAL_MIN_SAFE_LENGTH);
      const lb = Math.max(Math.hypot(db[0], db[1]), RESIDUAL_MIN_SAFE_LENGTH);
      return Math.abs((da[0] * db[0] + da[1] * db[1]) / (la * lb));
    }
    case "concentric": {
      const a = entitiesById.get(c.a.entityId);
      const b = entitiesById.get(c.b.entityId);
      if (!a || !b) return 0;
      return ptDist(repPointConcrete(a), repPointConcrete(b));
    }
    case "tangent": {
      const e = entitiesById.get(c.entity.entityId);
      if (!e || e.kind !== "circle") return 0;
      if (c.target.kind === "segment") {
        const s = segmentsById.get(c.target.segmentId);
        if (!s) return 0;
        return Math.abs(Math.abs(perpDistanceSigned(repPointConcrete(e), s.p1, s.p2)) - e.radius);
      }
      const other = entitiesById.get(c.target.entityId);
      if (!other || other.kind !== "circle") return 0;
      const target = c.target.mode === "internal" ? Math.abs(e.radius - other.radius) : e.radius + other.radius;
      return Math.abs(ptDist(repPointConcrete(e), repPointConcrete(other)) - target);
    }
    case "distanceLineLine": {
      const a = segmentsById.get(c.a);
      const b = segmentsById.get(c.b);
      if (!a || !b) return 0;
      const r1 = Math.abs(Math.abs(perpDistanceSigned(a.p1, b.p1, b.p2)) - c.value);
      const r2 = Math.abs(Math.abs(perpDistanceSigned(a.p2, b.p1, b.p2)) - c.value);
      return Math.max(r1, r2);
    }
    case "angleLineLine": {
      const a = segmentsById.get(c.a);
      const b = segmentsById.get(c.b);
      if (!a || !b) return 0;
      return Math.abs(angleBetweenDeg(dirVec(a.p1, a.p2), dirVec(b.p1, b.p2)) - c.value);
    }
    case "distanceLineRefEdge": {
      const s = segmentsById.get(c.segmentId);
      if (!s) return 0;
      const line = resolveLineRefPoints(c.line, entities);
      if (!line) return 0;
      const r1 = Math.abs(Math.abs(perpDistanceSigned(s.p1, line[0], line[1])) - c.value);
      const r2 = Math.abs(Math.abs(perpDistanceSigned(s.p2, line[0], line[1])) - c.value);
      return Math.max(r1, r2);
    }
    case "angleLineRefEdge": {
      const s = segmentsById.get(c.segmentId);
      if (!s) return 0;
      const line = resolveLineRefPoints(c.line, entities);
      if (!line) return 0;
      return Math.abs(angleBetweenDeg(dirVec(s.p1, s.p2), dirVec(line[0], line[1])) - c.value);
    }
  }
}

/** solveSketch()から呼ばれる、GCSベースの実装。GCS未初期化時は呼び出し禁止(呼び出し側でisGcsReady()を確認)。 */
export function solveSketchGcs(
  segments: readonly SketchSegment[],
  constraints: readonly SketchConstraint[],
  entities: readonly SketchEntity[],
  options: SolveOptions = {},
): SolveResult {
  const w = wrapper;
  if (!w) throw new Error("solveSketchGcs() called before GCS initialization completed");

  const dragTarget = options.dragTarget;
  const movableEntities = entities.filter(isMovableEntity);

  if (segments.length === 0 && movableEntities.length === 0) {
    return { ok: true, segments: [], entities: entities.map((e) => ({ ...e })) };
  }
  if (constraints.length === 0 && !dragTarget) {
    return { ok: true, segments: segments.map((s) => ({ ...s })), entities: entities.map((e) => ({ ...e })) };
  }

  const runSolve = (ctx: BuildContext, maxIterations: number, algorithm: Algorithm) => {
    w.clear_data();
    w.set_max_iterations(maxIterations);
    // 既定の収束閾値だと、剛体並進(rectangle/polygonの補助点群)を介した劣拘束方向に
    // 数百分の1mm程度の残差が残ることがあった(CONFLICT_TOLERANCEより一桁小さいオーダーだが、
    // toBeCloseTo(0,3)相当のUIの表示精度に影響しうる)。仕上げ段階の精度を上げるため厳しめに設定する
    // (性能への影響は無視できる、スパイクの計測通りsolve自体は依然サブミリ秒)。
    w.set_convergence_threshold(1e-10);
    const primitives: SketchPrimitive[] = [...ctx.points.values(), ...ctx.lines.values(), ...ctx.constraints];
    w.push_primitives_and_params(primitives);
    w.solve(algorithm);
    w.apply_solution();
  };

  let solvedSegments: SketchSegment[];
  let solvedEntities: SketchEntity[];

  if (dragTarget) {
    // ドラッグは一時拘束(temporary)自体が「カーソル位置へ引きたい」という明確な方向を与えるため、
    // 正則化(劣拘束方向を入力に近づける)は不要(むしろ入力位置に留めようとして競合してしまう)。
    // 単発solveのみ、緩和した反復回数で解く(スパイクの06-drag-tuning.mjsで確認済み)。
    // アルゴリズムは既定のDogLeg(temporary拘束はDogLeg利用時に内部的にSQPへ自動切替される、
    // パッケージREADME記載)のままにする。LevenbergMarquardtだとtemporary拘束がほぼ効かず
    // (ドラッグしてもカーソルへほとんど追従しない)実機確認したため、通常solve(下記else節)とは
    // 意図的にアルゴリズムを使い分ける。
    const ctx = buildContext(segments, constraints, entities, false);
    addDragConstraints(ctx, dragTarget);
    runSolve(ctx, DRAG_MAX_ITERATIONS, Algorithm.DogLeg);
    solvedSegments = segmentsFromGcs(w, segments);
    solvedEntities = entitiesFromGcs(w, entities);
  } else {
    // 2段階solve(旧ソルバのwarmup+finishingと同じ考え方): ①正則化(低scaleのcoordinate_x/y)
    // 付きで解き、劣拘束方向を「入力形状に最も近い解」に誘導する。②その解を初期値として、
    // 今度は正則化なし(拘束のみ)で再度解き、正則化由来のわずかな残差バイアスを解消する
    // (single-passのままだと、劣拘束の点を動かす必要がある拘束[例: 距離拘束]の残差に
    // REGULARIZATION_SCALEに比例する系統的なズレが残ってしまうことを実機確認したため)。
    //
    // アルゴリズムはLevenbergMarquardtをまず試す: 旧ソルバもLM法であり、「一致チェーンで
    // 繋がった剛体(length+horizontal/vertical)の遠い方の端点が大きく動く場合、入力形状からの
    // 連続的な変形として自然な側(符号)を選ぶ」挙動がLMだと旧ソルバと一致するのに対し、
    // 既定のDogLegだと逆側(反対の符号)の等価な解に飛んでしまうケースが実機確認で見つかったため
    // (tests/sketch/solver.test.tsの一致クラスタ経由の連動テスト参照)。ただしLMは
    // 剛体並進(rectangle/polygonのentityEdge、代表点+difference拘束で連結した補助点群)を
    // 含む問題で局所解に留まり実質動かないまま収束することがあるため(同テストファイルの
    // distanceEntityLine(entityEdge)参照)、LMの結果が矛盾判定の許容誤差を超えていたら
    // DogLegでも解き直し、残差がより小さい方を採用する(どちらのアルゴリズムでも解けない
    // 場合のみ実際に矛盾として扱う)。
    const solveTwoStage = (algorithm: Algorithm): { segments: SketchSegment[]; entities: SketchEntity[] } => {
      const warmCtx = buildContext(segments, constraints, entities, true);
      runSolve(warmCtx, defaultMaxIterations, algorithm);
      const warmCoords = readAllPointCoords(w, warmCtx);

      // 仕上げ段階も同じ参照構造(元のsegments/entities、rectangle/polygonの補助点のオフセットは
      // 常に元の形状基準)でctxを作り直し、各点の初期値だけウォームアップの結果で上書きする
      // (readAllPointCoords()のコメント参照。SketchSegment/SketchEntityへ変換してから作り直すと
      // 補助点の基準がズレて収束が乱れることがある)。
      const finishCtx = buildContext(segments, constraints, entities, false);
      overrideInitCoords(finishCtx, warmCoords);
      runSolve(finishCtx, defaultMaxIterations, algorithm);
      return { segments: segmentsFromGcs(w, segments), entities: entitiesFromGcs(w, entities) };
    };
    const worstResidualOf = (segs: readonly SketchSegment[], ents: readonly SketchEntity[]): number => {
      const segsById = new Map(segs.map((s) => [s.id, s]));
      const entsById = new Map(ents.map((e) => [e.id, e]));
      return constraints.reduce((acc, c) => Math.max(acc, evaluateResidual(c, segs, ents, segsById, entsById)), 0);
    };

    const lmResult = solveTwoStage(Algorithm.LevenbergMarquardt);
    if (worstResidualOf(lmResult.segments, lmResult.entities) <= CONFLICT_TOLERANCE) {
      solvedSegments = lmResult.segments;
      solvedEntities = lmResult.entities;
    } else {
      const dogLegResult = solveTwoStage(Algorithm.DogLeg);
      if (worstResidualOf(dogLegResult.segments, dogLegResult.entities) < worstResidualOf(lmResult.segments, lmResult.entities)) {
        solvedSegments = dogLegResult.segments;
        solvedEntities = dogLegResult.entities;
      } else {
        solvedSegments = lmResult.segments;
        solvedEntities = lmResult.entities;
      }
    }
  }

  // ドラッグ中の一時的な引き寄せ(temporary拘束)自体は矛盾判定の対象にしない
  // (常に達成できるとは限らないソフトな希望であり、既存のsketch自体の拘束[hard]が矛盾しているかを
  // 見たいため。dragTarget中も既存拘束のresidualは通常どおり評価する)。
  if (!dragTarget) {
    const solvedSegmentsById = new Map(solvedSegments.map((s) => [s.id, s]));
    const solvedEntitiesById = new Map(solvedEntities.map((e) => [e.id, e]));
    const ranked = constraints
      .map((c) => ({ constraint: c, residual: evaluateResidual(c, solvedSegments, solvedEntities, solvedSegmentsById, solvedEntitiesById) }))
      .sort((a, b) => b.residual - a.residual);
    const worst = ranked[0]?.residual ?? 0;
    if (worst > CONFLICT_TOLERANCE) {
      // GCSが具体的な矛盾拘束idを特定できている場合はそちらを優先する(get_gcs_conflicting_constraints()、
      // 拘束一覧の表記へ変換)。特定できなければ残差ランキング上位(最大2件)を使う。
      const conflictingGcsIds = w.get_gcs_conflicting_constraints();
      const seen = new Set<string>();
      const offenders: SketchConstraint[] = [];
      for (const gid of conflictingGcsIds) {
        const origId = originalConstraintId(gid);
        if (!origId || seen.has(origId)) continue;
        seen.add(origId);
        const constraint = constraints.find((c) => c.id === origId);
        if (constraint) offenders.push(constraint);
        if (offenders.length >= 2) break;
      }
      if (offenders.length === 0) {
        for (const { constraint, residual } of ranked) {
          if (residual <= CONFLICT_TOLERANCE) break;
          offenders.push(constraint);
          if (offenders.length >= 2) break;
        }
      }
      const names = offenders.map((o) => `『${constraintFullLabel(segments, entities, o)}』`);
      const detail = names.length > 0 ? `${names[0]}を満たす位置に到達できませんでした${names.length > 1 ? `(関連: ${names[1]})` : ""}。` : "";
      return {
        ok: false,
        conflicting: true,
        message: `${detail}拘束が矛盾しているか、現在の配置から解に到達できません(残差 ${worst.toFixed(4)})。`,
      };
    }
  }

  if (!dragTarget) {
    const delta = maxCoordDelta(segments, solvedSegments, entities, solvedEntities);
    if (delta < EARLY_RETURN_TOLERANCE) {
      return { ok: true, segments: segments.map((s) => ({ ...s })), entities: entities.map((e) => ({ ...e })) };
    }
  }

  return { ok: true, segments: solvedSegments, entities: solvedEntities };
}

/** solveSketch()と同じ組み立てで解いた上で、寸法未確定(DOF>0)や矛盾/冗長な拘束idを返す(Phase 35b-2の診断UI向け)。 */
export interface SketchDiagnostics {
  dof: number;
  conflicting: string[];
  redundant: string[];
}

export function getSketchDiagnostics(
  segments: readonly SketchSegment[],
  constraints: readonly SketchConstraint[],
  entities: readonly SketchEntity[],
): SketchDiagnostics | null {
  const w = wrapper;
  if (!w) return null;
  const ctx = buildContext(segments, constraints, entities);
  w.clear_data();
  w.set_max_iterations(defaultMaxIterations);
  const primitives: SketchPrimitive[] = [...ctx.points.values(), ...ctx.lines.values(), ...ctx.constraints];
  w.push_primitives_and_params(primitives);
  w.solve(Algorithm.LevenbergMarquardt);
  w.apply_solution();
  const toOriginalIds = (ids: string[]): string[] => {
    const seen = new Set<string>();
    for (const gid of ids) {
      const orig = originalConstraintId(gid);
      if (orig) seen.add(orig);
    }
    return [...seen];
  };

  // solveSketchGcs()の矛盾検出と同じ二重チェック(コメント参照): get_gcs_conflicting_constraints()
  // だけでは冗長性由来の矛盾しか拾えず、三角不等式違反のような純粋な距離的矛盾(実機確認例:
  // 円Aを固定して円Bとの中心間距離を指定した後、円Bの中心を直接編集の経路[拘束ツール等の
  // 巻き戻しを経由しない編集]で全く離れた位置へ動かすと、この2拘束[fixEntity+distanceEntityEntity]は
  // 幾何学的に両立しなくなるが、GCSの矛盾拘束id一覧は空のまま)を見逃すことがある。呼び出し時点の
  // segments/entitiesの座標(直前のsolve結果、または矛盾検出でロールバックされず残った生の入力)
  // そのものに対して各拘束の残差を再計算し、CONFLICT_TOLERANCEを超えるものを矛盾拘束とみなして
  // GCS側の検出結果と合わせる(和集合)。
  const segmentsById = new Map(segments.map((s) => [s.id, s]));
  const entitiesById = new Map(entities.map((e) => [e.id, e]));
  const residualConflictingIds = new Set<string>();
  for (const c of constraints) {
    if (evaluateResidual(c, segments, entities, segmentsById, entitiesById) > CONFLICT_TOLERANCE) {
      residualConflictingIds.add(c.id);
    }
  }
  const gcsConflictingIds = toOriginalIds(w.get_gcs_conflicting_constraints());
  const conflicting = new Set([...residualConflictingIds, ...gcsConflictingIds]);

  return {
    dof: w.gcs.dof(),
    conflicting: [...conflicting],
    redundant: toOriginalIds(w.get_gcs_redundant_constraints()),
  };
}

