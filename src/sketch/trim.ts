// トリムツール(Phase 19b)の純粋幾何ロジック。ReactにもThree.jsにもReplicad(OCCT)にも依存しない
// (src/sketch/intersections.ts, regions.ts と同じ方針)。CadViewerはホバープレビュー用に
// findClosestSegmentPiece()を、App(ドキュメント更新)はtrimSegmentAtPoint()を呼ぶ。
//
// 考え方: 対象セグメント(targetId)を、同一スケッチ内の他のsegmentsとの交点(自身の端点は
// 暗黙の境界として扱われる。src/sketch/intersections.ts の splitSegmentAt() が両者を統合する)
// で「区間」に分割し、クリック/ホバー位置に最も近い区間を求める(削除候補として提示・実削除する)。
// 区間が1つしかできない(=他セグメントとの有効な交点が無い)場合は、区間全体=セグメント全体を削除する。
import { generateId } from "../model/id";
import type { PointRef, SketchConstraint, SketchEntity, SketchSegment } from "../model/types";
import { bulgeArcPoints } from "./bulge";
import { explodeEntity } from "./explode";
import {
  arcArcIntersection,
  lineArcIntersection,
  lineLineIntersection,
  splitSegmentAt,
  type SegIntersection,
} from "./intersections";

export type Point2 = [number, number];

/** 端点座標の一致判定に使う許容誤差(mm、src/sketch/intersections.tsのEPSと同じ)。 */
const TRIM_POINT_EPS = 1e-6;

/**
 * トリムで生じた断点(cut point)同士の一致拘束(coincident)を自動付与する際のマッチング許容
 * (mm、Phase 36)。TRIM_POINT_EPS(1e-6、旧端点への拘束"付け替え"の厳密な座標一致判定)より
 * 意図的に緩い: ユーザー報告バグの根本原因は、entityトリム(trimEntityAtPoint)が生む断片
 * (例: 円entityをトリムして生じる円弧)に隣接セグメントとの一致拘束が一切付かず、後続の
 * ソルバ実行のたびに数µmオーダーでドリフトし、src/sketch/regions.tsの頂点マージ(当時はEPS=
 * 1e-6)で「別頂点」と誤判定されて外枠ループが閉じなくなり、押し出しからその外形が消えることに
 * あった。この定数はトリム直後(まだドリフトしていない、断点は理論上厳密に一致する)の断点同士を
 * 拾うためのもので、1e-6では僅かな浮動小数点誤差(交点計算の丸め等)を取りこぼす可能性があるため
 * 少し緩め、かつ通常のスケッチ寸法感覚(0.1mm未満の意図的な近接配置)からは十分小さい1e-4mmとする。
 */
const CUT_MATCH_EPS = 1e-4;

