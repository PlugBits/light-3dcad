// CadDocument.features を先頭から逐次評価し、Replicadの形状(AnyShape)を組み立てる。
// Worker内でのみimportすること(Replicad = OpenCascade WASM への依存を持つため)。
//
// Phase 1 でサポートする範囲:
//   - sketch: plane は world XY のみ(face参照はエラー)
//   - entities: rectangle / circle
//   - extrude: operation "newBody"(最初の1回のみ) / "cut"(既存ボディが必要)
//   - direction: -1 は逆向き押し出し
import { drawCircle, drawRectangle, type Drawing, type Shape3D } from "replicad";

import type { CadDocument, FeatureId, SketchEntity, SketchFeature } from "../model/types";

export interface EvaluationSuccess {
  ok: true;
  shape: Shape3D;
}

export interface EvaluationFailure {
  ok: false;
  featureId?: FeatureId;
  message: string;
}

export type EvaluationResult = EvaluationSuccess | EvaluationFailure;

/** sketch内のentities(rectangle/circle)を1つのDrawingに合成する。 */
function buildDrawing(entities: SketchEntity[]): Drawing {
  if (entities.length === 0) {
    throw new Error("スケッチに図形がありません");
  }

  let drawing: Drawing | null = null;
  for (const entity of entities) {
    const [cx, cy] = entity.center;
    const piece: Drawing =
      entity.kind === "rectangle"
        ? drawRectangle(entity.width, entity.height).translate(cx, cy)
        : drawCircle(entity.radius).translate(cx, cy);
    drawing = drawing ? drawing.fuse(piece) : piece;
  }
  // entities.length > 0 が保証されているため drawing は必ず非null。
  return drawing as Drawing;
}

/**
 * sketchFeatureをXY平面上のDrawingに変換し、指定距離・方向で押し出す。
 *
 * 注意: replicadの Sketch#extrude() / Sketches#extrude() は内部で押し出し元の
 * sketch(wire)を自動的に delete() する実装になっている(CompoundSketchを除く)。
 * そのため呼び出し側でsketchOnPlane()の戻り値を重ねて delete() すると
 * 「This object has been deleted」の二重解放エラーになる。ここでは呼ばない。
 */
function extrudeSketchFeature(sketch: SketchFeature, distance: number, direction: 1 | -1): Shape3D {
  const drawing = buildDrawing(sketch.entities);
  const sketched = drawing.sketchOnPlane("XY");
  // sketchOnPlane() の戻り値は型上 SketchInterface | Sketches に分かれ、
  // extrude() の戻り値もそれぞれ Shape3D / AnyShape に広がるため明示キャストする。
  // 実際には押し出しは常に立体(Shape3D)を生む。
  return sketched.extrude(distance * direction) as Shape3D;
}

/**
 * ドキュメントを評価してひとつのAnyShapeを返す。
 * 失敗時は featureId(特定できれば) 付きのエラーを返す。
 * 成功時に返るshapeの解放は呼び出し側の責務。失敗時は内部で生成した中間形状をすべて解放する。
 */
export function evaluateDocument(doc: CadDocument): EvaluationResult {
  const sketches = new Map<FeatureId, SketchFeature>();
  let body: Shape3D | null = null;
  let currentFeatureId: FeatureId | undefined;

  try {
    for (const feature of doc.features) {
      currentFeatureId = feature.id;

      if (feature.type === "sketch") {
        if (feature.plane.kind !== "world" || feature.plane.plane !== "XY") {
          throw new Error("面を参照するスケッチ平面は未対応です(現状はワールドXY平面のみ)");
        }
        sketches.set(feature.id, feature);
        continue;
      }

      // feature.type === "extrude"
      const sketch = sketches.get(feature.sketchId);
      if (!sketch) {
        throw new Error(`参照先のスケッチ(${feature.sketchId})が見つかりません`);
      }

      if (feature.operation === "newBody") {
        if (body) {
          throw new Error("単一ボディのみ対応です(既にボディが存在します)");
        }
        body = extrudeSketchFeature(sketch, feature.distance, feature.direction);
      } else {
        if (!body) {
          throw new Error("カット対象のボディがありません");
        }
        const tool = extrudeSketchFeature(sketch, feature.distance, feature.direction);
        let cutResult: Shape3D;
        try {
          cutResult = body.cut(tool);
        } finally {
          tool.delete();
        }
        body.delete();
        body = cutResult;
      }
    }
  } catch (err) {
    if (body) body.delete();
    return {
      ok: false,
      featureId: currentFeatureId,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (!body) {
    return { ok: false, message: "ドキュメントに有効なボディがありません(押し出しフィーチャーがありません)" };
  }

  return { ok: true, shape: body };
}
