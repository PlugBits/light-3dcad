// 原点系拘束(distanceEntityOrigin/distancePointOrigin/coincidentOrigin)のoriginLocalスナップショットを
// 最新のsketchPlanes(worker評価応答)へ追従させる更新ユーティリティ(仕様変更対応)。
// src/sketch/referenceEdgeMatch.ts(refEdgeスナップショットの幾何マッチング追従)と同じ設計方針:
// 「原点」の定義は幾何マッチングではなく決定的な計算(ワールド原点をスケッチ平面へ投影)なので、
// マッチングではなく単純な再計算+差分比較で済む。
import type { CadDocument, SketchFeature } from "../model/types";
import type { SketchPlaneInfo } from "../protocol/messages";
import { worldOriginLocal } from "./originRef";

const SAME_LOCAL_EPS = 1e-9;

function sameLocal(a: [number, number] | undefined, b: [number, number]): boolean {
  if (!a) return false;
  return Math.abs(a[0] - b[0]) < SAME_LOCAL_EPS && Math.abs(a[1] - b[1]) < SAME_LOCAL_EPS;
}

/**
 * ドキュメント内の全sketchフィーチャーが持つ原点系拘束(distanceEntityOrigin/distancePointOrigin/
 * coincidentOrigin)のoriginLocalスナップショットを、最新のsketchPlanes(worker評価応答、そのスケッチの
 * 現在の平面基底)から再計算して更新する。対応するsketchPlanesエントリが無いスケッチ(面参照の解決に
 * 失敗した等)はそのまま(変更しない)。値が変わらなければ元のdoc参照をそのまま返す
 * (store側の不要な再レンダリングを避ける、updateReferenceEdgeSnapshotsと同じ配慮)。
 */
export function updateOriginSnapshots(doc: CadDocument, sketchPlanes: readonly SketchPlaneInfo[]): CadDocument {
  if (sketchPlanes.length === 0) return doc;
  const byId = new Map(sketchPlanes.map((p) => [p.sketchId, p]));
  let docChanged = false;

  const features = doc.features.map((feature) => {
    if (feature.type !== "sketch" || !feature.constraints || feature.constraints.length === 0) return feature;
    const plane = byId.get(feature.id);
    if (!plane) return feature;
    const originLocal = worldOriginLocal(plane);

    let featureChanged = false;
    const nextConstraints = (feature as SketchFeature).constraints!.map((c) => {
      if (c.kind !== "distanceEntityOrigin" && c.kind !== "distancePointOrigin" && c.kind !== "coincidentOrigin") return c;
      if (sameLocal(c.originLocal, originLocal)) return c;
      featureChanged = true;
      return { ...c, originLocal };
    });

    if (!featureChanged) return feature;
    docChanged = true;
    return { ...feature, constraints: nextConstraints };
  });

  if (!docChanged) return doc;
  return { ...doc, features };
}