function distPts(a: Point2, b: Point2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** セグメント端点1つを指すPointRefと、その実座標のペア(cut point一致拘束の自動付与に使う)。 */
interface EndpointCandidate {
  ref: PointRef;
  point: Point2;
}

/** セグメント配列の全端点(p1・p2の両方)をEndpointCandidate配列に展開する。 */
function endpointCandidates(segs: SketchSegment[]): EndpointCandidate[] {
  return segs.flatMap((s) => [
    { ref: { segmentId: s.id, end: "p1" as const }, point: s.p1 },
    { ref: { segmentId: s.id, end: "p2" as const }, point: s.p2 },
  ]);
}

function refsEqual(a: PointRef, b: PointRef): boolean {
  return a.segmentId === b.segmentId && a.end === b.end;
}

/** a↔b(順不同)のcoincident拘束がlist内に既に存在するか。 */
function hasCoincidentBetween(a: PointRef, b: PointRef, list: SketchConstraint[]): boolean {
  return list.some(
    (c) => c.kind === "coincident" && ((refsEqual(c.a, a) && refsEqual(c.b, b)) || (refsEqual(c.a, b) && refsEqual(c.b, a))),
  );
}

/**
 * トリムで新しく生じた断片の端点(cutPoints)それぞれについて、poolCandidates(トリム後に実在する
 * 全端点。cutPoints自身を含んでよい)の中からCUT_MATCH_EPS以内で座標が一致するものを探し、
 * まだ存在しない(existing、および今回追加した分の両方をチェックして重複を避ける)coincident拘束を
 * 追加する(Phase 36、上記CUT_MATCH_EPSのコメント参照)。自分自身(同一のPointRef)とは組まない。
 * 1つの断点に複数の一致があれば(3本以上が同一点に集まる等)すべて追加する。line↔lineの端点同士の
 * みを対象とし、point-on-curve(端点が相手セグメントの内部に接する場合)は対象外(スコープ外)。
 */
function coincidentsForCutPoints(
  cutPoints: EndpointCandidate[],
  poolCandidates: EndpointCandidate[],
  existing: SketchConstraint[],
): SketchConstraint[] {
  const added: SketchConstraint[] = [];
  for (const cp of cutPoints) {
    for (const other of poolCandidates) {
      if (refsEqual(cp.ref, other.ref)) continue;
      if (distPts(cp.point, other.point) > CUT_MATCH_EPS) continue;
      if (hasCoincidentBetween(cp.ref, other.ref, existing) || hasCoincidentBetween(cp.ref, other.ref, added)) continue;
      added.push({ id: generateId("constraint"), kind: "coincident", a: cp.ref, b: other.ref });
    }
  }
  return added;
}

function isArcWithBulge(seg: SketchSegment): boolean {
  return seg.kind === "arc" && !!seg.bulge;
}

/** target(基準)とother(相手)の交点を、種別(直線/円弧)に応じて適切なintersections.ts関数へディスパッチする。戻り値のtAはtarget上のパラメータ。 */
function intersectWithTarget(target: SketchSegment, other: SketchSegment): SegIntersection[] {
  const targetIsArc = isArcWithBulge(target);
  const otherIsArc = isArcWithBulge(other);
  if (!targetIsArc && !otherIsArc) return lineLineIntersection(target, other);
  if (!targetIsArc && otherIsArc) return lineArcIntersection(target, other);
  if (targetIsArc && !otherIsArc) {
    return lineArcIntersection(other, target).map((r) => ({ point: r.point, tA: r.tB, tB: r.tA }));
  }
  return arcArcIntersection(target, other);
}

/** セグメントのポリライン近似(直線はそのまま2点、円弧はbulgeArcPointsで近似)。距離計算・プレビュー描画用。 */
function segmentToPolyline(seg: SketchSegment, segs = 24): Point2[] {
  if (seg.kind === "arc" && seg.bulge) return bulgeArcPoints(seg.p1, seg.p2, seg.bulge, segs);
  return [seg.p1, seg.p2];
}

/** 点pから線分[a,b]への最短距離。 */
function distPointToSegment(p: Point2, a: Point2, b: Point2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  return Math.hypot(p[0] - cx, p[1] - cy);
}

/** 点pからポリライン(折れ線)への最短距離。 */
export function distPointToPolyline(p: Point2, points: Point2[]): number {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    best = Math.min(best, distPointToSegment(p, points[i], points[i + 1]));
  }
  return best;
}

/** 点pからセグメント(直線/円弧)への最短距離(ポリライン近似)。CadViewerのホバー対象選定に使う。 */
export function distPointToSegmentShape(p: Point2, seg: SketchSegment): number {
  return distPointToPolyline(p, segmentToPolyline(seg));
}

/**
 * targetId のセグメントを、同一segments内の他セグメント+同一スケッチのentities輪郭(矩形辺・円周・
 * 多角形辺(bulge込み)・スロット輪郭・正多角形辺、explodeEntity()で自由セグメントへ一時的に分解した
 * もの)との交点で区切った「区間」に分割し、その配列を返す(交点が無ければ元のセグメント1個だけの
 * 配列)。トリムの削除候補選定・実削除の両方の土台となる共通ヘルパー。entitiesはあくまで境界を
 * 提供するだけで、戻り値のothers(実際に保持するsegments)には含めない(エンティティ自体は
 * 切られない)。
 */
function splitTargetIntoPieces(
  segments: SketchSegment[],
  targetId: string,
  entities: SketchEntity[] = [],
): { target: SketchSegment; others: SketchSegment[]; pieces: SketchSegment[] } | null {
  const target = segments.find((s) => s.id === targetId);
  if (!target) return null;
  const others = segments.filter((s) => s.id !== targetId);
  const entityBoundarySegments = entities.flatMap((entity) => explodeEntity(entity));
  const boundarySegments = [...others, ...entityBoundarySegments];
  const ts = new Set<number>();
  for (const other of boundarySegments) {
    for (const hit of intersectWithTarget(target, other)) {
      ts.add(hit.tA);
    }
  }
  const pieces = splitSegmentAt(target, Array.from(ts));
  return { target, others, pieces };
}

