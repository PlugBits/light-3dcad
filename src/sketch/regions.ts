// 自由な線分・円弧セグメントの集まりから閉領域(外枠+穴)を検出する(Phase 19a)。
// ReactにもThree.jsにもReplicad(OCCT)にも依存しない純粋TypeScript
// (src/sketch/intersections.ts, containment.ts と同じ方針)。
//
// アルゴリズム概要(モジュール冒頭のdocs/PLAN.md記載の手順どおり):
//   1. 全セグメント対の交点(src/sketch/intersections.ts)でセグメントを分割し、
//      分割点をEPS許容でマージした頂点を持つ平面グラフ(半エッジ構造)を構築する。
//   2. 各無向エッジを両方向のハーフエッジにし、各頂点で出て行くハーフエッジを
//      角度(円弧は端点での接線方向)でソートする。「twin(逆方向エッジ)の直前
//      (角度昇順で1つ前、周回)」を次のハーフエッジとする規則(標準的な平面グラフの
//      面巡回アルゴリズム)で、ハーフエッジの置換(パーミュテーション)としてすべての
//      面ループを一意に分解する。
//   3. 符号付き面積(Green's theoremの円弧版を含む)で正の面(=有界面、外枠or穴の候補)
//      と負の面(無限面/ぶら下がり枝の往復)を判別する。ぶら下がり枝は往復ハーフエッジの
//      隣接対としてループ中に現れるため、スタックベースの「隣接twin対の除去」で
//      後処理として取り除く(面積・出力の両方に影響しない)。
//   4. 残った正の面候補同士の包含関係(偶奇ルール、深さ)から「外枠(偶数深度)」
//      「穴(直近の親が外枠、奇数深度)」を判定し、Region[]を組み立てる
//      (深度2以上の偶数深度は穴の中の島として独立したRegionになる)。
//
// 出力のLoopは向きを正規化する: outerは反時計回り(符号付き面積が正)、holeは
// 時計回り(outer候補ループを逆向きにする。逆向き = 各エッジの逆ハーフエッジ
// (p1/p2入れ替え・円弧はbulge符号反転)を逆順に並べたもの)。
import type { SketchSegment } from "../model/types";
import { arcGeometryFromBulge, bulgeArcPoints } from "./bulge";
import { arcArcIntersection, lineArcIntersection, lineLineIntersection, splitSegmentAt, EPS, type SegIntersection } from "./intersections";

export type Point2 = [number, number];

/** 閉ループ(順序付きセグメント列。連続するセグメントのp2と次のp1が一致する)。 */
export type Loop = SketchSegment[];

/** 閉領域: outerが外枠(反時計回り)、holesが穴(時計回り、0件以上)。 */
export interface Region {
  outer: Loop;
  holes: Loop[];
}

/** 面積がこれ以下(mm^2)の面はノイズ/退化面として無視する。 */
const AREA_EPS = 1e-7;

