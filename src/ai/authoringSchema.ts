// Phase 37: AI(LLM)がJSONで出力するための「アウソリングスキーマ」の型とJSON Schema定義。
// このファイルは副作用のない純粋TypeScript(Anthropic SDK等の重い依存はimportしない)。
//
// なぜ内部のCadDocument(src/model/types.ts)をそのまま使わないのか:
// 内部のFeature/SketchEntity型は、面参照(PlaneRef kind:"face")・3Dエッジ/面のスナップショット
// (FilletEdgeRef/ShellFaceRef等)・合致(MateFaceRef)など、実際にジオメトリを評価しないと
// 得られない「幾何スナップショット」を大量に含む。LLMはこれらを一切生成できない
// (面ID・法線・中心座標などは評価結果からしか得られない)。そのため、LLMが安全に出力できる
// 最小限の「著作用」スキーマを別途定義し、src/ai/compile.ts でCadDocumentへ変換する。
//
// v1スコープ: world平面(XY/XZ/YZ)上のスケッチ + entities(rectangle/circle/polygon/slot/
// regularPolygon) + 自由なsegments(line/arc)への一部拘束(coincident/horizontal/vertical/
// distance/radius) + extrude/revolveフィーチャーのみ。
// 意図的に対象外(v1では扱わない): 面上スケッチ(sketch-on-face)、fillet3d/chamfer/shell/thread、
// 部品配置(partInstance)/合致(mate)。これらは内部型が幾何スナップショットや複雑な参照を要求し、
// LLMが直接安全に生成できないため。将来追加する場合も、このファイルに新しいunionメンバーを
// 追加する形で拡張できるように設計してある(既存メンバーの形は変えない)。

/** スケッチが乗る基準平面。v1はworld平面のみ(面上スケッチは対象外)。 */
export type AuthoringPlane = "XY" | "XZ" | "YZ";

/** ローカル2D座標(mm)の点。 */
export type AuthoringPoint2 = [number, number];

export interface AuthoringRectangleEntity {
  kind: "rectangle";
  /** スケッチ内で一意なID(拘束等からの参照には使わない。将来拡張用に予約)。 */
  id: string;
  center: AuthoringPoint2;
  width: number;
  height: number;
}

export interface AuthoringCircleEntity {
  kind: "circle";
  id: string;
  center: AuthoringPoint2;
  radius: number;
}

/** 閉多角形。points は3点以上、順序付き(最後と最初は自動的に結ばれる)。 */
export interface AuthoringPolygonEntity {
  kind: "polygon";
  id: string;
  points: AuthoringPoint2[];
}

/** 直線スロット(長円)。start/endは中心線の両端、widthは全幅(キャップ半径はwidth/2)。 */
export interface AuthoringSlotEntity {
  kind: "slot";
  id: string;
  start: AuthoringPoint2;
  end: AuthoringPoint2;
  width: number;
}

/** 正多角形。radiusは外接円半径、sidesは辺数(3〜24)。rotationは頂点0の回転角(ラジアン、省略可)。 */
export interface AuthoringRegularPolygonEntity {
  kind: "regularPolygon";
  id: string;
  center: AuthoringPoint2;
  radius: number;
  sides: number;
  rotation: number | null;
}

/**
 * スケッチ内の1図形。入れ子(例: rectangleの内側にcircle)は自動的に穴として扱われる
 * (押し出し時、内側のプロファイルは差分カットになる。既存エヴァリュエータの挙動そのまま)。
 */
export type AuthoringEntity =
  | AuthoringRectangleEntity
  | AuthoringCircleEntity
  | AuthoringPolygonEntity
  | AuthoringSlotEntity
  | AuthoringRegularPolygonEntity;

export interface AuthoringLineSegment {
  kind: "line";
  /** スケッチ内で一意なID。拘束(constraints)から参照する。 */
  id: string;
  p1: AuthoringPoint2;
  p2: AuthoringPoint2;
}

/** bulge = tan(挟角/4)。正負で膨らむ向きが決まる(内部SketchSegmentと同じ定義)。 */
export interface AuthoringArcSegment {
  kind: "arc";
  id: string;
  p1: AuthoringPoint2;
  p2: AuthoringPoint2;
  bulge: number;
}

/** entitiesとは独立した「自由な線分・円弧」。閉じている必要はない(閉領域検出は評価側が行う)。 */
export type AuthoringSegment = AuthoringLineSegment | AuthoringArcSegment;

/** segment上の端点参照。"start"はp1、"end"はp2に対応する。 */
export interface AuthoringPointRef {
  segment: string;
  point: "start" | "end";
}

/** 2点間の距離(mm)。同一segment内の2端点を指定すればその線分の「長さ」拘束として機能する。 */
export interface AuthoringDistanceConstraint {
  kind: "distance";
  a: AuthoringPointRef;
  b: AuthoringPointRef;
  value: number;
}

