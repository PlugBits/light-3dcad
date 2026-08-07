// CadDocument に対する純粋な操作関数群。すべて非破壊(新しい CadDocument を返す)。
import { generateId } from "./id";
import { extendSegmentAtPoint, findExtensionTarget, type ExtendBoundary } from "../sketch/extend";
import { applySegmentCorner, findSharedEndpoint } from "../sketch/segmentCorner";
import { trimEntityAtPoint, trimSegmentWithConstraints, type Point2 } from "../sketch/trim";
import type {
  CadDocument,
  ExtrudeFeature,
  Feature,
  FeatureId,
  Fillet3DFeature,
  FilletEdgeRef,
  LineRef,
  MateFaceRef,
  MateFeature,
  PartInstanceFeature,
  PlaneRef,
  PolygonCorner,
  RevolveFeature,
  ShellFaceRef,
  ShellFeature,
  SketchConstraint,
  SketchEntity,
  SketchFeature,
  SketchSegment,
  ThreadFaceRef,
  ThreadFeature,
} from "./types";
import { validateFeature, type ValidationError } from "./validation";

export type { ValidationError } from "./validation";

/** 空のドキュメントを作成する。 */
export function createEmptyDocument(): CadDocument {
  return { version: 1, features: [] };
}

/** フィーチャーをドキュメント末尾に追加する。 */
export function addFeature(doc: CadDocument, feature: Feature): CadDocument {
  return { ...doc, features: [...doc.features, feature] };
}

/**
 * 新しいスケッチフィーチャーを作成して末尾に追加する。IDは自動生成される。
 * segments(Phase 19a)は省略可(後方互換。省略時は既存どおりentitiesのみのスケッチになる)。
 */
export function addSketchFeature(
  doc: CadDocument,
  params: { name: string; plane: PlaneRef; entities: SketchEntity[]; segments?: SketchSegment[] },
): { doc: CadDocument; feature: SketchFeature } {
  const feature: SketchFeature = {
    type: "sketch",
    id: generateId("sketch"),
    name: params.name,
    plane: params.plane,
    entities: params.entities,
    ...(params.segments ? { segments: params.segments } : {}),
  };
  return { doc: addFeature(doc, feature), feature };
}

/**
 * 新しい押し出しフィーチャーを作成して末尾に追加する。IDは自動生成される。
 * targetBodyId(Phase 27a複数ボディ対応)は省略可(省略時は評価時に「最後に作られたボディ」が
 * 自動的に対象になる。operation:"newBody"のときは無視される)。
 */
export function addExtrudeFeature(
  doc: CadDocument,
  params: {
    name: string;
    sketchId: FeatureId;
    distance: number;
    direction: 1 | -1;
    operation: ExtrudeFeature["operation"];
    targetBodyId?: FeatureId;
  },
): { doc: CadDocument; feature: ExtrudeFeature } {
  const feature: ExtrudeFeature = {
    type: "extrude",
    id: generateId("extrude"),
    name: params.name,
    sketchId: params.sketchId,
    distance: params.distance,
    direction: params.direction,
    operation: params.operation,
    ...(params.targetBodyId !== undefined ? { targetBodyId: params.targetBodyId } : {}),
  };
  return { doc: addFeature(doc, feature), feature };
}

/** 新しい3Dフィレット/面取りフィーチャーを作成して末尾に追加する。IDは自動生成される(Phase 25a)。 */
export function addFillet3DFeature(
  doc: CadDocument,
  params: { name: string; kind: "fillet" | "chamfer"; size: number; edges: FilletEdgeRef[] },
): { doc: CadDocument; feature: Fillet3DFeature } {
  const feature: Fillet3DFeature = {
    type: "fillet3d",
    id: generateId("fillet3d"),
    name: params.name,
    kind: params.kind,
    size: params.size,
    edges: params.edges,
  };
  return { doc: addFeature(doc, feature), feature };
}

/**
 * fillet3d フィーチャーの一部フィールド(name, size)を更新する。edges(対象エッジ)の差し替えは
 * replaceFillet3DEdges()を使う(kindの変更は非対応、削除して作り直す運用のまま)。
 */
export function patchFillet3DFeature(
  doc: CadDocument,
  featureId: FeatureId,
  patch: Partial<Pick<Fillet3DFeature, "name" | "size">>,
): CadDocument {
  return updateFeature<Fillet3DFeature>(doc, featureId, (f) => ({ ...f, ...patch }));
}

/**
 * fillet3d フィーチャーの対象エッジ(edges)スナップショットを丸ごと差し替える(Phase 29b、
 * 参照切れ時の再選択UI)。ビューアのエッジ選択ツール(startEdgeSelectTool)で選び直した
 * FilletEdgeRef配列をそのまま渡す想定。純粋な置き換え操作のみ行い、幾何マッチング・
 * 空配列チェック等は呼び出し側(App.tsx、ツールの「適用」ボタン)の責務とする。
 */
export function replaceFillet3DEdges(doc: CadDocument, featureId: FeatureId, edges: FilletEdgeRef[]): CadDocument {
  return updateFeature<Fillet3DFeature>(doc, featureId, (f) => ({ ...f, edges }));
}