/**
 * targetId のセグメント上、point(ローカル2D、mm)に最も近い「区間」を返す(トリムのホバー
 * プレビュー用)。targetIdが見つからない場合はnull。区間は他セグメント+entities輪郭との交点
 * (無ければセグメント全体そのもの)で区切られる。
 */
export function findClosestSegmentPiece(
  segments: SketchSegment[],
  targetId: string,
  point: Point2,
  entities: SketchEntity[] = [],
): SketchSegment | null {
  const split = splitTargetIntoPieces(segments, targetId, entities);
  if (!split) return null;
  let best = split.pieces[0];
  let bestDist = Infinity;
  for (const piece of split.pieces) {
    const d = distPointToSegmentShape(point, piece);
    if (d < bestDist) {
      bestDist = d;
      best = piece;
    }
  }
  return best;
}

/**
 * targetId のセグメント上、clickPoint(ローカル2D、mm)に最も近い区間を削除した新しいsegments配列を
 * 返す(元の配列は変更しない)。
 * - 区間が2つ以上(=他セグメント、または同一スケッチのentities輪郭との交点で分割できた)場合:
 *   クリックに最も近い区間だけを削除し、残りの区間(セグメント分割済み)を保持する。
 * - 区間が1つしかない(交点なし、または全交点が端点近傍で実質分割できない)場合:
 *   セグメント全体を削除する。
 * targetId が見つからない場合は元の配列をそのまま返す。entities(同一スケッチのrectangle/circle/
 * polygon/slot/regularPolygon)は境界を提供するだけで、それ自体は変更・削除されない。
 */
export function trimSegmentAtPoint(
  segments: SketchSegment[],
  targetId: string,
  clickPoint: Point2,
  entities: SketchEntity[] = [],
): SketchSegment[] {
  const split = splitTargetIntoPieces(segments, targetId, entities);
  if (!split) return segments;
  const { others, pieces } = split;
  if (pieces.length <= 1) {
    return others;
  }
  let removeIndex = 0;
  let bestDist = Infinity;
  pieces.forEach((piece, i) => {
    const d = distPointToSegmentShape(clickPoint, piece);
    if (d < bestDist) {
      bestDist = d;
      removeIndex = i;
    }
  });
  const kept = pieces.filter((_, i) => i !== removeIndex);
  return [...others, ...kept];
}

/**
 * splitSegmentAt()が返すpieces(区間、境界順)のうち、removeIndexを除いた「残す区間」にIDを割り当てる
 * (実機報告対応: トリムで線分が新IDの断片に置き換わり、旧IDを参照する拘束・寸法が消えるバグの修正)。
 * splitSegmentAt()の実装上、境界順の先頭(index 0)は必ず元のp1を、末尾(index pieces.length-1)は必ず
 * 元のp2を端点に持つ(区間の途中に生じる分割点は交点であり、元の端点ではない)。そのため:
 * - 削除された区間が先頭(index 0)なら、元のp1は失われる。末尾が残っていれば末尾がプライマリ
 *   (元のsegmentIdを継ぐ)。
 * - 削除された区間が末尾なら、元のp2は失われる。先頭が残っていれば先頭がプライマリ。
 * - 削除された区間が中間なら、先頭・末尾とも残るため、先頭側をプライマリとする(「片方は新ID」)。
 * プライマリ以外の残存区間(末尾側の断片や、途中に複数残る中間断片)には新規IDを発行する。
 */
function assignPieceIds(target: SketchSegment, pieces: SketchSegment[], removeIndex: number): SketchSegment[] {
  const n = pieces.length;
  const hasP1 = removeIndex !== 0;
  const hasP2 = removeIndex !== n - 1;
  const primaryIndex = hasP1 ? 0 : hasP2 ? n - 1 : -1;
  const kept: SketchSegment[] = [];
  pieces.forEach((piece, i) => {
    if (i === removeIndex) return;
    const id = i === primaryIndex ? target.id : generateId("segment");
    kept.push({ ...piece, id });
  });
  return kept;
}

