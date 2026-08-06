// CADドキュメントの正本となるフィーチャーデータ型。
// このファイルは副作用のない純粋TypeScript(Replicad等の重い依存はimportしない)。
// docs/PLAN.md の「フィーチャーデータ型(要旨)」を実装したもの。

/** フィーチャーの一意識別子。 */
export type FeatureId = string;

/** world平面(基準平面)の名前。Phase 13でXZ/YZを追加。 */
export type WorldPlaneName = "XY" | "XZ" | "YZ";

/** スケッチが乗る平面の参照。world平面はXY/XZ/YZの3枚の基準平面をサポートする(Phase 13)。 */
export type PlaneRef =
  | { kind: "world"; plane: WorldPlaneName }
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

/**
 * polygon頂点のコーナー指定。null/未指定は角のまま。
 * kind:"fillet" は丸め(円弧)、"chamfer" は面取り(直線カット)。
 * size は replicad の customCorner() にそのまま渡す値(丸め半径、または面取りのオフセット距離。
 * 直角90度の頂点では面取りの脚長と一致するが、それ以外の角度では脚長と一致しない。
 * 詳細は src/sketch/polygonOutline.ts のコメントを参照)。size > 0 が必須。
 */
export type PolygonCorner = null | { kind: "fillet" | "chamfer"; size: number };

/** スケッチ内の2D図形。座標はスケッチ平面上のローカル座標(mm)。 */
export type SketchEntity =
  | { kind: "rectangle"; id: string; center: [number, number]; width: number; height: number }
  | { kind: "circle"; id: string; center: [number, number]; radius: number }
  | {
      kind: "polygon";
      id: string;
      /** 閉多角形の頂点列(順序付き)。最後の点と最初の点は自動的に結ばれる。3点以上必要。 */
      points: [number, number][];
      /**
       * 各頂点(points[i]に対応)のコーナー指定。省略可(既存データとの後方互換のため)。
       * 指定する場合は points と同じ長さが期待されるが、短い場合は該当インデックス以降を
       * 「角のまま(null)」として扱う(evaluator/オーバーレイ側の配列アクセスは常に
       * corners?.[i] の形でオプショナルに読む)。
       */
      corners?: PolygonCorner[];
      /**
       * 辺i(points[i]→points[i+1]、最後は points[length-1]→points[0])のふくらみ指定(Phase 17)。
       * null/0/未指定はその辺が直線であることを表す。非0の値は3点円弧のbulge値
       * (bulge = tan(挟角/4)、正負でどちら側に膨らむかが決まる。詳細は src/sketch/bulge.ts)。
       * corners と同様、points より短い配列は残りを null 扱いにする並列配列。
       * ある頂点(points[i])に corners[i] が設定されている場合、その頂点を端点に持つ辺
       * (bulges[i-1] と bulges[i])のふくらみは無視される(フィレット/面取りを優先する。
       * src/sketch/bulge.ts の effectivePolygonBulges() 参照)。
       */
      bulges?: (number | null)[];
    }
  | {
      kind: "slot";
      id: string;
      /** 直線スロットの中心線の始点・終点(ローカル2D、mm)。両端に半円キャップが付く(Phase 17)。 */
      start: [number, number];
      end: [number, number];
      /** スロットの全幅(mm)。キャップの半径は width/2。 */
      width: number;
    }
  | {
      kind: "regularPolygon";
      id: string;
      /** 外接円の中心(ローカル2D、mm、Phase 17)。 */
      center: [number, number];
      /** 外接円の半径(mm)。 */
      radius: number;
      /** 辺数(3〜24)。 */
      sides: number;
      /** 頂点0の回転角(ラジアン、+X軸からの反時計回り)。省略時は0。 */
      rotation?: number;
    };

/**
 * スケッチ内の自由な線分・円弧セグメント(Phase 19a)。
 * entitiesとは独立した「セグメントの集まり」で、閉じている必要はない
 * (ぶら下がり枝や開いた線が混在してもよい。閉領域検出はsrc/sketch/regions.tsが担う)。
 * kind:"arc" のときのみ bulge を持つ(定義はsrc/sketch/bulge.tsと同一: bulge = tan(挟角/4)、
 * 符号は始点p1から終点p2への掃引方向を決める。0/未指定は直線として扱う)。
 * バリデーション: p1とp2の距離は1e-6mmを超えること(src/model/validation.ts)。
 */
export type SketchSegment = {
  id: string;
  kind: "line" | "arc";
  p1: [number, number];
  p2: [number, number];
  /** kind:"line" のときは無視される。 */
  bulge?: number;
};

/**
 * segments(Phase 19a)上の点を指す参照。segmentIdはSketchSegment.id、endはp1/p2のどちらか。
 * Phase 20a: 拘束(SketchConstraint)がこの参照で端点を指し示す。
 */
export type PointRef = { segmentId: string; end: "p1" | "p2" };

/** entities配列内の1エンティティを指す参照(Phase 22、circleのみ対象v1)。 */
export type EntityRef = { entityId: string };

