// ボディ端面参照エッジ(Phase 22)のスナップショット追従ユーティリティ。ReactにもThree.jsにも
// Replicad(OCCT)にも依存しない純粋TypeScript(他のsrc/sketch/*.tsと同じ方針)。
//
// distanceEntityLine拘束のline(LineRef)が"refEdge"(ボディ端面参照のスナップショット)の場合、
// ボディ形状が変わる(押し出し寸法の変更・スケッチの再配置等)たびに worker から届く最新の
// referenceEdges(src/protocol/messages.ts)と幾何マッチングして、そのスナップショット(p1/p2)を
// 追従させる。マッチする候補が見つからない場合はスナップショットをそのまま維持する
// (既知の制限: 対応する辺が消えた/大きく変形した場合は追従できず、直前のスナップショットのまま
// 拘束が解かれ続ける)。
import type { CadDocument, SketchFeature } from "../model/types";
import type { ReferenceEdgeLine, ReferenceEdgeSet } from "../protocol/messages";
import { distancePointToLine } from "./positionDimensions";

/** マッチ判定の方向一致しきい値(cos値)。0.999 ≈ 約2.6度以内(evaluator.tsのFACE_NORMAL_COS_TOLERANCEと同じ基準)。 */
const DIRECTION_COS_THRESHOLD = 0.999;

/**
 * snapshot(既存のrefEdgeスナップショット)に最も近い候補をcandidatesから探す。
 * 候補は「方向(向き無視)がsnapshotとcosで一致度DIRECTION_COS_THRESHOLDを超える」ものに限り、
 * その中から「snapshotの両端点から候補の直線への垂直距離の平均」が最小のものを採用する。
 * 候補が無ければnull。
 */
function findBestMatch(snapshot: ReferenceEdgeLine, candidates: readonly ReferenceEdgeLine[]): ReferenceEdgeLine | null {
  const dx = snapshot.p2[0] - snapshot.p1[0];
  const dy = snapshot.p2[1] - snapshot.p1[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const ux = dx / len;
  const uy = dy / len;

  let best: ReferenceEdgeLine | null = null;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const cdx = candidate.p2[0] - candidate.p1[0];
    const cdy = candidate.p2[1] - candidate.p1[1];
    const clen = Math.hypot(cdx, cdy);
    if (clen < 1e-9) continue;
    const cux = cdx / clen;
    const cuy = cdy / clen;
    const cos = Math.abs(ux * cux + uy * cuy);
    if (cos <= DIRECTION_COS_THRESHOLD) continue;
    const d1 = distancePointToLine(snapshot.p1, candidate.p1, candidate.p2);
    const d2 = distancePointToLine(snapshot.p2, candidate.p1, candidate.p2);
    const dist = (d1 + d2) / 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

function sameLine(a: ReferenceEdgeLine, b: ReferenceEdgeLine): boolean {
  const close = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9;
  return close(a.p1, b.p1) && close(a.p2, b.p2);
}

/**
 * ドキュメント内の全sketchフィーチャーが持つdistanceEntityLine拘束(line.kind==="refEdge")の
 * スナップショットを、最新のreferenceEdges(worker評価応答)とマッチングして更新する。
 * マッチしない拘束・refEdge以外の拘束はそのまま(参照ごと)保つため、変更が無ければ
 * 呼び出し前のdocと同一の参照を返す(store側の不要な再レンダリングを避ける)。
 */
export function updateReferenceEdgeSnapshots(doc: CadDocument, referenceEdges: readonly ReferenceEdgeSet[]): CadDocument {
  if (referenceEdges.length === 0) return doc;
  const bySketch = new Map(referenceEdges.map((r) => [r.sketchId, r.edges]));
  let docChanged = false;

  const features = doc.features.map((feature) => {
    if (feature.type !== "sketch" || !feature.constraints || feature.constraints.length === 0) return feature;
    const candidates = bySketch.get(feature.id);
    if (!candidates || candidates.length === 0) return feature;

    let featureChanged = false;
    const nextConstraints = (feature as SketchFeature).constraints!.map((c) => {
      if (c.kind !== "distanceEntityLine" || c.line.kind !== "refEdge") return c;
      const match = findBestMatch(c.line, candidates);
      if (!match || sameLine(c.line, match)) return c;
      featureChanged = true;
      return { ...c, line: { kind: "refEdge" as const, p1: match.p1, p2: match.p2 } };
    });

    if (!featureChanged) return feature;
    docChanged = true;
    return { ...feature, constraints: nextConstraints };
  });

  if (!docChanged) return doc;
  return { ...doc, features };
}