/** PointRef(a/b/point等)がsegmentId===targetIdを参照しているかの簡易ガード。EntityRefと共用のフィールド名(coincidentOriginのpoint)を誤判定しないよう"segmentId"の有無で判定する。 */
function isPointRefTo(ref: PointRef | { entityId: string }, targetId: string): ref is PointRef {
  return "segmentId" in ref && ref.segmentId === targetId;
}

/**
 * targetId のセグメントをclickPointに最も近い区間で分割・削除し、segments・constraintsの両方を
 * 一貫した状態に更新する(実機報告対応、trim後の拘束・寸法引き継ぎ)。
 * - ID維持: 残った区間のうち1つ(元の端点を含む側、両方残れば元p1側を優先)は元のtargetIdを引き継ぐ
 *   (assignPieceIds参照)。それ以外の新しい区間には新規IDを発行する。
 * - 端点参照(coincident/distance/fix/distancePointOrigin/distancePointLine/coincidentOriginのpoint)は、
 *   対象がtargetIdの場合、旧端点の座標(1e-6mm許容)に一致する新しい区間へ付け替える。一致する区間が
 *   無くなった(=その端点を含む区間が削除された)場合はその拘束を取り除く。
 * - segmentId/LineRef(segmentEdge)を直接参照する拘束(horizontal/vertical/radius/perpendicular/
 *   distanceLineLine/angleLineLine/distanceLineRefEdge/angleLineRefEdge/tangent[segment])は、
 *   プライマリ断片が元のIDを引き継ぐため書き換え不要でそのまま有効(radiusは断片化しても同じ円弧の
 *   半径を保つため長さ拘束と異なり削除しない)。
 * - length拘束(segmentId===targetId)は、区間分割(pieces.length>1)によって対象の長さの意味が変わる
 *   ため削除し、削除件数をremovedLengthConstraintCountで返す(呼び出し側が一時トースト表示に使う)。
 * targetIdが見つからない場合はsegments/constraintsをそのまま返す。
 */