/** 新しいシェル(中抜き)フィーチャーを作成して末尾に追加する。IDは自動生成される(Phase 25b)。 */
export function addShellFeature(
  doc: CadDocument,
  params: { name: string; thickness: number; faces: ShellFaceRef[] },
): { doc: CadDocument; feature: ShellFeature } {
  const feature: ShellFeature = {
    type: "shell",
    id: generateId("shell"),
    name: params.name,
    thickness: params.thickness,
    faces: params.faces,
  };
  return { doc: addFeature(doc, feature), feature };
}

/**
 * shell フィーチャーの一部フィールド(name, thickness)を更新する。faces(対象面)の差し替えは
 * replaceShellFaces()を使う。
 */
export function patchShellFeature(
  doc: CadDocument,
  featureId: FeatureId,
  patch: Partial<Pick<ShellFeature, "name" | "thickness">>,
): CadDocument {
  return updateFeature<ShellFeature>(doc, featureId, (f) => ({ ...f, ...patch }));
}

/**
 * shell フィーチャーの開口面(faces)スナップショットを丸ごと差し替える(Phase 29b、
 * 参照切れ時の再選択UI)。ビューアの面選択ツール(startFaceSelectTool)で選び直した
 * ShellFaceRef配列をそのまま渡す想定。
 */
export function replaceShellFaces(doc: CadDocument, featureId: FeatureId, faces: ShellFaceRef[]): CadDocument {
  return updateFeature<ShellFeature>(doc, featureId, (f) => ({ ...f, faces }));
}

/**
 * 新しい回転体(Revolve)フィーチャーを作成して末尾に追加する。IDは自動生成される(Phase 25b)。
 * targetBodyId(Phase 27a複数ボディ対応)はaddExtrudeFeature()と同じ意味(省略可)。
 */
export function addRevolveFeature(
  doc: CadDocument,
  params: {
    name: string;
    sketchId: FeatureId;
    axis: "x" | "y";
    angle: number;
    operation: RevolveFeature["operation"];
    targetBodyId?: FeatureId;
  },
): { doc: CadDocument; feature: RevolveFeature } {
  const feature: RevolveFeature = {
    type: "revolve",
    id: generateId("revolve"),
    name: params.name,
    sketchId: params.sketchId,
    axis: params.axis,
    angle: params.angle,
    operation: params.operation,
    ...(params.targetBodyId !== undefined ? { targetBodyId: params.targetBodyId } : {}),
  };
  return { doc: addFeature(doc, feature), feature };
}

/** revolve フィーチャーの一部フィールドを更新する。 */
export function patchRevolveFeature(
  doc: CadDocument,
  featureId: FeatureId,
  patch: Partial<Pick<RevolveFeature, "name" | "sketchId" | "axis" | "angle" | "operation" | "targetBodyId">>,
): CadDocument {
  return updateFeature<RevolveFeature>(doc, featureId, (f) => ({ ...f, ...patch }));
}

/** 新しいねじフィーチャーを作成して末尾に追加する。IDは自動生成される(Phase 25c)。 */
export function addThreadFeature(
  doc: CadDocument,
  params: {
    name: string;
    hand: ThreadFeature["hand"];
    preset: ThreadFeature["preset"];
    length: number;
    face: ThreadFaceRef;
    position: [number, number];
    direction: 1 | -1;
  },
): { doc: CadDocument; feature: ThreadFeature } {
  const feature: ThreadFeature = {
    type: "thread",
    id: generateId("thread"),
    name: params.name,
    hand: params.hand,
    preset: params.preset,
    length: params.length,
    face: params.face,
    position: params.position,
    direction: params.direction,
  };
  return { doc: addFeature(doc, feature), feature };
}

/**
 * thread フィーチャーの一部フィールド(name, preset, length, hand)を更新する。face/positionの
 * 差し替えはreplaceThreadPlacement()を使う。
 */
export function patchThreadFeature(
  doc: CadDocument,
  featureId: FeatureId,
  patch: Partial<Pick<ThreadFeature, "name" | "preset" | "length" | "hand">>,
): CadDocument {
  return updateFeature<ThreadFeature>(doc, featureId, (f) => ({ ...f, ...patch }));
}

/**
 * thread フィーチャーの配置面・位置(face, position)を丸ごと差し替える(Phase 29b、
 * 参照切れ時の再選択UI)。ビューアのねじ配置ツール(startThreadPlaceTool)が確定した
 * ThreadPlaceRefから作ったface/positionを渡す想定。direction(雄雌に対する法線方向)は
 * 既存のまま維持する(面が変わっても雄雌の関係自体は変わらないため)。
 */
export function replaceThreadPlacement(
  doc: CadDocument,
  featureId: FeatureId,
  patch: { face: ThreadFaceRef; position: [number, number] },
): CadDocument {
  return updateFeature<ThreadFeature>(doc, featureId, (f) => ({ ...f, face: patch.face, position: patch.position }));
}