function dist(a: Point2, b: Point2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function isArcWithBulge(seg: SketchSegment): boolean {
  return seg.kind === "arc" && !!seg.bulge;
}

/** セグメントAとBの交点を、種別(直線/円弧)に応じて適切なintersections.ts関数へディスパッチする。 */
function intersectSegments(a: SketchSegment, b: SketchSegment): SegIntersection[] {
  const aArc = isArcWithBulge(a);
  const bArc = isArcWithBulge(b);
  if (!aArc && !bArc) return lineLineIntersection(a, b);
  if (!aArc && bArc) return lineArcIntersection(a, b);
  if (aArc && !bArc) return lineArcIntersection(b, a).map((r) => ({ point: r.point, tA: r.tB, tB: r.tA }));
  return arcArcIntersection(a, b);
}

/** セグメントの向きを反転した新しいセグメントを返す(直線: p1/p2入れ替え。円弧: 加えてbulge符号反転)。 */
function reverseSegment(seg: SketchSegment, idSuffix: string): SketchSegment {
  if (seg.kind === "arc" && seg.bulge) {
    return { id: `${seg.id}${idSuffix}`, kind: "arc", p1: seg.p2, p2: seg.p1, bulge: -seg.bulge };
  }
  return { id: `${seg.id}${idSuffix}`, kind: "line", p1: seg.p2, p2: seg.p1 };
}

/**
 * 有向セグメントの、始点(p1)における出発角度(ラジアン)を返す。
 * 直線は弦の方向、円弧は始点における接線方向(sweepの符号で回転方向が決まる)。
 * 面巡回の「角度でソートして次のハーフエッジを選ぶ」ために使う。
 */
function departureAngle(seg: SketchSegment): number {
  if (seg.kind === "arc" && seg.bulge) {
    const geom = arcGeometryFromBulge(seg.p1, seg.p2, seg.bulge);
    if (geom) {
      const tangent: Point2 =
        geom.sweep >= 0 ? [-Math.sin(geom.startAngle), Math.cos(geom.startAngle)] : [Math.sin(geom.startAngle), -Math.cos(geom.startAngle)];
      return Math.atan2(tangent[1], tangent[0]);
    }
  }
  return Math.atan2(seg.p2[1] - seg.p1[1], seg.p2[0] - seg.p1[0]);
}

/**
 * 有向セグメント1本の符号付き面積寄与(Green's theorem: 1/2 ∮(x dy - y dx))。
 * 直線は標準的なシューレース項、円弧は弦の項に扇形寄与(r^2 * sweep)を加えたもの
 * (導出はこのファイルのコメント末尾を参照。中心・半径はp1・p2・bulgeから一意に定まる)。
 */
function edgeAreaContribution(seg: SketchSegment): number {
  const chordTerm = seg.p1[0] * seg.p2[1] - seg.p2[0] * seg.p1[1];
  if (seg.kind === "arc" && seg.bulge) {
    const geom = arcGeometryFromBulge(seg.p1, seg.p2, seg.bulge);
    if (geom) {
      const { center, radius, sweep } = geom;
      return (center[0] * (seg.p2[1] - seg.p1[1]) - center[1] * (seg.p2[0] - seg.p1[0]) + radius * radius * sweep) / 2;
    }
  }
  return chordTerm / 2;
}

/** セグメントをポリライン近似する(直線はそのまま2点、円弧はbulgeArcPointsで近似)。containment判定・代表点計算用。 */
function segmentPolyline(seg: SketchSegment, segs = 24): Point2[] {
  if (seg.kind === "arc" && seg.bulge) {
    return bulgeArcPoints(seg.p1, seg.p2, seg.bulge, segs);
  }
  return [seg.p1, seg.p2];
}

/**
 * ループ(セグメント列)を1本の閉ポリラインに変換する(連続する区間の重複点は間引く)。
 * evaluator.ts が entities と segments-regions を横断した包含判定(Phase 22)のために
 * 外部公開する(region.outer を疑似polygonエンティティの points として使う)。
 */
export function loopPolyline(loop: Loop): Point2[] {
  const points: Point2[] = [];
  for (const seg of loop) {
    const pts = segmentPolyline(seg);
    for (let i = 0; i < pts.length; i += 1) {
      if (points.length > 0 && i === 0) continue; // 直前のセグメントの終点と重複するため飛ばす。
      points.push(pts[i]);
    }
  }
  return points;
}

/** 点が多角形(閉ポリライン)の内部にあるか(ray casting)。境界上の扱いは本用途では問題にならない(代表点は境界から意図的にずらす)。 */
function pointInPolygon(point: Point2, polygon: Point2[]): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * ループの内部にある代表点(containment判定用)を求める。
 * 最初のセグメントの中点から、ループの内側方向(正の面積=反時計回りループの左手側)へ
 * ごく僅かにオフセットした点を使う(単純ループであれば境界付近でも内部に入る)。
 */
function representativePoint(loop: Loop): Point2 {
  const seg = loop[0];
  const mx = (seg.p1[0] + seg.p2[0]) / 2;
  const my = (seg.p1[1] + seg.p2[1]) / 2;
  const dx = seg.p2[0] - seg.p1[0];
  const dy = seg.p2[1] - seg.p1[1];
  const len = Math.hypot(dx, dy) || 1;
  // 左手側(反時計回りループの内側)の単位法線。
  const nx = -dy / len;
  const ny = dx / len;
  const nudge = Math.max(len * 0.01, 1e-4);
  return [mx + nx * nudge, my + ny * nudge];
}

interface HalfEdge {
  from: number;
  to: number;
  seg: SketchSegment;
  angle: number;
  twinIndex: number;
  visited: boolean;
}

/**
 * セグメント集合から、すべての交点で分割された有向グラフ(ハーフエッジ)を構築する。
 * 戻り値: halfEdges配列と、頂点ごとに角度昇順ソートされた出発ハーフエッジ index 一覧。
 */
function buildHalfEdgeGraph(segments: SketchSegment[]): { halfEdges: HalfEdge[]; byVertex: number[][] } {
  const n = segments.length;
  const paramsPerSegment: Set<number>[] = Array.from({ length: n }, () => new Set<number>());

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const hits = intersectSegments(segments[i], segments[j]);
      for (const hit of hits) {
        paramsPerSegment[i].add(hit.tA);
        paramsPerSegment[j].add(hit.tB);
      }
    }
  }

  const subSegments: SketchSegment[] = [];
  for (let i = 0; i < n; i += 1) {
    const parts = splitSegmentAt(segments[i], Array.from(paramsPerSegment[i]));
    subSegments.push(...parts);
  }

  // 頂点クラスタリング(EPS許容でマージ)。
  const vertexPoints: Point2[] = [];
  const vertexIdFor = (p: Point2): number => {
    for (let k = 0; k < vertexPoints.length; k += 1) {
      if (dist(vertexPoints[k], p) <= EPS) return k;
    }
    vertexPoints.push(p);
    return vertexPoints.length - 1;
  };

  const halfEdges: HalfEdge[] = [];
  for (const seg of subSegments) {
    const v1 = vertexIdFor(seg.p1);
    const v2 = vertexIdFor(seg.p2);
    const fwdIndex = halfEdges.length;
    const revIndex = fwdIndex + 1;
    halfEdges.push({ from: v1, to: v2, seg, angle: departureAngle(seg), twinIndex: revIndex, visited: false });
    const reversed = reverseSegment(seg, ":r");
    halfEdges.push({ from: v2, to: v1, seg: reversed, angle: departureAngle(reversed), twinIndex: fwdIndex, visited: false });
  }

  const byVertexRaw = new Map<number, number[]>();
  for (let i = 0; i < halfEdges.length; i += 1) {
    const list = byVertexRaw.get(halfEdges[i].from) ?? [];
    list.push(i);
    byVertexRaw.set(halfEdges[i].from, list);
  }
  const byVertex: number[][] = [];
  for (let v = 0; v < vertexPoints.length; v += 1) {
    const list = byVertexRaw.get(v) ?? [];
    list.sort((a, b) => halfEdges[a].angle - halfEdges[b].angle);
    byVertex[v] = list;
  }

  return { halfEdges, byVertex };
}

