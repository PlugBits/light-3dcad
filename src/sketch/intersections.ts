// 線分・円弧セグメント間の交点計算(Phase 19a)。ReactにもThree.jsにもReplicad(OCCT)にも依存しない
// 純粋TypeScript(src/sketch/containment.ts, bulge.ts と同じ方針)。src/sketch/regions.ts(閉領域検出)
// の土台となる幾何コア。
//
// 円弧はDXF互換のbulge定義(src/sketch/bulge.ts参照)で表す。円の中心・半径・角度範囲への変換は
// bulge.ts の arcGeometryFromBulge() を再利用する(evaluator/オーバーレイと同じ経由点計算を使うことで、
// 実際のB-Rep形状・ポリライン近似と交点計算の対象形状が一致するようにしている)。
//
// 数値許容: EPS(mm)を基準に、線形パラメータ(0=始点/1=終点)への換算は各セグメントの弦長・弧長で
// 正規化する(距離ベースの許容を無次元パラメータの許容に変換する)。
import type { SketchSegment } from "../model/types";
import { arcGeometryFromBulge, type ArcGeometry } from "./bulge";

export type Point2 = [number, number];

/** 交点計算・分割の共通の距離許容(mm)。 */
export const EPS = 1e-6;

/**
 * 接触(tangency)判定用の距離許容(mm、Phase 42c)。線↔円/円弧・円弧↔円弧が「接している」とみなす
 * バンド幅で、|dist(中心, 直線) − 半径| <= この値、または円弧同士は|dist(中心間) − (r1+r2)|
 * (外接)・|dist(中心間) − |r1−r2||(内接)がこの値以下なら、判別式ベースの通常経路ではなく
 * 単一の接点を直接返す(下記の各関数の接触バンド分岐を参照)。
 *
 * 値の根拠(実測、tests/sketch/intersections.test.tsの再現テストで検証):
 * ソルバ(src/sketch/gcsAdapter.ts)は解いた座標を1e-6mmグリッドへ丸める(ROUND_GRID)。
 * 接線拘束が数学的に厳密に満たされた解であっても、丸め後は中心・直線双方の端点が
 * それぞれ独立に最大でグリッド幅の半分(5e-7mm、対角成分を考えると最大 5e-7*√2≈7.1e-7mm)
 * だけずれうる。直線↔円の垂線距離は中心の丸め誤差に対して1-Lipschitz(中心を動かした分
 * そのまま距離が変わりうる)であり、さらに直線の両端点(p1/p2)の丸め誤差も回転を通じて
 * 寄与するため、極端な配置(直線の一方の腕が接点のごく近くにあり、もう一方の腕が
 * 数千mm先まで伸びる非対称な場合)を含めて数値的に走査したところ、垂線距離と半径の差
 * (本来ゼロのはずの量)は最大で約1.06e-6mm(実質グリッド1段分)まで観測された
 * (半径1〜500mm、腕の非対称性・接触角を広く走査。実務的なスケッチ規模である
 * 「半径 数百mmまで」の範囲では1e-6mm強に収まる)。
 * 判別式(2次方程式の解の公式)ベースの旧来の許容は、ここで使われていたEPS(1e-6)を
 * そのままスケールしない形で使っていたため、代数的に整理すると実効許容が
 * 常にEPS/8(=1.25e-7mm、直線の長さや半径のスケールに依らず一定)に潰れてしまい、
 * 上記の丸め誤差(最大1.06e-6mm)を1桁以上下回っていた。これが実機報告バグ
 * (接線拘束→トリムで交点が見つからず全消去)の直接の原因。
 *
 * そのため、実測ワーストケース(1.06e-6mm)に対して約100倍の安全マージンを持たせつつ、
 * 通常のスケッチで意図的に作る「わずかに離れた」形状(0.01mm〜のオーダーの意図的なギャップ・
 * 半径差)を誤って「接触」と判定しないよう、指示された1e-4〜1e-3mmの範囲の下寄りである
 * 1e-4mm(=0.1µm)を採用する。src/model/validation.tsのPOLYGON_MIN_VERTEX_DISTANCE(1e-6mm、
 * 縮退頂点の判定にのみ使う値)よりは十分大きいが、実務的な最小意味のある寸法(通常0.01mm以上)
 * よりは十分小さく、実形状の意図的な近接配置を誤検出するリスクは低い。
 */
export const TANGENT_CONTACT_EPS = 1e-4;