/**
 * 新しい部品配置(簡易アセンブリ)フィーチャーを作成して末尾に追加する。IDは自動生成される(Phase 27b)。
 * params.part は既に(deserializeProject()等で)検証済みの部品CadDocumentを渡すこと。
 * このヘルパー自体は入れ子チェック等のバリデーションを行わない(呼び出し側=UIで事前チェックし、
 * 保存/読み込み時はvalidateFeature()が最終的な整合性を保証する)。
 */
export function addPartInstanceFeature(
  doc: CadDocument,
  params: { name: string; part: CadDocument; position: [number, number, number]; rotation: [number, number, number] },
): { doc: CadDocument; feature: PartInstanceFeature } {
  const feature: PartInstanceFeature = {
    type: "partInstance",
    id: generateId("partInstance"),
    name: params.name,
    part: params.part,
    position: params.position,
    rotation: params.rotation,
  };
  return { doc: addFeature(doc, feature), feature };
}

/**
 * partInstance フィーチャーの一部フィールド(name, position, rotation)を更新する(Phase 27b)。
 * part(埋め込み部品データ)自体はv1では編集不可(再配置=削除して作り直す運用)のため対象外。
 */
export function patchPartInstanceFeature(
  doc: CadDocument,
  featureId: FeatureId,
  patch: Partial<Pick<PartInstanceFeature, "name" | "position" | "rotation">>,
): CadDocument {
  return updateFeature<PartInstanceFeature>(doc, featureId, (f) => ({ ...f, ...patch }));
}

/**
 * 新しい合致(メイト、Phase 28c)フィーチャーを作成して末尾に追加する。IDは自動生成される。
 * valueはkind:"distance"のときのみ渡す(coincident/concentricでは無視される想定。
 * evaluator.ts側もkind:"distance"のときのみfeature.valueを参照する)。
 */
export function addMateFeature(
  doc: CadDocument,
  params: { name: string; kind: MateFeature["kind"]; value?: number; a: MateFaceRef; b: MateFaceRef },
): { doc: CadDocument; feature: MateFeature } {
  const feature: MateFeature = {
    type: "mate",
    id: generateId("mate"),
    name: params.name,
    kind: params.kind,
    a: params.a,
    b: params.b,
    ...(params.value !== undefined ? { value: params.value } : {}),
  };
  return { doc: addFeature(doc, feature), feature };
}

/**
 * mate フィーチャーの一部フィールド(name, value)を更新する(Phase 28c)。a/b(対象面)の
 * 差し替えはreplaceMateFaces()を使う(Phase 29b)。kindの変更は非対応(削除して作り直す運用のまま)。
 */
export function patchMateFeature(
  doc: CadDocument,
  featureId: FeatureId,
  patch: Partial<Pick<MateFeature, "name" | "value">>,
): CadDocument {
  return updateFeature<MateFeature>(doc, featureId, (f) => ({ ...f, ...patch }));
}

/**
 * 指定の合致(メイト)フィーチャーより後ろに、ボディを直接変更するextrude/revolve
 * (operation:"add"|"cut")があるかどうかを判定する(Phase 29a、堅牢性強化)。
 * 合致は全フィーチャー評価後にまとめて解く(src/worker/evaluator.tsのevaluateFeatures()参照)ため、
 * 合致より後ろのcut/add操作は合致で解決される前の(未解決の)配置を基準に行われるという既知の制限がある
 * (docs/PLAN.md Phase 28c節)。エラーにはせず、UI側(FeatureTree・MateEditor)が注意アイコン+
 * ツールチップで知らせるためだけに使う純粋関数(newBodyは独立した新規ボディを作るだけで既存ボディの
 * 配置に依存しないため対象外)。
 */
export function mateHasSubsequentBodyEdit(doc: CadDocument, mateFeatureId: FeatureId): boolean {
  const index = doc.features.findIndex((f) => f.id === mateFeatureId);
  if (index === -1) return false;
  for (let i = index + 1; i < doc.features.length; i += 1) {
    const f = doc.features[i];
    if ((f.type === "extrude" || f.type === "revolve") && (f.operation === "add" || f.operation === "cut")) {
      return true;
    }
  }
  return false;
}

/**
 * mate フィーチャーが参照する2つの面(a, b)を丸ごと差し替える(Phase 29b、参照切れ時の再選択UI)。
 * ビューアの合致ツール(startMateTool)で選び直した2面をApp.tsxのtoMateFaceRef()で変換した
 * MateFaceRefをそのまま渡す想定。kind(一致/距離/同軸)は既存のまま維持する。
 */
export function replaceMateFaces(doc: CadDocument, featureId: FeatureId, patch: { a: MateFaceRef; b: MateFaceRef }): CadDocument {
  return updateFeature<MateFeature>(doc, featureId, (f) => ({ ...f, a: patch.a, b: patch.b }));
}

/** 指定IDのフィーチャーを探す。見つからなければ undefined。 */
export function findFeature(doc: CadDocument, featureId: FeatureId): Feature | undefined {
  return doc.features.find((f) => f.id === featureId);
}