/**
 * 円の中心↔辺の距離拘束(distanceEntityLine)が参照する「辺」(Phase 22)。
 * "entityEdge" は rectangle/polygon エンティティの辺(edgeIndex: rectangleは0=下/1=右/2=上/3=左、
 * polygonはpoints[i]→points[i+1 mod n])を指し、エンティティが動けば辺も追従する(常に生値から解決)。
 * "refEdge" はボディ端面参照(Phase 22、src/worker/evaluator.tsのreferenceEdges)のスナップショットで、
 * p1/p2はピック時点のスケッチローカル2D座標を凍結したもの。再評価のたびに
 * src/sketch/referenceEdgeMatch.ts が最新のreferenceEdgesと幾何マッチングして更新を試みる
 * (マッチしなければスナップショットを維持する。既知の制限)。
 */
export type LineRef =
  | { kind: "entityEdge"; entityId: string; edgeIndex: number }
  | { kind: "refEdge"; p1: [number, number]; p2: [number, number] };

/**
 * スケッチ拘束(Phase 20a、寸法ドリブン編集[Phase 20b]の土台)。座標系はSketchSegmentと同じく
 * スケッチのローカル2D(mm)。src/sketch/solver.ts の solveSketch() がこの配列を解として満たす
 * segments(端点座標)・circleエンティティの中心座標を求める(coincidentでの端点マージは行わず、
 * 各セグメントの端点は独立変数のまま残差として扱う。詳細はsolver.tsのコメント参照)。
 */
export type SketchConstraint =
  | { id: string; kind: "coincident"; a: PointRef; b: PointRef }
  | { id: string; kind: "horizontal"; segmentId: string }
  | { id: string; kind: "vertical"; segmentId: string }
  /** 線分(または円弧の弦長ではなく弧長方向の端点間距離。実体は端点間のユークリッド距離)の長さ(mm)。 */
  | { id: string; kind: "length"; segmentId: string; value: number }
  /** 2点間の距離(mm)。同一セグメント内・別セグメント間のどちらの点も指定できる。 */
  | { id: string; kind: "distance"; a: PointRef; b: PointRef; value: number }
  /** kind:"arc" のセグメントにのみ指定できる半径拘束(mm)。bulge(挟角)は維持したまま端点間距離を調整して解く。 */
  | { id: string; kind: "radius"; segmentId: string; value: number }
  /** 点を(拘束追加時点の)現在位置に固定する。値はsolveSketch呼び出し時の入力座標から都度求める(拘束自体には持たない)。 */
  | { id: string; kind: "fix"; point: PointRef }
  /** circleエンティティの中心↔スケッチ原点([0,0])の距離(mm、Phase 22)。 */
  | { id: string; kind: "distanceEntityOrigin"; entity: EntityRef; value: number }
  /**
   * circleエンティティの中心↔中心の距離(mm、Phase 22)。axis(UI改善対応、省略=direct・後方互換)は
   * "x"/"y"のときそれぞれ|cx_b-cx_a|/|cy_b-cy_a|のみを距離として扱う(中心間の直線距離ではなく、
   * 片方の軸成分のみを拘束する)。
   */
  | { id: string; kind: "distanceEntityEntity"; a: EntityRef; b: EntityRef; value: number; axis?: "direct" | "x" | "y" }
  /** circleエンティティの中心↔辺(直線、動かない)の垂直距離(mm、Phase 22)。 */
  | { id: string; kind: "distanceEntityLine"; entity: EntityRef; line: LineRef; value: number }
  /** circleエンティティの中心を(拘束追加時点の)現在位置に固定する(Phase 22、固定トグル)。 */
  | { id: string; kind: "fixEntity"; entity: EntityRef }
  /** 2本の直線セグメント(kind:"line"のみ対象)が垂直であること(Phase 23)。 */
  | { id: string; kind: "perpendicular"; a: string; b: string }
  /** 2つのcircleエンティティの中心が一致すること(Phase 23)。 */
  | { id: string; kind: "concentric"; a: EntityRef; b: EntityRef }
  /**
   * circleエンティティが直線セグメント、または別のcircleエンティティに接すること(Phase 23)。
   * target.kind:"segment" は直線セグメント(kind:"line"のみ)への接線(円中心↔直線の距離=半径)。
   * target.kind:"entity" は円同士の接線で、mode:"external"(外接、中心間距離=r1+r2)/
   * "internal"(内接、中心間距離=|r1-r2|)のいずれか。modeは拘束作成時点の現在の中心間距離が
   * external/internalどちらの目標値に近いかで自動選択し、以後は固定値として保存する
   * (src/sketch/constraintGeom.tsのcreateTangentEntityConstraint参照)。
   */
  | {
      id: string;
      kind: "tangent";
      entity: EntityRef;
      target: { kind: "segment"; segmentId: string } | { kind: "entity"; entityId: string; mode: "external" | "internal" };
    };

/**
 * 2Dスケッチフィーチャー。
 * segments(Phase 19a)はentitiesと後方互換のため独立した追加フィールド(省略可)。
 * 押し出し時、segmentsが存在すればsrc/sketch/regions.tsで閉領域検出を行いDrawing化し、
 * entities由来のDrawingとfuseする(src/worker/evaluator.ts参照)。
 * constraints(Phase 20a)はsegmentsに対する拘束(省略可、後方互換)。ドキュメント更新時に
 * src/sketch/solver.ts の solveSketch() で解かれ、解けたsegmentsに置き換わってから評価に回る
 * (src/state/store.ts参照)。
 */
export interface SketchFeature {
  type: "sketch";
  id: FeatureId;
  name: string;
  plane: PlaneRef;
  entities: SketchEntity[];
  segments?: SketchSegment[];
  constraints?: SketchConstraint[];
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