export function trimSegmentWithConstraints(
  segments: SketchSegment[],
  constraints: SketchConstraint[],
  targetId: string,
  clickPoint: Point2,
  entities: SketchEntity[] = [],
): { segments: SketchSegment[]; constraints: SketchConstraint[]; removedLengthConstraintCount: number } {
  const split = splitTargetIntoPieces(segments, targetId, entities);
  if (!split) return { segments, constraints, removedLengthConstraintCount: 0 };
  const { target, others, pieces } = split;

  if (pieces.length <= 1) {
    // 分割不能(他セグメント・entities輪郭との有効な交点が無い)= セグメント全体を削除する。
    // このセグメントを参照していたlength拘束も対象が消えるため取り除き、件数を数える
    // (それ以外の拘束[coincident等]は既存の挙動通り、参照先を失っても配列には残す。
    // ソルバは参照解決できない拘束の残差項を単に持たないため実害はない)。
    let removedLength = 0;
    const nextConstraints = constraints.filter((c) => {
      if (c.kind === "length" && c.segmentId === targetId) {
        removedLength += 1;
        return false;
      }
      return true;
    });
    return { segments: others, constraints: nextConstraints, removedLengthConstraintCount: removedLength };
  }

  let removeIndex = 0;
  let bestDist = Infinity;
  pieces.forEach((piece, i) => {
    const d = distPointToSegmentShape(clickPoint, piece);
    if (d < bestDist) {
      bestDist = d;
      removeIndex = i;
    }
  });

  const keptPieces = assignPieceIds(target, pieces, removeIndex);
  const nextSegments = [...others, ...keptPieces];

  /** targetIdの旧端点を参照するPointRefを、座標一致(1e-6mm)する新しい区間へ付け替える。一致無しはnull。 */
  const reassignPoint = (ref: PointRef): PointRef | null => {
    if (ref.segmentId !== targetId) return ref;
    const oldPoint = ref.end === "p1" ? target.p1 : target.p2;
    for (const piece of keptPieces) {
      if (distPts(piece.p1, oldPoint) <= TRIM_POINT_EPS) return { segmentId: piece.id, end: "p1" };
      if (distPts(piece.p2, oldPoint) <= TRIM_POINT_EPS) return { segmentId: piece.id, end: "p2" };
    }
    return null;
  };

  let removedLength = 0;
  const nextConstraints: SketchConstraint[] = [];
  for (const c of constraints) {
    if (c.kind === "length" && c.segmentId === targetId) {
      removedLength += 1;
      continue;
    }
    if (c.kind === "coincident") {
      const a = reassignPoint(c.a);
      const b = reassignPoint(c.b);
      if (!a || !b) continue;
      nextConstraints.push({ ...c, a, b });
      continue;
    }
    if (c.kind === "distance") {
      const a = reassignPoint(c.a);
      const b = reassignPoint(c.b);
      if (!a || !b) continue;
      nextConstraints.push({ ...c, a, b });
      continue;
    }
    if (c.kind === "fix") {
      const point = reassignPoint(c.point);
      if (!point) continue;
      nextConstraints.push({ ...c, point });
      continue;
    }
    if (c.kind === "distancePointOrigin") {
      const point = reassignPoint(c.point);
      if (!point) continue;
      nextConstraints.push({ ...c, point });
      continue;
    }
    if (c.kind === "distancePointLine") {
      const point = reassignPoint(c.point);
      if (!point) continue;
      // c.line(segmentEdgeでtargetIdを指す場合も含む)はプライマリ断片が元IDを継ぐため書き換え不要。
      nextConstraints.push({ ...c, point });
      continue;
    }
    if (c.kind === "coincidentOrigin" && isPointRefTo(c.point, targetId)) {
      const point = reassignPoint(c.point);
      if (!point) continue;
      nextConstraints.push({ ...c, point });
      continue;
    }
    // segmentId/LineRef直接参照(horizontal/vertical/radius/perpendicular/distanceLineLine/
    // angleLineLine/distanceLineRefEdge/angleLineRefEdge/tangent[segment]、coincidentOriginの
    // point[EntityRef版]、その他entityのみを参照する拘束)は、プライマリ断片が元のsegmentIdを
    // 引き継ぐため書き換えなしでそのまま有効。
    nextConstraints.push(c);
  }

  // Fix2(Phase 36): トリムで新しく生じた断点(interior split boundary。元のtarget.p1/p2そのものは
  // 対象外)それぞれに、座標一致する他の端点(残った断片自身の別の端も含む。他の断片・others両方)が
  // あればcoincident拘束を自動付与する(reassignPointによる「既存拘束の付け替え」とは独立の処理: こちらは
  // 元々存在しなかった新規のcoincidentを追加する)。keptPiecesはpiecesのうちremoveIndexを除いた順序を
  // 保つため、元のインデックス(origIndex)と対応付けて「区間境界(0でもlength-1でもない側)」を判定する。
  const keptOriginalIndexes = pieces.map((_, i) => i).filter((i) => i !== removeIndex);
  const cutPoints: EndpointCandidate[] = [];
  keptPieces.forEach((piece, k) => {
    const origIndex = keptOriginalIndexes[k];
    if (origIndex > 0) cutPoints.push({ ref: { segmentId: piece.id, end: "p1" }, point: piece.p1 });
    if (origIndex < pieces.length - 1) cutPoints.push({ ref: { segmentId: piece.id, end: "p2" }, point: piece.p2 });
  });
  const poolCandidates = [...endpointCandidates(keptPieces), ...endpointCandidates(others)];
  nextConstraints.push(...coincidentsForCutPoints(cutPoints, poolCandidates, nextConstraints));

  return { segments: nextSegments, constraints: nextConstraints, removedLengthConstraintCount: removedLength };
}

/** 点pからentity(rectangle/circle/polygon/slot/regularPolygon)の輪郭への最短距離(explodeEntity()によるポリライン近似)。CadViewerのトリムホバー対象選定に使う。 */
export function distPointToEntityShape(p: Point2, entity: SketchEntity): number {
  let best = Infinity;
  for (const seg of explodeEntity(entity)) {
    best = Math.min(best, distPointToSegmentShape(p, seg));
  }
  return best;
}

/**
 * entityId のエンティティ(rectangle/circle/polygon/slot/regularPolygon)を explodeEntity() で
 * 一時的に自由セグメント列へ分解し、その各分解片ごとに、既存segments+他エンティティ境界との
 * 交点で「区間」に分割する(トリムの削除候補選定・実削除の両方の土台)。findClosestSegmentPiece()と
 * 同じ「分解した仮セグメント列+既存segments+他エンティティ境界」を対象にsplitTargetIntoPieces()を
 * 分解片1つずつに適用する。entityIdが見つからない場合はnull。
 */