/**
 * 指定IDのフィーチャーを updater で置き換える。フィーチャーが存在しない場合は元のドキュメントをそのまま返す。
 * updater は同じ type を維持したまま新しいフィーチャーを返すこと。
 */
export function updateFeature<T extends Feature>(
  doc: CadDocument,
  featureId: FeatureId,
  updater: (feature: T) => T,
): CadDocument {
  let changed = false;
  const features = doc.features.map((f) => {
    if (f.id !== featureId) return f;
    changed = true;
    return updater(f as T);
  });
  if (!changed) return doc;
  return { ...doc, features };
}

/** extrude フィーチャーの一部フィールドを更新する。 */
export function patchExtrudeFeature(
  doc: CadDocument,
  featureId: FeatureId,
  patch: Partial<Pick<ExtrudeFeature, "name" | "sketchId" | "distance" | "direction" | "operation" | "targetBodyId">>,
): CadDocument {
  return updateFeature<ExtrudeFeature>(doc, featureId, (f) => ({ ...f, ...patch }));
}

/** sketch フィーチャー自体の一部フィールド(name, plane)を更新する。 */
export function patchSketchFeature(
  doc: CadDocument,
  featureId: FeatureId,
  patch: Partial<Pick<SketchFeature, "name" | "plane">>,
): CadDocument {
  return updateFeature<SketchFeature>(doc, featureId, (f) => ({ ...f, ...patch }));
}

/**
 * sketch フィーチャーのsegments/entitiesを丸ごと差し替える(スケッチジオメトリのドラッグ編集、
 * Phase 34)。CadViewer側で solveSketch(...,{dragTarget}) を解いた結果をそのまま渡す想定
 * (updateSketchEntity()のような部分パッチではなく、ドラッグで動いた可能性のある全セグメント/
 * エンティティをまとめて置き換える)。省略したフィールドは変更しない。
 */
export function updateSketchGeometry(
  doc: CadDocument,
  sketchId: FeatureId,
  patch: Partial<Pick<SketchFeature, "segments" | "entities">>,
): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (f) => ({ ...f, ...patch }));
}

/** sketch 内の1エンティティを部分更新する(kind は変更しない)。 */
export function updateSketchEntity(
  doc: CadDocument,
  sketchId: FeatureId,
  entityId: string,
  patch: Partial<SketchEntity>,
): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({
    ...sketch,
    entities: sketch.entities.map((entity) =>
      entity.id === entityId ? ({ ...entity, ...patch } as SketchEntity) : entity,
    ),
  }));
}

/**
 * polygonエンティティの1頂点(vertexIndex)のコーナー指定(fillet/chamfer/null)を設定する。
 * entity.corners が未設定の場合は points と同じ長さのnull配列から始める。
 * entity が見つからない・polygonでない・vertexIndexが範囲外の場合は元のドキュメントをそのまま返す。
 */
export function setPolygonVertexCorner(
  doc: CadDocument,
  sketchId: FeatureId,
  entityId: string,
  vertexIndex: number,
  corner: PolygonCorner,
): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({
    ...sketch,
    entities: sketch.entities.map((entity) => {
      if (entity.id !== entityId || entity.kind !== "polygon") return entity;
      if (vertexIndex < 0 || vertexIndex >= entity.points.length) return entity;
      const nextCorners: PolygonCorner[] = entity.corners
        ? entity.corners.slice()
        : entity.points.map(() => null);
      while (nextCorners.length < entity.points.length) nextCorners.push(null);
      nextCorners[vertexIndex] = corner;
      return { ...entity, corners: nextCorners };
    }),
  }));
}

/**
 * rectangleエンティティを同寸法のpolygonエンティティ(4頂点、コーナー未指定)へ変換する
 * (フィレット/面取りツールでrectangleの角をクリックしたときの下準備、Phase 24)。頂点順序は
 * src/sketch/explode.tsのexplodeRectangle()・src/sketch/entityEdges.tsのrectangleEdgePoints()と
 * 同じ(下辺左→下辺右→上辺右→上辺左、反時計回り)。idは維持する(参照切れを避けるため)。
 * entity が見つからない・rectangleでない場合は元のドキュメントをそのまま返す。
 */
export function convertRectangleToPolygon(doc: CadDocument, sketchId: FeatureId, entityId: string): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({
    ...sketch,
    entities: sketch.entities.map((entity) => {
      if (entity.id !== entityId || entity.kind !== "rectangle") return entity;
      const [cx, cy] = entity.center;
      const hw = entity.width / 2;
      const hh = entity.height / 2;
      const points: [number, number][] = [
        [cx - hw, cy - hh],
        [cx + hw, cy - hh],
        [cx + hw, cy + hh],
        [cx - hw, cy + hh],
      ];
      return { kind: "polygon", id: entity.id, points };
    }),
  }));
}

/**
 * 2本の自由な線分セグメント(共有端点を持つ)にフィレット/面取りを適用する(Phase 24)。
 * 実際の幾何計算は src/sketch/segmentCorner.ts の applySegmentCorner()。適用不可(円弧が絡む・
 * サイズ過大等)の場合は元のドキュメントをそのまま返す。
 */