/** kind:"arc"のsegmentにのみ指定できる半径拘束(mm)。 */
export interface AuthoringRadiusConstraint {
  kind: "radius";
  segment: string;
  value: number;
}

/** segmentが水平であること。 */
export interface AuthoringHorizontalConstraint {
  kind: "horizontal";
  segment: string;
}

/** segmentが垂直であること。 */
export interface AuthoringVerticalConstraint {
  kind: "vertical";
  segment: string;
}

/** 2点が一致すること(線分同士を繋ぐ、閉ループを作る等に使う)。 */
export interface AuthoringCoincidentConstraint {
  kind: "coincident";
  a: AuthoringPointRef;
  b: AuthoringPointRef;
}

/**
 * スケッチ拘束の一部(v1で有用な最小サブセット)。PlaneGCSソルバ(src/sketch/solver.ts)が
 * 正確な寸法どおりの形状を解くために使う。entities(rectangle/circle等)は既に数値で
 * 位置・サイズを直接指定できるため、拘束は主にsegments(自由な線分・円弧チェーン)向け。
 */
export type AuthoringConstraint =
  | AuthoringDistanceConstraint
  | AuthoringRadiusConstraint
  | AuthoringHorizontalConstraint
  | AuthoringVerticalConstraint
  | AuthoringCoincidentConstraint;

export interface AuthoringSketch {
  /** ドキュメント内で一意なID。featuresのsketchフィールドから参照される。 */
  id: string;
  plane: AuthoringPlane;
  entities: AuthoringEntity[];
  segments: AuthoringSegment[];
  constraints: AuthoringConstraint[];
}

export interface AuthoringExtrudeFeature {
  type: "extrude";
  /** 他のfeatureのtargetBodyから参照する場合のみ指定する(省略可)。 */
  id: string | null;
  sketch: string;
  distance: number;
  operation: "newBody" | "add" | "cut";
  /** 押し出し方向(1=法線正方向、-1=逆方向)。省略時は1。 */
  direction: 1 | -1 | null;
  /** operation:"add"|"cut"のときのみ意味を持つ。省略時は直前に作られたボディが対象になる。 */
  targetBody: string | null;
}

export interface AuthoringRevolveFeature {
  type: "revolve";
  id: string | null;
  sketch: string;
  /** 回転軸(スケッチローカルのX軸またはY軸、いずれもスケッチ原点を通る)。 */
  axis: "x" | "y";
  /** 回転角度(度)。省略時は360(全周)。 */
  angle: number | null;
  operation: "newBody" | "add" | "cut";
  targetBody: string | null;
}

export type AuthoringFeature = AuthoringExtrudeFeature | AuthoringRevolveFeature;

/** アウソリングスキーマのルート。LLM(または手動貼り付け)が出力するJSON全体の形。 */
export interface AuthoringModel {
  sketches: AuthoringSketch[];
  features: AuthoringFeature[];
}

/** JSON Schemaはネスト構造を持つただのオブジェクトなので、緩い型で表現する。 */
type JsonSchema = Record<string, unknown>;

const POINT2_SCHEMA: JsonSchema = {
  type: "array",
  items: { type: "number" },
};

const RECTANGLE_ENTITY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    kind: { const: "rectangle" },
    id: { type: "string" },
    center: POINT2_SCHEMA,
    width: { type: "number" },
    height: { type: "number" },
  },
  required: ["kind", "id", "center", "width", "height"],
  additionalProperties: false,
};

const CIRCLE_ENTITY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    kind: { const: "circle" },
    id: { type: "string" },
    center: POINT2_SCHEMA,
    radius: { type: "number" },
  },
  required: ["kind", "id", "center", "radius"],
  additionalProperties: false,
};

const POLYGON_ENTITY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    kind: { const: "polygon" },
    id: { type: "string" },
    points: { type: "array", items: POINT2_SCHEMA },
  },
  required: ["kind", "id", "points"],
  additionalProperties: false,
};

const SLOT_ENTITY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    kind: { const: "slot" },
    id: { type: "string" },
    start: POINT2_SCHEMA,
    end: POINT2_SCHEMA,
    width: { type: "number" },
  },
  required: ["kind", "id", "start", "end", "width"],
  additionalProperties: false,
};

const REGULAR_POLYGON_ENTITY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    kind: { const: "regularPolygon" },
    id: { type: "string" },
    center: POINT2_SCHEMA,
    radius: { type: "number" },
    sides: { type: "integer" },
    rotation: { anyOf: [{ type: "number" }, { type: "null" }] },
  },
  required: ["kind", "id", "center", "radius", "sides", "rotation"],
  additionalProperties: false,
};

