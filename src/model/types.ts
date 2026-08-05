// CADドキュメントの正本となるフィーチャーデータ型。
// このファイルは副作用のない純粋TypeScript(Replicad等の重い依存はimportしない)。
// docs/PLAN.md の「フィーチャーデータ型(要旨)」を実装したもの。

/** フィーチャーの一意識別子。 */
export type FeatureId = string;

/** スケッチが乗る平面の参照。 */
export type PlaneRef =
  | { kind: "world"; plane: "XY" }
  | {
      kind: "face";
      featureId: FeatureId;
      /** 選択時点のB-Rep面ID(face.hashCode)。再評価で変わりうるため第一候補としてのみ使う。 */
      faceId: number;
      /** 選択時点の面中心(mm)。faceId解決に失敗した際の幾何マッチングに使う。 */
      center: [number, number, number];
      /** 選択時点の面法線(単位ベクトル)。幾何マッチングに使う。 */
      normal: [number, number, number];
    };

/** スケッチ内の2D図形。座標はスケッチ平面上のローカル座標(mm)。 */
export type SketchEntity =
  | { kind: "rectangle"; id: string; center: [number, number]; width: number; height: number }
  | { kind: "circle"; id: string; center: [number, number]; radius: number }
  | {
      kind: "polygon";
      id: string;
      /** 閉多角形の頂点列(順序付き)。最後の点と最初の点は自動的に結ばれる。3点以上必要。 */
      points: [number, number][];
    };

/** 2Dスケッチフィーチャー。 */
export interface SketchFeature {
  type: "sketch";
  id: FeatureId;
  name: string;
  plane: PlaneRef;
  entities: SketchEntity[];
}

/** 押し出しフィーチャー(新規ボディ作成 or 既存ボディからのカット)。 */
export interface ExtrudeFeature {
  type: "extrude";
  id: FeatureId;
  name: string;
  sketchId: FeatureId;
  distance: number;
  direction: 1 | -1;
  operation: "newBody" | "cut" | "add";
}

/** フィーチャー(履歴列の1要素)。 */
export type Feature = SketchFeature | ExtrudeFeature;

/** CADドキュメント全体。features は順序付き(=編集履歴)。 */
export interface CadDocument {
  version: 1;
  features: Feature[];
}