export function applySegmentCornerToSketch(
  doc: CadDocument,
  sketchId: FeatureId,
  aSegmentId: string,
  bSegmentId: string,
  kind: "fillet" | "chamfer",
  size: number,
): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => {
    const segments = sketch.segments ?? [];
    const a = segments.find((s) => s.id === aSegmentId);
    const b = segments.find((s) => s.id === bSegmentId);
    if (!a || !b) return sketch;
    const result = applySegmentCorner(a, b, kind, size);
    if (!result) return sketch;
    const nextSegments = segments.map((s) => {
      if (s.id === aSegmentId) return result.a;
      if (s.id === bSegmentId) return result.b;
      return s;
    });
    nextSegments.push(result.corner);

    // a・bが共有していた元の端点を結んでいたcoincident拘束は、フィレット/面取りで両端点が
    // 接点まで短縮されて別の座標になるため、そのまま残すと次のソルバ実行時に接点が元の角の
    // 位置へ引き戻されて円弧が破綻する(隣接する角を連続でフィレットしたときに顕著)。
    // 元のcoincidentを削除し、代わりに「a接点↔挿入セグメント始端」「挿入セグメント末端↔b接点」の
    // coincidentを付け直す(buildAutoConstraintsForChainが線分描画確定時に付与する形式と同じ)。
    const shared = findSharedEndpoint(a, b);
    let nextConstraints = sketch.constraints ?? [];
    if (shared) {
      const { aEnd, bEnd } = shared;
      nextConstraints = nextConstraints.filter((c) => {
        if (c.kind !== "coincident") return true;
        const linksSharedPair =
          (c.a.segmentId === aSegmentId && c.a.end === aEnd && c.b.segmentId === bSegmentId && c.b.end === bEnd) ||
          (c.b.segmentId === aSegmentId && c.b.end === aEnd && c.a.segmentId === bSegmentId && c.a.end === bEnd);
        return !linksSharedPair;
      });
      nextConstraints = [
        ...nextConstraints,
        {
          id: generateId("constraint"),
          kind: "coincident",
          a: { segmentId: aSegmentId, end: aEnd },
          b: { segmentId: result.corner.id, end: "p1" },
        },
        {
          id: generateId("constraint"),
          kind: "coincident",
          a: { segmentId: result.corner.id, end: "p2" },
          b: { segmentId: bSegmentId, end: bEnd },
        },
      ];
    }

    return { ...sketch, segments: nextSegments, constraints: nextConstraints };
  });
}

/**
 * entityId のエンティティ(rectangle/circle/polygon/slot/regularPolygon)を、clickPoint(ローカル2D、
 * mm)に最も近い区間だけ削除した上でsegmentsへ分解する(トリムツールのentity対応、Phase 24)。
 * 実際の幾何計算は src/sketch/trim.ts の trimEntityAtPoint()。entities・segmentsの置き換えを
 * 1回のフィーチャー更新にまとめることで、undo1回で元に戻せるようにする。
 */
export function trimSketchEntityAtPoint(doc: CadDocument, sketchId: FeatureId, entityId: string, clickPoint: Point2): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => {
    const result = trimEntityAtPoint(sketch.entities, entityId, sketch.segments ?? [], clickPoint);
    return { ...sketch, entities: result.entities, segments: result.segments };
  });
}

/**
 * targetId のセグメント(自由な線分・円弧、entity由来ではない)を、clickPoint(ローカル2D、mm)に
 * 最も近い区間だけ削除する(実機報告対応、Phase 31a)。src/sketch/trim.ts の
 * trimSegmentWithConstraints() が、削除で生じる断片へのID引き継ぎ・拘束の付け替え(座標一致)・
 * 意味が変わるlength拘束の削除を一括して行う。segments・constraintsの置き換えを1回のフィーチャー
 * 更新にまとめることで、undo1回で元に戻せるようにする。
 * removedLengthConstraintCount(削除されたlength拘束の件数)は呼び出し側(App.tsx)が一時トースト
 * 表示に使う。sketchIdが見つからない場合は元のドキュメント・件数0をそのまま返す。
 */
export function trimSketchSegmentAtPoint(
  doc: CadDocument,
  sketchId: FeatureId,
  targetId: string,
  clickPoint: Point2,
): { doc: CadDocument; removedLengthConstraintCount: number } {
  const feature = findFeature(doc, sketchId);
  if (!feature || feature.type !== "sketch") return { doc, removedLengthConstraintCount: 0 };
  const result = trimSegmentWithConstraints(feature.segments ?? [], feature.constraints ?? [], targetId, clickPoint, feature.entities ?? []);
  const nextDoc = updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({
    ...sketch,
    segments: result.segments,
    constraints: result.constraints,
  }));
  return { doc: nextDoc, removedLengthConstraintCount: result.removedLengthConstraintCount };
}

/**
 * 実測寸法(entities由来、SketchDimension)の寸法ラベルのドラッグ移動オフセット(Phase 31a)を
 * sketch.dimensionOffsetsへ設定する。keyはsrc/sketch/dimensions.tsのdimensionKey()と同じ形式。
 */