/** スタックベースで、ループ中の隣接するtwin対(往復するぶら下がり枝)を除去する。 */
function removeSpikes(loopIdx: number[], halfEdges: HalfEdge[]): number[] {
  const stack: number[] = [];
  for (const idx of loopIdx) {
    if (stack.length > 0 && halfEdges[stack[stack.length - 1]].twinIndex === idx) {
      stack.pop();
    } else {
      stack.push(idx);
    }
  }
  while (stack.length >= 2 && halfEdges[stack[0]].twinIndex === stack[stack.length - 1]) {
    stack.shift();
    stack.pop();
  }
  return stack;
}

/**
 * セグメント集合から閉領域(外枠+穴)を検出する(Phase 19aの核心)。
 * 閉じないぶら下がりセグメント・開いた線分は領域を構成しない(無視される)。
 */
export function findClosedRegions(segments: SketchSegment[]): Region[] {
  if (segments.length === 0) return [];

  const { halfEdges, byVertex } = buildHalfEdgeGraph(segments);
  if (halfEdges.length === 0) return [];

  const posInVertexList = new Map<number, number>();
  for (const list of byVertex) {
    list.forEach((heIdx, pos) => posInVertexList.set(heIdx, pos));
  }

  const nextOf = (cur: number): number => {
    const twin = halfEdges[cur].twinIndex;
    const to = halfEdges[cur].to;
    const list = byVertex[to];
    const pos = posInVertexList.get(twin) ?? 0;
    return list[(pos - 1 + list.length) % list.length];
  };

  const rawLoops: number[][] = [];
  for (let i = 0; i < halfEdges.length; i += 1) {
    if (halfEdges[i].visited) continue;
    const loopIdx: number[] = [];
    let cur = i;
    do {
      halfEdges[cur].visited = true;
      loopIdx.push(cur);
      cur = nextOf(cur);
    } while (cur !== i);
    rawLoops.push(loopIdx);
  }

  interface Candidate {
    loop: Loop;
    area: number;
    testPoint: Point2;
    polyline: Point2[];
  }
  const candidates: Candidate[] = [];
  for (const raw of rawLoops) {
    const cleaned = removeSpikes(raw, halfEdges);
    if (cleaned.length < 2) continue;
    const loop = cleaned.map((idx) => halfEdges[idx].seg);
    const area = loop.reduce((sum, seg) => sum + edgeAreaContribution(seg), 0);
    if (area <= AREA_EPS) continue; // 負(無限面)/退化面は候補から除外する。
    candidates.push({ loop, area, testPoint: representativePoint(loop), polyline: loopPolyline(loop) });
  }

  if (candidates.length === 0) return [];

  const depths = candidates.map((c, i) =>
    candidates.reduce((count, other, j) => (i !== j && pointInPolygon(c.testPoint, other.polyline) ? count + 1 : count), 0),
  );

  const parentOf = (i: number): number | null => {
    let best: number | null = null;
    let bestDepth = -1;
    for (let j = 0; j < candidates.length; j += 1) {
      if (j === i) continue;
      if (!pointInPolygon(candidates[i].testPoint, candidates[j].polyline)) continue;
      if (depths[j] > bestDepth) {
        bestDepth = depths[j];
        best = j;
      }
    }
    return best;
  };

  const parents = candidates.map((_, i) => parentOf(i));

  const regions: Region[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    if (depths[i] % 2 !== 0) continue; // 奇数深度は穴側(親のholesとして処理する)。
    const holes: Loop[] = [];
    for (let j = 0; j < candidates.length; j += 1) {
      if (depths[j] === depths[i] + 1 && parents[j] === i) {
        const reversed = candidates[j].loop
          .slice()
          .reverse()
          .map((seg) => reverseSegment(seg, ":h"));
        holes.push(reversed);
      }
    }
    regions.push({ outer: candidates[i].loop, holes });
  }

  return regions;
}
