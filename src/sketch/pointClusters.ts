// 頂点ベースの寸法指定(Phase 30)の純粋ロジック。ReactにもThree.jsにもReplicad(OCCT)にも依存しない
// (src/sketch/entityEdges.ts等と同じ方針)。
//
// 一致(coincident)拘束で結ばれた端点群は、寸法ツール・拘束ツールでは「1つの頂点」として
// 扱いたい(ユーザーがどの端点をクリックしても、同じ拘束対象になるようにするため)。
// coincident拘束はソルバ側では端点をマージせず常に独立変数+残差として扱う設計(src/sketch/solver.ts
// 冒頭コメント参照)なので、代表点1つに対する拘束で数学的に等価(一致拘束が他の端点を連動させる)。
// このモジュールは「どの端点がどのクラスタに属し、代表点は何か」を計算する。
import type { PointRef, SketchConstraint, SketchSegment } from "../model/types";

/** PointRefをMapのキーに使う文字列表現(segmentIdは"-"区切りのIDでコロンを含まないため衝突しない)。 */
export function pointRefKey(ref: PointRef): string {
  return `${ref.segmentId}:${ref.end}`;
}

function keyToPointRef(key: string): PointRef {
  const idx = key.lastIndexOf(":");
  return { segmentId: key.slice(0, idx), end: key.slice(idx + 1) as "p1" | "p2" };
}

/**
 * segments(全端点)+constraints(coincident拘束)から、端点キー→クラスタ代表点(PointRef)の
 * マップを作る(Union-Find)。クラスタが1点のみ(coincidentで他と結ばれていない端点)は
 * マップに含めない(呼び出し側は「マップに無ければ自分自身が代表」として扱う想定)。
 * 代表点はクラスタに属する端点キーを文字列昇順(segmentId→end)でソートした先頭を採用する
 * (決定的: 同じクラスタなら常に同じ代表点になる)。
 */
export function buildPointClusterRepMap(
  segments: readonly SketchSegment[],
  constraints: readonly SketchConstraint[],
): Map<string, PointRef> {
  const parent = new Map<string, string>();
  const ensure = (key: string) => {
    if (!parent.has(key)) parent.set(key, key);
  };
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = key;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const seg of segments) {
    ensure(`${seg.id}:p1`);
    ensure(`${seg.id}:p2`);
  }
  for (const c of constraints) {
    if (c.kind !== "coincident") continue;
    const ka = pointRefKey(c.a);
    const kb = pointRefKey(c.b);
    ensure(ka);
    ensure(kb);
    union(ka, kb);
  }

  const groups = new Map<string, string[]>();
  for (const key of parent.keys()) {
    const root = find(key);
    const arr = groups.get(root);
    if (arr) arr.push(key);
    else groups.set(root, [key]);
  }

  const repByKey = new Map<string, PointRef>();
  for (const members of groups.values()) {
    if (members.length <= 1) continue;
    const sorted = [...members].sort();
    const rep = keyToPointRef(sorted[0]);
    for (const m of members) repByKey.set(m, rep);
  }
  return repByKey;
}

/** refが属するクラスタの代表点を返す(クラスタが無ければref自身)。 */
export function resolvePointClusterRepresentative(ref: PointRef, repMap: Map<string, PointRef>): PointRef {
  return repMap.get(pointRefKey(ref)) ?? ref;
}