export function setDimensionOffset(doc: CadDocument, sketchId: FeatureId, key: string, offset: [number, number]): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({
    ...sketch,
    dimensionOffsets: { ...(sketch.dimensionOffsets ?? {}), [key]: offset },
  }));
}

/**
 * 拘束由来の寸法(ConstraintDimension)の寸法ラベルのドラッグ移動オフセット(Phase 31a)を、
 * 該当拘束(constraintId)のlabelOffsetフィールドへ設定する。該当拘束が見つからない場合は
 * 元のドキュメントと等価な新しいドキュメントを返す(updateFeatureのmap内で変化なし)。
 */
export function setConstraintLabelOffset(doc: CadDocument, sketchId: FeatureId, constraintId: string, offset: [number, number]): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({
    ...sketch,
    constraints: (sketch.constraints ?? []).map((c) => (c.id === constraintId ? ({ ...c, labelOffset: offset } as SketchConstraint) : c)),
  }));
}

/** sketch に1エンティティを追加する。 */
export function addSketchEntity(doc: CadDocument, sketchId: FeatureId, entity: SketchEntity): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({
    ...sketch,
    entities: [...sketch.entities, entity],
  }));
}

/** sketch から1エンティティを削除する。 */
export function removeSketchEntity(doc: CadDocument, sketchId: FeatureId, entityId: string): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({
    ...sketch,
    entities: sketch.entities.filter((entity) => entity.id !== entityId),
  }));
}

/** LineRefがtargetId(segmentId/entityId)を参照しているか判定する(constraintReferencesId()のヘルパー)。 */
function lineRefReferencesId(line: LineRef, targetId: string): boolean {
  if (line.kind === "entityEdge") return line.entityId === targetId;
  if (line.kind === "segmentEdge") return line.segmentId === targetId;
  return false; // refEdge: ピック時点のスナップショット座標のみを持ち、生きたidを参照しない。
}

/**
 * 拘束cがsegments/entitiesのid(targetId)を参照しているか判定する(個別削除のカスケード用の
 * 純粋関数、実機報告対応Phase 32②)。segmentIdとentityIdは別々の名前空間だが、generateId()で
 * 採番されるため衝突しない前提で1つのtargetIdとして扱える。SketchConstraintの全種別を網羅する
 * (switchがconstraint.kindで分岐し尽くしていない場合はTypeScriptの型チェックでnever型エラーに
 * なるため、新しい拘束種別を追加した際にここの更新漏れがコンパイル時に検出される)。
 */
export function constraintReferencesId(constraint: SketchConstraint, targetId: string): boolean {
  switch (constraint.kind) {
    case "coincident":
      return constraint.a.segmentId === targetId || constraint.b.segmentId === targetId;
    case "horizontal":
    case "vertical":
    case "length":
    case "radius":
    case "distanceLineRefEdge":
    case "angleLineRefEdge":
      return constraint.segmentId === targetId;
    case "distance":
      return constraint.a.segmentId === targetId || constraint.b.segmentId === targetId;
    case "fix":
      return constraint.point.segmentId === targetId;
    case "distanceEntityOrigin":
    case "fixEntity":
      return constraint.entity.entityId === targetId;
    case "distancePointOrigin":
      return constraint.point.segmentId === targetId;
    case "coincidentOrigin":
      return "segmentId" in constraint.point ? constraint.point.segmentId === targetId : constraint.point.entityId === targetId;
    case "distanceEntityEntity":
    case "concentric":
      return constraint.a.entityId === targetId || constraint.b.entityId === targetId;
    case "distanceEntityLine":
      return constraint.entity.entityId === targetId || lineRefReferencesId(constraint.line, targetId);
    case "distancePointLine":
      return constraint.point.segmentId === targetId || lineRefReferencesId(constraint.line, targetId);
    case "perpendicular":
    case "distanceLineLine":
    case "angleLineLine":
      return constraint.a === targetId || constraint.b === targetId;
    case "tangent":
      return (
        constraint.entity.entityId === targetId ||
        (constraint.target.kind === "segment" ? constraint.target.segmentId === targetId : constraint.target.entityId === targetId)
      );
    default: {
      const exhaustive: never = constraint;
      return exhaustive;
    }
  }
}

/**
 * sketchからsegments/entitiesいずれかの1件(id指定、種類は自動判定)を削除し、それを参照する
 * 拘束(coincident/tangent/length等)も同時に削除する(個別削除・実機報告対応、Phase 32②)。
 * SketchEditorのセグメント一覧の削除ボタン、およびビューア直接選択+Deleteキーの両方から使う
 * 共通実装。idがsegments/entitiesのどちらにも見つからなければdocをそのまま返す
 * (removedConstraintCount: 0)。戻り値のremovedConstraintCountは呼び出し側の一時トースト
 * (「関連する拘束N件も削除しました」)に使う。
 */