/** パラメータ値を[0,1]へクランプする(接触点・通常交点の両方で使う共通の丸め処理)。 */
function clampParam(t: number): number {
  return Math.min(1, Math.max(0, t));
}

/** セグメント同士の交点1件。tA/tBはそれぞれのセグメント上の位置(0=p1, 1=p2)。 */
export interface SegIntersection {
  point: Point2;
  /** セグメントA上のパラメータ位置(0=p1, 1=p2)。直線は弦長に沿った線形パラメータ、円弧は掃引角に沿った角度パラメータ。 */
  tA: number;
  /** セグメントB上のパラメータ位置(0=p1, 1=p2)。 */
  tB: number;
}

export interface IntersectionOptions {
  /**
   * true(既定)なら、両方のセグメントの端点同士がほぼ一致する(=既存の頂点でつながっている)場合も
   * 交点として結果に含める。false にすると、そのような「自明な共有端点」は除外し、
   * どちらか一方だけの端点が相手セグメントの内部に触れるT字交差や、内部同士の交差のみを返す。
   * (regions.tsは既定のtrueで呼び、後段の頂点マージで自然に処理する)。
   */
  includeEndpointTouches?: boolean;
}

function dist(a: Point2, b: Point2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function sub(a: Point2, b: Point2): Point2 {
  return [a[0] - b[0], a[1] - b[1]];
}

function dot(a: Point2, b: Point2): number {
  return a[0] * b[0] + a[1] * b[1];
}

function cross2(a: Point2, b: Point2): number {
  return a[0] * b[1] - a[1] * b[0];
}

/** 点がセグメント(直線・円弧共通、p1/p2のみ参照)の端点(いずれか)にほぼ一致するか。 */
function isSegEndpoint(point: Point2, seg: { p1: Point2; p2: Point2 }): boolean {
  return dist(point, seg.p1) <= EPS || dist(point, seg.p2) <= EPS;
}

/** includeEndpointTouches:false のとき、両セグメントの端点同士が一致する自明な交点を除外する。 */
function applyEndpointFilter(
  results: SegIntersection[],
  a: { p1: Point2; p2: Point2 },
  b: { p1: Point2; p2: Point2 },
  opts: IntersectionOptions | undefined,
): SegIntersection[] {
  const includeEndpointTouches = opts?.includeEndpointTouches ?? true;
  if (includeEndpointTouches) return results;
  return results.filter((r) => !(isSegEndpoint(r.point, a) && isSegEndpoint(r.point, b)));
}

/** ほぼ等しい点(EPS以内)を1件に間引く(同一点が2通りの計算経路から重複して出てくるのを防ぐ)。 */
function dedupePoints(results: SegIntersection[]): SegIntersection[] {
  const out: SegIntersection[] = [];
  for (const r of results) {
    if (out.some((o) => dist(o.point, r.point) <= EPS)) continue;
    out.push(r);
  }
  return out;
}

/**
 * 円弧(bulge)の中心・半径・角度範囲(bulge.tsのarcGeometryFromBulge)を求める。
 * bulgeが0/未指定、または3点がほぼ一直線上で円が定まらない場合はnull(=実質直線)を返す。
 */
function arcGeometry(seg: { p1: Point2; p2: Point2; bulge?: number }): ArcGeometry | null {
  if (!seg.bulge) return null;
  return arcGeometryFromBulge(seg.p1, seg.p2, seg.bulge);
}

/**
 * 円弧geom上の点pointが、p1(t=0)からp2(t=1)への掃引に沿ってどの位置にあるかを返す
 * (円上にあることは呼び出し側が保証する前提。円上になければ意味のない値を返す)。
 * sweepの符号(CCW正/CW負)をまたぐラップアラウンドを正しく扱うため、
 * 生の角度差を(-π,π]に正規化したのち、sweepの符号に合わせて必要なら±2πする。
 */
function arcParam(geom: ArcGeometry, point: Point2): number {
  const twoPi = Math.PI * 2;
  const angle = Math.atan2(point[1] - geom.center[1], point[0] - geom.center[0]);
  let delta = angle - geom.startAngle;
  delta -= twoPi * Math.round(delta / twoPi); // (-π, π] に正規化
  if (geom.sweep > 0 && delta < 0) delta += twoPi;
  if (geom.sweep < 0 && delta > 0) delta -= twoPi;
  return delta / geom.sweep;
}

/** パラメータtの許容幅(mm距離のEPSを弦長/弧長で正規化)。lengthが極小の場合は大きめの許容にフォールバックする。 */
function paramTolerance(length: number): number {
  return EPS / Math.max(length, EPS);
}

// ---------------------------------------------------------------------------
// 直線 × 直線
// ---------------------------------------------------------------------------

/**
 * 2つの直線セグメント(p1→p2の弦をそのまま直線として扱う。円弧のbulgeは無視する)の交点を返す。
 * 平行だが同一線上ではない場合は空配列。同一線上で区間が重なる場合は、重なりが実長を持てば
 * 重なり区間の両端点(2件)を、重なりが1点に退化する場合はその1点(1件)を返す。
 * 交差しない場合は空配列。
 */
export function lineLineIntersection(a: SketchSegment, b: SketchSegment, opts?: IntersectionOptions): SegIntersection[] {
  const d1 = sub(a.p2, a.p1);
  const d2 = sub(b.p2, b.p1);
  const len1 = Math.hypot(d1[0], d1[1]);
  const len2 = Math.hypot(d2[0], d2[1]);
  const tTol1 = paramTolerance(len1);
  const tTol2 = paramTolerance(len2);
  const denom = cross2(d1, d2);
  // denomの相対的な小ささで平行性を判定する(セグメント長のスケールに依存しないよう正規化)。
  const denomScale = len1 * len2;
  const isParallel = denomScale < EPS * EPS || Math.abs(denom) <= EPS * denomScale;

  if (!isParallel) {
    const w = sub(b.p1, a.p1);
    const t = cross2(w, d2) / denom;
    const s = cross2(w, d1) / denom;
    if (t < -tTol1 || t > 1 + tTol1 || s < -tTol2 || s > 1 + tTol2) return [];
    const tc = Math.min(1, Math.max(0, t));
    const sc = Math.min(1, Math.max(0, s));
    const point: Point2 = [a.p1[0] + tc * d1[0], a.p1[1] + tc * d1[1]];
    return applyEndpointFilter([{ point, tA: tc, tB: sc }], a, b, opts);
  }

  // 平行: 同一線上かどうかを判定する(b.p1がAの直線上にあるか)。
  const w = sub(b.p1, a.p1);
  const perpDist = Math.abs(cross2(w, d1)) / Math.max(len1, EPS);
  if (perpDist > EPS) return []; // 平行だが異なる直線上。

  if (len1 < EPS) return []; // Aが退化(バリデーションで通常起きない)。
  const lenSq1 = len1 * len1;
  const sB1 = dot(sub(b.p1, a.p1), d1) / lenSq1;
  const sB2 = dot(sub(b.p2, a.p1), d1) / lenSq1;
  const lo = Math.max(0, Math.min(sB1, sB2));
  const hi = Math.min(1, Math.max(sB1, sB2));
  if (lo > hi + tTol1) return []; // 重なりなし。

  const toPointAndB = (tA: number): { point: Point2; tB: number } => {
    const point: Point2 = [a.p1[0] + tA * d1[0], a.p1[1] + tA * d1[1]];
    const tB = len2 < EPS ? 0 : Math.min(1, Math.max(0, dot(sub(point, b.p1), d2) / (len2 * len2)));
    return { point, tB };
  };

  if (hi - lo <= tTol1) {
    // 重なりが実質1点(端点同士が触れているだけ)。
    const mid = (lo + hi) / 2;
    const { point, tB } = toPointAndB(mid);
    return applyEndpointFilter([{ point, tA: mid, tB }], a, b, opts);
  }

  const loRes = toPointAndB(lo);
  const hiRes = toPointAndB(hi);
  return applyEndpointFilter(
    [
      { point: loRes.point, tA: lo, tB: loRes.tB },
      { point: hiRes.point, tA: hi, tB: hiRes.tB },
    ],
    a,
    b,
    opts,
  );
}

// ---------------------------------------------------------------------------
// 直線 × 円弧
// ---------------------------------------------------------------------------

/**
 * 直線セグメントlineと円弧セグメントarcの交点を返す。
 * arcのbulgeが0/未指定(=実質直線)の場合はlineLineIntersection()に委譲する。
 * それ以外は、まず中心から直線までの垂線距離と半径の差(接触バンド、TANGENT_CONTACT_EPS参照)を
 * 直接判定し、バンド内なら垂線の足を単一の接点として返す(Phase 42c: ソルバの1e-6mmグリッド丸めで
 * 生じる僅かな残差を吸収し、トリムの区切り点として機能させるため。判別式ベースの許容だけでは
 * 実効的にEPS/8[≈1.25e-7mm]まで潰れてしまい丸め誤差を吸収できなかった)。
 * バンド外は通常どおり直線と円の2次方程式を解き、各解が直線区間([0,1])かつ円弧の角度範囲内に
 * あるものを返す(明確に交差する場合は0〜2件、接触バンドと判定されなかった残りの近接ケースの
 * 保険として判別式の僅かな負値も許容する)。
 */
export function lineArcIntersection(line: SketchSegment, arc: SketchSegment, opts?: IntersectionOptions): SegIntersection[] {
  const geom = arcGeometry(arc);
  if (!geom) return lineLineIntersection(line, arc, opts);

  const d = sub(line.p2, line.p1);
  const lineLen = Math.hypot(d[0], d[1]);
  const tTolLine = paramTolerance(lineLen);
  const arcLen = geom.radius * Math.abs(geom.sweep);
  const tTolArc = paramTolerance(arcLen);

  const f = sub(line.p1, geom.center);
  const a = dot(d, d);
  const b = 2 * dot(d, f);
  const c = dot(f, f) - geom.radius * geom.radius;
  if (a <= EPS * EPS) return [];

  // 接触バンド判定(Phase 42c): 中心から直線への垂線距離(|cross(d,f)|/|d|)と半径の差を、
  // 判別式を介さず直接TANGENT_CONTACT_EPSと比較する。垂線の足(-b/2a、判別式ゼロ点と同じtだが
  // 判別式の値そのものには依存しない)が直線区間・円弧角度範囲の両方に収まれば単一の接点を返す。
  const distToLine = Math.abs(cross2(d, f)) / Math.sqrt(a);
  const gap = distToLine - geom.radius;
  if (Math.abs(gap) <= TANGENT_CONTACT_EPS) {
    const tFoot = -b / (2 * a);
    if (tFoot < -tTolLine || tFoot > 1 + tTolLine) return [];
    const point: Point2 = [line.p1[0] + tFoot * d[0], line.p1[1] + tFoot * d[1]];
    const frac = arcParam(geom, point);
    if (frac < -tTolArc || frac > 1 + tTolArc) return [];
    return applyEndpointFilter([{ point, tA: clampParam(tFoot), tB: clampParam(frac) }], line, arc, opts);
  }

  const disc = b * b - 4 * a * c;
  // 判別式が0近傍のときは数値誤差で僅かに負になりうるため接する(1解)とみなす(接触バンドの外側で
  // 発生しうる、より小さな数値誤差[浮動小数点演算由来]に対する保険。実質的なソルバ丸め誤差の吸収は
  // 上記の接触バンド判定が担う)。
  const discTol = EPS * Math.max(1, a * geom.radius);
  if (disc < -discTol) return [];
  const safeDisc = Math.max(0, disc);
  const sq = Math.sqrt(safeDisc);
  const isTangent = safeDisc <= discTol;
  const roots = isTangent ? [-b / (2 * a)] : [(-b - sq) / (2 * a), (-b + sq) / (2 * a)];

  const results: SegIntersection[] = [];
  for (const t of roots) {
    if (t < -tTolLine || t > 1 + tTolLine) continue;
    const point: Point2 = [line.p1[0] + t * d[0], line.p1[1] + t * d[1]];
    const frac = arcParam(geom, point);
    if (frac < -tTolArc || frac > 1 + tTolArc) continue;
    results.push({
      point,
      tA: clampParam(t),
      tB: clampParam(frac),
    });
  }
  return applyEndpointFilter(dedupePoints(results), line, arc, opts);
}

// ---------------------------------------------------------------------------
// 円弧 × 円弧
// ---------------------------------------------------------------------------

/**
 * 2つの円弧セグメントの交点を返す。どちらか(または両方)のbulgeが0/未指定の場合は
 * lineLineIntersection/lineArcIntersectionに委譲する。
 * 円同士が同心かつ同半径(=同一円)の場合は、角度区間の重なりを直線の同一線上ケースと同様に扱い、
 * 重なりの両端(または退化する1点)を返す。それ以外は標準的な円×円の交点公式を使う。
 */
export function arcArcIntersection(a: SketchSegment, b: SketchSegment, opts?: IntersectionOptions): SegIntersection[] {
  const geomA = arcGeometry(a);
  const geomB = arcGeometry(b);
  if (!geomA && !geomB) return lineLineIntersection(a, b, opts);
  if (!geomA) return swapResult(lineArcIntersection(b, a, opts));
  if (!geomB) return lineArcIntersection(a, b, opts);

  const arcLenA = geomA.radius * Math.abs(geomA.sweep);
  const arcLenB = geomB.radius * Math.abs(geomB.sweep);
  const tTolA = paramTolerance(arcLenA);
  const tTolB = paramTolerance(arcLenB);

  const dCenters = dist(geomA.center, geomB.center);

  if (dCenters <= EPS) {
    if (Math.abs(geomA.radius - geomB.radius) > EPS) return []; // 同心だが半径が異なる: 交点なし。
    // 同一円: 角度区間の重なりを求める(直線の同一線上ケースに相当)。
    return applyEndpointFilter(concentricArcOverlap(geomA, geomB, tTolA, tTolB), a, b, opts);
  }

  const r1 = geomA.radius;
  const r2 = geomB.radius;

  // 接触バンド判定(Phase 42c、line↔arcと同じ考え方): 外接(dCenters≈r1+r2)・内接
  // (dCenters≈|r1-r2|)のいずれかにTANGENT_CONTACT_EPS以内で近ければ、判別式(hSq)を介さず
  // 単一の接点を返す。接点はどちらの場合も中心間を結ぶ直線上、Aの中心からr1だけBの方向へ
  // 進んだ点になる(外接: T=A+r1*dir、内接: T=A+r1*dirで dist(B,T)=|r1-dCenters|=r2 も成立する
  // ため同じ式で両方をカバーできる)。dCenters<=EPSの同心ケースは上で処理済みのためここでは
  // dCenters>EPSが保証されており、dirの正規化は安全。
  const extGap = dCenters - (r1 + r2);
  const intGap = dCenters - Math.abs(r1 - r2);
  if (Math.abs(extGap) <= TANGENT_CONTACT_EPS || Math.abs(intGap) <= TANGENT_CONTACT_EPS) {
    const dir: Point2 = [(geomB.center[0] - geomA.center[0]) / dCenters, (geomB.center[1] - geomA.center[1]) / dCenters];
    const point: Point2 = [geomA.center[0] + r1 * dir[0], geomA.center[1] + r1 * dir[1]];
    const fracA = arcParam(geomA, point);
    const fracB = arcParam(geomB, point);
    if (fracA < -tTolA || fracA > 1 + tTolA) return [];
    if (fracB < -tTolB || fracB > 1 + tTolB) return [];
    return applyEndpointFilter([{ point, tA: clampParam(fracA), tB: clampParam(fracB) }], a, b, opts);
  }

  if (dCenters > r1 + r2 + EPS) return [];
  if (dCenters < Math.abs(r1 - r2) - EPS) return [];

  const aParam = (dCenters * dCenters + r1 * r1 - r2 * r2) / (2 * dCenters);
  const hSq = Math.max(0, r1 * r1 - aParam * aParam);
  const h = Math.sqrt(hSq);
  const dir: Point2 = [(geomB.center[0] - geomA.center[0]) / dCenters, (geomB.center[1] - geomA.center[1]) / dCenters];
  const mid: Point2 = [geomA.center[0] + aParam * dir[0], geomA.center[1] + aParam * dir[1]];
  const perp: Point2 = [-dir[1], dir[0]];

  const isTangent = h <= EPS;
  const candidates: Point2[] = isTangent
    ? [mid]
    : [
        [mid[0] + perp[0] * h, mid[1] + perp[1] * h],
        [mid[0] - perp[0] * h, mid[1] - perp[1] * h],
      ];

  const results: SegIntersection[] = [];
  for (const point of candidates) {
    const fracA = arcParam(geomA, point);
    const fracB = arcParam(geomB, point);
    if (fracA < -tTolA || fracA > 1 + tTolA) continue;
    if (fracB < -tTolB || fracB > 1 + tTolB) continue;
    results.push({
      point,
      tA: Math.min(1, Math.max(0, fracA)),
      tB: Math.min(1, Math.max(0, fracB)),
    });
  }
  return applyEndpointFilter(dedupePoints(results), a, b, opts);
}

function swapResult(results: SegIntersection[]): SegIntersection[] {
  return results.map((r) => ({ point: r.point, tA: r.tB, tB: r.tA }));
}

/** 同一円上にある2つの円弧の角度区間の重なりを求める(±2πのラップアラウンドを考慮)。 */
function concentricArcOverlap(geomA: ArcGeometry, geomB: ArcGeometry, tTolA: number, tTolB: number): SegIntersection[] {
  const twoPi = Math.PI * 2;
  // 各円弧の絶対角度区間([lo,hi]、hi>=lo)。
  const endA1 = geomA.startAngle;
  const endA2 = geomA.startAngle + geomA.sweep;
  const loA = Math.min(endA1, endA2);
  const hiA = Math.max(endA1, endA2);

  const endB1raw = geomB.startAngle;
  const endB2raw = geomB.startAngle + geomB.sweep;
  // Bの区間をAの区間に近い側へ±2πシフトして候補を作る(ラップアラウンド対応)。
  const results: SegIntersection[] = [];
  for (const shift of [-twoPi, 0, twoPi]) {
    const b1 = endB1raw + shift;
    const b2 = endB2raw + shift;
    const loB = Math.min(b1, b2);
    const hiB = Math.max(b1, b2);
    const lo = Math.max(loA, loB);
    const hi = Math.min(hiA, hiB);
    const angTol = EPS / Math.max(geomA.radius, EPS);
    if (lo > hi + angTol) continue;

    const toResult = (angle: number): SegIntersection => {
      const point: Point2 = [geomA.center[0] + geomA.radius * Math.cos(angle), geomA.center[1] + geomA.radius * Math.sin(angle)];
      const fracA = Math.min(1, Math.max(0, arcParam(geomA, point)));
      const fracB = Math.min(1, Math.max(0, arcParam(geomB, point)));
      return { point, tA: fracA, tB: fracB };
    };

    if (hi - lo <= angTol) {
      results.push(toResult((lo + hi) / 2));
    } else {
      results.push(toResult(lo));
      results.push(toResult(hi));
    }
  }
  void tTolA;
  void tTolB;
  return dedupePoints(results);
}

// ---------------------------------------------------------------------------
// セグメント分割
// ---------------------------------------------------------------------------

/**
 * セグメントを与えられたパラメータ位置(0<t<1、0/1近傍・重複は無視)で分割する。
 * 直線は各分割点の座標をp1/p2として直線セグメントを、円弧はarcGeometryFromBulge()の
 * 中心・半径・掃引角から分割区間ごとのbulgeを再計算した円弧セグメントを返す。
 * 入力segmentがそのまま返る(分割不要)場合はt配列が実質空のときで、その場合も
 * 元のsegmentと同一内容(新規オブジェクト)の1要素配列を返す。
 * 返るセグメントのidは `${元のid}:分割インデックス` (0始まり)。
 */
export function splitSegmentAt(segment: SketchSegment, ts: number[]): SketchSegment[] {
  const chordLen = dist(segment.p1, segment.p2);
  const geom = arcGeometry(segment);
  const arcLen = geom ? geom.radius * Math.abs(geom.sweep) : chordLen;
  const tTol = paramTolerance(arcLen);

  const cleaned = Array.from(new Set(ts.filter((t) => t > tTol && t < 1 - tTol))).sort((a, b) => a - b);
  // 極めて近い分割点(丸め誤差由来)を間引く。
  const merged: number[] = [];
  for (const t of cleaned) {
    if (merged.length > 0 && t - merged[merged.length - 1] < tTol) continue;
    merged.push(t);
  }

  const boundaries = [0, ...merged, 1];
  const pointAt = (t: number): Point2 => {
    if (geom) {
      const angle = geom.startAngle + t * geom.sweep;
      return [geom.center[0] + geom.radius * Math.cos(angle), geom.center[1] + geom.radius * Math.sin(angle)];
    }
    return [segment.p1[0] + t * (segment.p2[0] - segment.p1[0]), segment.p1[1] + t * (segment.p2[1] - segment.p1[1])];
  };

  const result: SketchSegment[] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const t0 = boundaries[i];
    const t1 = boundaries[i + 1];
    const p1 = i === 0 ? segment.p1 : pointAt(t0);
    const p2 = i === boundaries.length - 2 ? segment.p2 : pointAt(t1);
    const id = `${segment.id}:${i}`;
    if (geom) {
      const subSweep = geom.sweep * (t1 - t0);
      const bulge = Math.tan(subSweep / 4);
      result.push({ id, kind: "arc", p1, p2, bulge });
    } else {
      result.push({ id, kind: "line", p1, p2 });
    }
  }
  return result;
}