function explodeEntityIntoPieceGroups(
  entities: SketchEntity[],
  entityId: string,
  segments: SketchSegment[],
): SketchSegment[][] | null {
  const target = entities.find((e) => e.id === entityId);
  if (!target) return null;
  const exploded = explodeEntity(target);
  const otherEntities = entities.filter((e) => e.id !== entityId);
  const tempSegments = [...exploded, ...segments];
  return exploded.map((piece) => {
    const split = splitTargetIntoPieces(tempSegments, piece.id, otherEntities);
    return split ? split.pieces : [piece];
  });
}

/**
 * entityId のエンティティ上、point(ローカル2D、mm)に最も近い「区間」を返す(トリムのホバー
 * プレビュー用、円/矩形/多角形/スロット/正多角形の輪郭をトリム対象にできるようにする、Phase 24)。
 * entityIdが見つからない場合はnull。
 */
export function findClosestEntityPiece(
  entities: SketchEntity[],
  entityId: string,
  segments: SketchSegment[],
  point: Point2,
): SketchSegment | null {
  const groups = explodeEntityIntoPieceGroups(entities, entityId, segments);
  if (!groups) return null;
  let best: SketchSegment | null = null;
  let bestDist = Infinity;
  for (const pieces of groups) {
    for (const piece of pieces) {
      const d = distPointToSegmentShape(point, piece);
      if (d < bestDist) {
        bestDist = d;
        best = piece;
      }
    }
  }
  return best;
}

/**
 * entityId のエンティティを、clickPoint(ローカル2D、mm)に最も近い区間だけ取り除いた上で
 * segmentsへ分解する(トリムクリック時のentity対応、Phase 24)。対象entityはentitiesから削除され、
 * 残りの分解片(区間)が新しいsegmentsとして既存segmentsに追記される。App側はこれを1回の
 * ドキュメント更新(entities・segmentsの同時置き換え)として適用すればundo1回で戻せる。
 * entityIdが見つからない場合は元のentities/segmentsをそのまま返す。
 */
export function trimEntityAtPoint(
  entities: SketchEntity[],
  entityId: string,
  segments: SketchSegment[],
  clickPoint: Point2,
  constraints: SketchConstraint[] = [],
): { entities: SketchEntity[]; segments: SketchSegment[]; constraints: SketchConstraint[] } {
  const groups = explodeEntityIntoPieceGroups(entities, entityId, segments);
  if (!groups) return { entities, segments, constraints };
  let removeGroupIndex = -1;
  let removePieceIndex = -1;
  let bestDist = Infinity;
  groups.forEach((pieces, gi) => {
    pieces.forEach((piece, pi) => {
      const d = distPointToSegmentShape(clickPoint, piece);
      if (d < bestDist) {
        bestDist = d;
        removeGroupIndex = gi;
        removePieceIndex = pi;
      }
    });
  });
  const kept: SketchSegment[] = [];
  groups.forEach((pieces, gi) => {
    pieces.forEach((piece, pi) => {
      if (gi === removeGroupIndex && pi === removePieceIndex) return;
      kept.push(piece);
    });
  });
  const nextEntities = entities.filter((e) => e.id !== entityId);
  const nextSegments = [...segments, ...kept];

  // Fix2(Phase 36、ユーザー報告バグの根本原因の修正): entity(円等)は丸ごと新規の自由セグメント
  // 群(kept)に置き換わるため、kept の全端点が「トリムで新しく生じた断点」に相当する
  // (explodeEntity()の分解片同士が接する境界、および他セグメントとの交点の両方を含む)。
  // 既存segments(元からある自由な線分・円弧)の端点、およびkept同士の端点をプールとして
  // CUT_MATCH_EPS以内の座標一致を探し、無ければ何もしない(他方の曲線が通過するだけの交点=
  // point-on-curveはスコープ外)、あればcoincident拘束を自動付与する(重複は追加しない)。
  const cutPoints = endpointCandidates(kept);
  const poolCandidates = [...cutPoints, ...endpointCandidates(segments)];
  const nextConstraints = [...constraints, ...coincidentsForCutPoints(cutPoints, poolCandidates, constraints)];

  return { entities: nextEntities, segments: nextSegments, constraints: nextConstraints };
}