export function removeSketchElementCascade(
  doc: CadDocument,
  sketchId: FeatureId,
  id: string,
): { doc: CadDocument; removedConstraintCount: number } {
  const sketch = findFeature(doc, sketchId);
  if (!sketch || sketch.type !== "sketch") return { doc, removedConstraintCount: 0 };
  const isSegment = (sketch.segments ?? []).some((s) => s.id === id);
  const isEntity = sketch.entities.some((e) => e.id === id);
  if (!isSegment && !isEntity) return { doc, removedConstraintCount: 0 };

  const constraints = sketch.constraints ?? [];
  const removedConstraintCount = constraints.filter((c) => constraintReferencesId(c, id)).length;
  const nextConstraints = constraints.filter((c) => !constraintReferencesId(c, id));

  const nextDoc = updateFeature<SketchFeature>(doc, sketchId, (s) => ({
    ...s,
    segments: isSegment ? (s.segments ?? []).filter((seg) => seg.id !== id) : s.segments,
    entities: isEntity ? s.entities.filter((e) => e.id !== id) : s.entities,
    constraints: nextConstraints,
  }));
  return { doc: nextDoc, removedConstraintCount };
}

/** sketch の自由な線分・円弧セグメント(Phase 19a)配列を丸ごと置き換える(Phase 19b)。 */
export function setSketchSegments(doc: CadDocument, sketchId: FeatureId, segments: SketchSegment[]): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({ ...sketch, segments }));
}

/**
 * targetId のセグメント(直線のみ)を、clickPoint(ローカル2D、mm)に近い側の端点について、その線分を
 * 通る無限直線上で最初に交わる境界(他のsegments・entities輪郭・任意のreferenceEdges)まで延長する
 * (延長ツール、Phase 31b。実際の幾何計算はsrc/sketch/extend.ts)。延長対象が見つからない場合
 * (交わる境界が無い・targetIdが見つからない・targetが円弧)はdocをそのまま返し、
 * removedCoincidentConstraintはfalseになる。
 * 延長で動く端点に一致(coincident)拘束が付いている場合、そのまま延長すると拘束と矛盾しうるため
 * 拘束を削除してから延長する(removedCoincidentConstraint:trueをApp側のトースト通知に使う)。
 */
export function extendSketchSegmentAtPoint(
  doc: CadDocument,
  sketchId: FeatureId,
  targetId: string,
  clickPoint: Point2,
  referenceEdges: ExtendBoundary[] = [],
): { doc: CadDocument; removedCoincidentConstraint: boolean } {
  const sketch = findFeature(doc, sketchId);
  if (!sketch || sketch.type !== "sketch") return { doc, removedCoincidentConstraint: false };
  const segments = sketch.segments ?? [];
  const hit = findExtensionTarget(segments, sketch.entities, targetId, clickPoint, referenceEdges);
  if (!hit) return { doc, removedCoincidentConstraint: false };
  const nextSegments = extendSegmentAtPoint(segments, sketch.entities, targetId, clickPoint, referenceEdges);
  if (!nextSegments) return { doc, removedCoincidentConstraint: false };

  const existingConstraints = sketch.constraints ?? [];
  const touchesMovedEndpoint = (c: SketchConstraint) =>
    c.kind === "coincident" &&
    ((c.a.segmentId === targetId && c.a.end === hit.end) || (c.b.segmentId === targetId && c.b.end === hit.end));
  const removedCoincidentConstraint = existingConstraints.some(touchesMovedEndpoint);
  const nextConstraints = removedCoincidentConstraint
    ? existingConstraints.filter((c) => !touchesMovedEndpoint(c))
    : existingConstraints;

  const nextDoc = updateFeature<SketchFeature>(doc, sketchId, (s) => ({
    ...s,
    segments: nextSegments,
    constraints: nextConstraints,
  }));
  return { doc: nextDoc, removedCoincidentConstraint };
}

/**
 * sketch の拘束(SketchConstraint、Phase 20a)配列を丸ごと置き換える(Phase 20b、寸法ツール・
 * 拘束一覧パネルの追加/更新/削除で使う。実際の増分計算はsrc/sketch/constraintDimensions.tsの
 * upsert系関数・removeConstraint()が行い、ここでは置き換えのみを行う)。
 */
export function setSketchConstraints(doc: CadDocument, sketchId: FeatureId, constraints: SketchConstraint[]): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({ ...sketch, constraints }));
}

/**
 * sketch にセグメント(Phase 19a)を追加する(線分作図ツール・分解の確定時に使う、Phase 19b)。
 * constraints(Phase 20a)を同時に渡すと、追加されたセグメントに対する自動拘束
 * (src/sketch/autoConstraints.ts参照)も一緒に既存constraintsへ追記する(省略可、後方互換)。
 */
export function addSketchSegments(
  doc: CadDocument,
  sketchId: FeatureId,
  segments: SketchSegment[],
  constraints?: SketchConstraint[],
): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({
    ...sketch,
    segments: [...(sketch.segments ?? []), ...segments],
    ...(constraints && constraints.length > 0 ? { constraints: [...(sketch.constraints ?? []), ...constraints] } : {}),
  }));
}

/**
 * sketch のentityを削除し、代わりに等価なsegments(src/sketch/explode.ts の explodeEntity())を
 * 既存segmentsへ追記する(「分解」ボタン、Phase 19b)。分解後はトリムツールの対象になる。
 */