const ENTITY_SCHEMA: JsonSchema = {
  anyOf: [
    RECTANGLE_ENTITY_SCHEMA,
    CIRCLE_ENTITY_SCHEMA,
    POLYGON_ENTITY_SCHEMA,
    SLOT_ENTITY_SCHEMA,
    REGULAR_POLYGON_ENTITY_SCHEMA,
  ],
};

const LINE_SEGMENT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    kind: { const: "line" },
    id: { type: "string" },
    p1: POINT2_SCHEMA,
    p2: POINT2_SCHEMA,
  },
  required: ["kind", "id", "p1", "p2"],
  additionalProperties: false,
};

const ARC_SEGMENT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    kind: { const: "arc" },
    id: { type: "string" },
    p1: POINT2_SCHEMA,
    p2: POINT2_SCHEMA,
    bulge: { type: "number" },
  },
  required: ["kind", "id", "p1", "p2", "bulge"],
  additionalProperties: false,
};

const SEGMENT_SCHEMA: JsonSchema = {
  anyOf: [LINE_SEGMENT_SCHEMA, ARC_SEGMENT_SCHEMA],
};

const POINT_REF_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    segment: { type: "string" },
    point: { enum: ["start", "end"] },
  },
  required: ["segment", "point"],
  additionalProperties: false,
};

const DISTANCE_CONSTRAINT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    kind: { const: "distance" },
    a: POINT_REF_SCHEMA,
    b: POINT_REF_SCHEMA,
    value: { type: "number" },
  },
  required: ["kind", "a", "b", "value"],
  additionalProperties: false,
};

const RADIUS_CONSTRAINT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    kind: { const: "radius" },
    segment: { type: "string" },
    value: { type: "number" },
  },
  required: ["kind", "segment", "value"],
  additionalProperties: false,
};

const HORIZONTAL_CONSTRAINT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    kind: { const: "horizontal" },
    segment: { type: "string" },
  },
  required: ["kind", "segment"],
  additionalProperties: false,
};

const VERTICAL_CONSTRAINT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    kind: { const: "vertical" },
    segment: { type: "string" },
  },
  required: ["kind", "segment"],
  additionalProperties: false,
};

const COINCIDENT_CONSTRAINT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    kind: { const: "coincident" },
    a: POINT_REF_SCHEMA,
    b: POINT_REF_SCHEMA,
  },
  required: ["kind", "a", "b"],
  additionalProperties: false,
};

const CONSTRAINT_SCHEMA: JsonSchema = {
  anyOf: [
    DISTANCE_CONSTRAINT_SCHEMA,
    RADIUS_CONSTRAINT_SCHEMA,
    HORIZONTAL_CONSTRAINT_SCHEMA,
    VERTICAL_CONSTRAINT_SCHEMA,
    COINCIDENT_CONSTRAINT_SCHEMA,
  ],
};

const SKETCH_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    plane: { enum: ["XY", "XZ", "YZ"] },
    entities: { type: "array", items: ENTITY_SCHEMA },
    segments: { type: "array", items: SEGMENT_SCHEMA },
    constraints: { type: "array", items: CONSTRAINT_SCHEMA },
  },
  required: ["id", "plane", "entities", "segments", "constraints"],
  additionalProperties: false,
};

const EXTRUDE_FEATURE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    type: { const: "extrude" },
    id: { anyOf: [{ type: "string" }, { type: "null" }] },
    sketch: { type: "string" },
    distance: { type: "number" },
    operation: { enum: ["newBody", "add", "cut"] },
    direction: { anyOf: [{ const: 1 }, { const: -1 }, { type: "null" }] },
    targetBody: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["type", "id", "sketch", "distance", "operation", "direction", "targetBody"],
  additionalProperties: false,
};

const REVOLVE_FEATURE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    type: { const: "revolve" },
    id: { anyOf: [{ type: "string" }, { type: "null" }] },
    sketch: { type: "string" },
    axis: { enum: ["x", "y"] },
    angle: { anyOf: [{ type: "number" }, { type: "null" }] },
    operation: { enum: ["newBody", "add", "cut"] },
    targetBody: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["type", "id", "sketch", "axis", "angle", "operation", "targetBody"],
  additionalProperties: false,
};

const FEATURE_SCHEMA: JsonSchema = {
  anyOf: [EXTRUDE_FEATURE_SCHEMA, REVOLVE_FEATURE_SCHEMA],
};

/**
 * Anthropic Messages API の構造化出力(output_config.format: {type:"json_schema", schema:...})に
 * そのまま渡せるJSON Schema。制約: 全オブジェクトにadditionalProperties:falseとrequired(全キー)、
 * 再帰なし、minimum/maximum/minLength/maxLengthなし(数値の健全性チェックはsrc/ai/compile.tsで行う)。
 */
export const AUTHORING_JSON_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    sketches: { type: "array", items: SKETCH_SCHEMA },
    features: { type: "array", items: FEATURE_SCHEMA },
  },
  required: ["sketches", "features"],
  additionalProperties: false,
};