export function explodeSketchEntity(doc: CadDocument, sketchId: FeatureId, entityId: string, segments: SketchSegment[]): CadDocument {
  return updateFeature<SketchFeature>(doc, sketchId, (sketch) => ({
    ...sketch,
    entities: sketch.entities.filter((entity) => entity.id !== entityId),
    segments: [...(sketch.segments ?? []), ...segments],
  }));
}

/** 指定IDのフィーチャーを削除する(依存フィーチャーはそのまま残る=参照切れの可能性あり)。 */
export function removeFeature(doc: CadDocument, featureId: FeatureId): CadDocument {
  const features = doc.features.filter((f) => f.id !== featureId);
  if (features.length === doc.features.length) return doc;
  return { ...doc, features };
}

/** featureId に直接依存している(参照している)フィーチャーIDの一覧を返す。 */
export function getDirectDependentFeatureIds(doc: CadDocument, featureId: FeatureId): FeatureId[] {
  const dependents: FeatureId[] = [];
  for (const feature of doc.features) {
    if ((feature.type === "extrude" || feature.type === "revolve") && feature.sketchId === featureId) {
      dependents.push(feature.id);
    }
    if (feature.type === "sketch" && feature.plane.kind === "face" && feature.plane.featureId === featureId) {
      dependents.push(feature.id);
    }
    // 合致(メイト、Phase 28c)は参照する2つの面のいずれかのボディが削除されると解決できなくなるため、
    // 対象ボディを作ったフィーチャー(newBody操作のextrude/revolve、またはpartInstance)を削除する際は
    // カスケード削除の対象にする(他のフィーチャー参照と同じ扱い)。
    if (feature.type === "mate" && (feature.a.bodyFeatureId === featureId || feature.b.bodyFeatureId === featureId)) {
      dependents.push(feature.id);
    }
  }
  return dependents;
}

/** featureId に(直接・間接を問わず)依存している全フィーチャーIDの一覧を返す(featureId自体は含まない)。 */
export function getDependentFeatureIds(doc: CadDocument, featureId: FeatureId): FeatureId[] {
  const result = new Set<FeatureId>();
  const queue = [featureId];
  while (queue.length > 0) {
    const id = queue.shift() as FeatureId;
    for (const dep of getDirectDependentFeatureIds(doc, id)) {
      if (!result.has(dep)) {
        result.add(dep);
        queue.push(dep);
      }
    }
  }
  return [...result];
}

/**
 * 指定IDのフィーチャーと、それに(再帰的に)依存する全フィーチャーをまとめて削除する。
 * 例: sketchを削除すると、そのsketchIdを参照するextrudeも一緒に削除される。
 */
export function removeFeatureCascade(doc: CadDocument, featureId: FeatureId): CadDocument {
  const toRemove = new Set<FeatureId>([featureId, ...getDependentFeatureIds(doc, featureId)]);
  const features = doc.features.filter((f) => !toRemove.has(f.id));
  if (features.length === doc.features.length) return doc;
  return { ...doc, features };
}

/**
 * ロールバックバー(rollbackIndex)を考慮した「現在有効なフィーチャー数」を返す。
 * rollbackIndexがnull/undefinedなら全フィーチャーが有効(=features.length)。
 * 数値の場合は0〜features.lengthにクランプする(履歴削除等でindexが範囲外になっても安全に扱う)。
 */
export function effectiveFeatureCount(doc: CadDocument): number {
  const n = doc.rollbackIndex;
  if (n === null || n === undefined) return doc.features.length;
  return Math.max(0, Math.min(n, doc.features.length));
}

/**
 * rollbackIndexが設定されていれば、features先頭からeffectiveFeatureCount()件だけに絞った
 * 新しいドキュメントを返す(Worker評価専用。正本のdoc.featuresは変更しない)。
 * rollbackIndexが末尾を指す場合はdocをそのまま返す(無駄なコピーを避ける)。
 */
export function resolveEvaluationDocument(doc: CadDocument): CadDocument {
  const count = effectiveFeatureCount(doc);
  if (count >= doc.features.length) return doc;
  return { ...doc, features: doc.features.slice(0, count) };
}

/**
 * ロールバックバーの位置を設定する。indexがnull、またはfeatures.length以上であれば
 * 「末尾」を表すnullに正規化する(rollbackIndexが常に「末尾かどうか」を素直に判定できるように)。
 * 負の値は0にクランプする。
 */
export function setRollbackIndex(doc: CadDocument, index: number | null): CadDocument {
  if (index === null || index >= doc.features.length) {
    return { ...doc, rollbackIndex: null };
  }
  return { ...doc, rollbackIndex: Math.max(0, index) };
}

/** フィーチャー(または追加/更新しようとしているフィーチャー)を検証する。 */
export function validateSingleFeature(feature: Feature, doc: CadDocument): ValidationError[] {
  return validateFeature(feature, doc.features);
}

export { validateDocument, validateFeature, isDocumentValid } from "./validation";
