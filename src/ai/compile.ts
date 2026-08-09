// Phase 37: アウソリングスキーマ(src/ai/authoringSchema.ts)のJSONを内部CadDocumentへ変換する。
// このファイルは副作用のない純粋TypeScript(Anthropic SDK・Worker等はimportしない)。
//
// 方針: 構造化出力(JSON Schema)である程度の形は保証されるが、(1)「手動貼り付け」経路では
// スキーマに従わない任意のJSONが渡りうる、(2)JSON Schemaでは表現できない意味的制約
// (ID参照の解決・cut/addの前提となるボディの存在・寸法の正値性等)がある、の2点から
// 全フィールドをここで再検証する(ハンドロール、依存追加なし)。
// エラーメッセージは日本語+JSONパス形式(例: `features[1].sketch: "s9" というIDのスケッチがありません`)。

import { generateId } from "../model/id";
import type {
  CadDocument,
  Feature,
  PointRef,
  SketchConstraint,
  SketchEntity,
  SketchFeature,
  SketchSegment,
} from "../model/types";

export type CompileResult = { doc: CadDocument } | { errors: string[] };

/** コンパイル中に集めるエラー(JSONパス付き日本語メッセージ)。 */
class ErrorCollector {
  readonly errors: string[] = [];
  push(path: string, message: string): void {
    this.errors.push(`${path}: ${message}`);
  }
  get hasErrors(): boolean {
    return this.errors.length > 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 正の有限数を読み取る。不正ならエラーを積んでnullを返す(呼び出し側はガード節として使う)。 */
function requirePositiveNumber(value: unknown, path: string, errors: ErrorCollector): number | null {
  if (!isPositiveFiniteNumber(value)) {
    errors.push(path, "正の数である必要があります");
    return null;
  }
  return value;
}

/** 有限数を読み取る(0や負も許容)。不正ならエラーを積んでnullを返す。 */
function requireFiniteNumber(value: unknown, path: string, errors: ErrorCollector): number | null {
  if (!isFiniteNumber(value)) {
    errors.push(path, "有限の数である必要があります");
    return null;
  }
  return value;
}

/** 3〜24の整数を読み取る(regularPolygonのsides用)。不正ならエラーを積んでnullを返す。 */
function requireSideCount(value: unknown, path: string, errors: ErrorCollector): number | null {
  if (!Number.isInteger(value) || (value as number) < 3 || (value as number) > 24) {
    errors.push(path, "3〜24の整数である必要があります");
    return null;
  }
  return value as number;
}

/** [number, number] 形式の点を読み取る。不正なら null(呼び出し側がエラーを積む)。 */
function readPoint2(value: unknown, path: string, errors: ErrorCollector): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2 || !isFiniteNumber(value[0]) || !isFiniteNumber(value[1])) {
    errors.push(path, "[x, y]形式の座標(有限数2要素)である必要があります");
    return null;
  }
  return [value[0], value[1]];
}

/**
 * segment上の端点参照(AuthoringPointRef)を内部PointRefへ変換する。segmentIdの存在は
 * (ここでは)まだ確認しない(呼び出し側resolveSketch()が全segment構築後にまとめて解決する)。
 */
function readPointRef(value: unknown, path: string, errors: ErrorCollector): { segmentId: string; point: "start" | "end" } | null {
  if (!isRecord(value)) {
    errors.push(path, "点参照はオブジェクトである必要があります");
    return null;
  }
  const segment = value.segment;
  const point = value.point;
  if (!isNonEmptyString(segment)) {
    errors.push(`${path}.segment`, "スケッチ要素IDは空でない文字列である必要があります");
    return null;
  }
  if (point !== "start" && point !== "end") {
    errors.push(`${path}.point`, `"start"または"end"である必要があります`);
    return null;
  }
  return { segmentId: segment, point };
}

interface SketchCompileContext {
  path: string;
  entityIds: Set<string>;
  segmentIds: Set<string>;
  segmentKindById: Map<string, "line" | "arc">;
}

function compileEntity(raw: unknown, index: number, ctx: SketchCompileContext, errors: ErrorCollector): SketchEntity | null {
  const path = `${ctx.path}.entities[${index}]`;
  if (!isRecord(raw)) {
    errors.push(path, "オブジェクトである必要があります");
    return null;
  }
  const kind = raw.kind;
  const id = raw.id;
  if (!isNonEmptyString(id)) {
    errors.push(`${path}.id`, "空でない文字列である必要があります");
    return null;
  }
  if (ctx.entityIds.has(id)) {
    errors.push(path, `図形ID "${id}" がスケッチ内で重複しています`);
    return null;
  }
  ctx.entityIds.add(id);

  switch (kind) {
    case "rectangle": {
      const center = readPoint2(raw.center, `${path}.center`, errors);
      const width = requirePositiveNumber(raw.width, `${path}.width`, errors);
      const height = requirePositiveNumber(raw.height, `${path}.height`, errors);
      if (!center || width === null || height === null) return null;
      return { kind: "rectangle", id, center, width, height };
    }
    case "circle": {
      const center = readPoint2(raw.center, `${path}.center`, errors);
      const radius = requirePositiveNumber(raw.radius, `${path}.radius`, errors);
      if (!center || radius === null) return null;
      return { kind: "circle", id, center, radius };
    }
    case "polygon": {
      const pointsRaw = raw.points;
      if (!Array.isArray(pointsRaw) || pointsRaw.length < 3) {
        errors.push(`${path}.points`, "3点以上の頂点配列である必要があります");
        return null;
      }
      const points: [number, number][] = [];
      let ok = true;
      pointsRaw.forEach((p, i) => {
        const pt = readPoint2(p, `${path}.points[${i}]`, errors);
        if (!pt) ok = false;
        else points.push(pt);
      });
      if (!ok) return null;
      return { kind: "polygon", id, points };
    }
    case "slot": {
      const start = readPoint2(raw.start, `${path}.start`, errors);
      const end = readPoint2(raw.end, `${path}.end`, errors);
      const width = requirePositiveNumber(raw.width, `${path}.width`, errors);
      if (!start || !end || width === null) return null;
      return { kind: "slot", id, start, end, width };
    }
    case "regularPolygon": {
      const center = readPoint2(raw.center, `${path}.center`, errors);
      const radius = requirePositiveNumber(raw.radius, `${path}.radius`, errors);
      const sides = requireSideCount(raw.sides, `${path}.sides`, errors);
      const rotationRaw = raw.rotation;
      let rotation: number | undefined;
      if (rotationRaw !== null && rotationRaw !== undefined) {
        const parsed = requireFiniteNumber(rotationRaw, `${path}.rotation`, errors);
        if (parsed === null) return null;
        rotation = parsed;
      }
      if (!center || radius === null || sides === null) return null;
      return {
        kind: "regularPolygon",
        id,
        center,
        radius,
        sides,
        ...(rotation !== undefined ? { rotation } : {}),
      };
    }
    default:
      errors.push(`${path}.kind`, `未対応の図形種別です: ${JSON.stringify(kind)}(rectangle/circle/polygon/slot/regularPolygonのいずれか)`);
      return null;
  }
}

function compileSegment(raw: unknown, index: number, ctx: SketchCompileContext, errors: ErrorCollector): SketchSegment | null {
  const path = `${ctx.path}.segments[${index}]`;
  if (!isRecord(raw)) {
    errors.push(path, "オブジェクトである必要があります");
    return null;
  }
  const kind = raw.kind;
  const id = raw.id;
  if (!isNonEmptyString(id)) {
    errors.push(`${path}.id`, "空でない文字列である必要があります");
    return null;
  }
  if (ctx.segmentIds.has(id)) {
    errors.push(path, `スケッチ要素ID "${id}" がスケッチ内で重複しています`);
    return null;
  }
  if (kind !== "line" && kind !== "arc") {
    errors.push(`${path}.kind`, `未対応の線分/円弧種別です: ${JSON.stringify(kind)}("line"または"arc")`);
    return null;
  }
  const p1 = readPoint2(raw.p1, `${path}.p1`, errors);
  const p2 = readPoint2(raw.p2, `${path}.p2`, errors);
  if (!p1 || !p2) return null;
  const dx = p1[0] - p2[0];
  const dy = p1[1] - p2[1];
  if (Math.sqrt(dx * dx + dy * dy) <= 1e-6) {
    errors.push(path, "始点と終点が一致しています(同一点)");
    return null;
  }
  ctx.segmentIds.add(id);
  ctx.segmentKindById.set(id, kind);
  if (kind === "line") {
    return { kind: "line", id, p1, p2 };
  }
  const bulge = raw.bulge;
  if (!isFiniteNumber(bulge)) {
    errors.push(`${path}.bulge`, "有限数である必要があります");
    return null;
  }
  return { kind: "arc", id, p1, p2, bulge };
}

/** PointRefのsegmentIdがこのスケッチ内に存在するかを確認する(存在しなければエラーを積みnullを返す)。 */
function resolvePointRef(
  ref: { segmentId: string; point: "start" | "end" },
  path: string,
  ctx: SketchCompileContext,
  errors: ErrorCollector,
): PointRef | null {
  if (!ctx.segmentIds.has(ref.segmentId)) {
    errors.push(path, `"${ref.segmentId}" というIDのスケッチ要素が見つかりません`);
    return null;
  }
  return { segmentId: ref.segmentId, end: ref.point === "start" ? "p1" : "p2" };
}

function compileConstraint(raw: unknown, index: number, ctx: SketchCompileContext, errors: ErrorCollector): SketchConstraint | null {
  const path = `${ctx.path}.constraints[${index}]`;
  if (!isRecord(raw)) {
    errors.push(path, "オブジェクトである必要があります");
    return null;
  }
  const kind = raw.kind;
  const id = generateId("constraint");

  switch (kind) {
    case "distance": {
      const aRaw = readPointRef(raw.a, `${path}.a`, errors);
      const bRaw = readPointRef(raw.b, `${path}.b`, errors);
      const value = raw.value;
      if (!isFiniteNumber(value) || value < 0) errors.push(`${path}.value`, "0以上の有限数である必要があります");
      if (!aRaw || !bRaw || !isFiniteNumber(value) || value < 0) return null;
      const a = resolvePointRef(aRaw, `${path}.a`, ctx, errors);
      const b = resolvePointRef(bRaw, `${path}.b`, ctx, errors);
      if (!a || !b) return null;
      return { id, kind: "distance", a, b, value };
    }
    case "radius": {
      const segment = raw.segment;
      const value = raw.value;
      if (!isNonEmptyString(segment)) {
        errors.push(`${path}.segment`, "空でない文字列である必要があります");
      }
      if (!isPositiveFiniteNumber(value)) errors.push(`${path}.value`, "正の数である必要があります");
      if (!isNonEmptyString(segment) || !isPositiveFiniteNumber(value)) return null;
      if (!ctx.segmentIds.has(segment)) {
        errors.push(path, `"${segment}" というIDのスケッチ要素が見つかりません`);
        return null;
      }
      if (ctx.segmentKindById.get(segment) !== "arc") {
        errors.push(path, `半径拘束は円弧にのみ指定できます("${segment}"はarcではありません)`);
        return null;
      }
      return { id, kind: "radius", segmentId: segment, value };
    }
    case "horizontal":
    case "vertical": {
      const segment = raw.segment;
      if (!isNonEmptyString(segment)) {
        errors.push(`${path}.segment`, "空でない文字列である必要があります");
        return null;
      }
      if (!ctx.segmentIds.has(segment)) {
        errors.push(path, `"${segment}" というIDのスケッチ要素が見つかりません`);
        return null;
      }
      return { id, kind, segmentId: segment };
    }
    case "coincident": {
      const aRaw = readPointRef(raw.a, `${path}.a`, errors);
      const bRaw = readPointRef(raw.b, `${path}.b`, errors);
      if (!aRaw || !bRaw) return null;
      const a = resolvePointRef(aRaw, `${path}.a`, ctx, errors);
      const b = resolvePointRef(bRaw, `${path}.b`, ctx, errors);
      if (!a || !b) return null;
      return { id, kind: "coincident", a, b };
    }
    default:
      errors.push(`${path}.kind`, `未対応の拘束種別です: ${JSON.stringify(kind)}(distance/radius/horizontal/vertical/coincidentのいずれか)`);
      return null;
  }
}

interface CompiledSketch {
  authoringId: string;
  feature: SketchFeature;
}

function compileSketch(raw: unknown, index: number, errors: ErrorCollector): CompiledSketch | null {
  const path = `sketches[${index}]`;
  if (!isRecord(raw)) {
    errors.push(path, "オブジェクトである必要があります");
    return null;
  }
  const authoringId = raw.id;
  if (!isNonEmptyString(authoringId)) {
    errors.push(`${path}.id`, "空でない文字列である必要があります");
    return null;
  }
  const plane = raw.plane;
  if (plane !== "XY" && plane !== "XZ" && plane !== "YZ") {
    errors.push(`${path}.plane`, `"XY"/"XZ"/"YZ"のいずれかである必要があります`);
    return null;
  }
  const entitiesRaw = raw.entities;
  const segmentsRaw = raw.segments;
  const constraintsRaw = raw.constraints;
  if (entitiesRaw !== undefined && !Array.isArray(entitiesRaw)) {
    errors.push(`${path}.entities`, "配列である必要があります");
    return null;
  }
  if (segmentsRaw !== undefined && !Array.isArray(segmentsRaw)) {
    errors.push(`${path}.segments`, "配列である必要があります");
    return null;
  }
  if (constraintsRaw !== undefined && !Array.isArray(constraintsRaw)) {
    errors.push(`${path}.constraints`, "配列である必要があります");
    return null;
  }

  const ctx: SketchCompileContext = {
    path,
    entityIds: new Set(),
    segmentIds: new Set(),
    segmentKindById: new Map(),
  };

  const entities: SketchEntity[] = [];
  ((entitiesRaw as unknown[] | undefined) ?? []).forEach((e, i) => {
    const compiled = compileEntity(e, i, ctx, errors);
    if (compiled) entities.push(compiled);
  });

  const segments: SketchSegment[] = [];
  ((segmentsRaw as unknown[] | undefined) ?? []).forEach((s, i) => {
    const compiled = compileSegment(s, i, ctx, errors);
    if (compiled) segments.push(compiled);
  });

  // 制約はsegments構築後に解決する(前方参照は許容: segments配列内での順序は問わない)。
  const constraints: SketchConstraint[] = [];
  ((constraintsRaw as unknown[] | undefined) ?? []).forEach((c, i) => {
    const compiled = compileConstraint(c, i, ctx, errors);
    if (compiled) constraints.push(compiled);
  });

  if (entities.length === 0 && segments.length === 0) {
    errors.push(path, "図形(entities)またはセグメント(segments)が1つも無く、プロファイルを作れません");
    return null;
  }

  const feature: SketchFeature = {
    type: "sketch",
    id: generateId("sketch"),
    name: `Sketch${index + 1}`,
    plane: { kind: "world", plane },
    entities,
    ...(segments.length > 0 ? { segments } : {}),
    ...(constraints.length > 0 ? { constraints } : {}),
  };
  return { authoringId, feature };
}

interface FeatureCompileState {
  /** 著作スキーマのsketch id -> 内部sketch feature id。 */
  sketchIdMap: Map<string, string>;
  /** 著作スキーマのfeature id(明示的に指定されたもののみ) -> 内部feature id。 */
  featureIdMap: Map<string, string>;
  /** これまでに登場したnewBody系フィーチャーの内部id集合(targetBody省略時のデフォルト解決用)。 */
  bodyFeatureIds: string[];
  extrudeCount: number;
  revolveCount: number;
}

/**
 * targetBody(著作スキーマの文字列参照、省略可)を解決する。省略時は直近のボディを対象にする
 * (内部評価側のデフォルト挙動と同じ)。参照先が無い/newBody系フィーチャーでない場合はエラーを積む。
 * ボディが1つも存在しない状態でcut/addを行おうとした場合もここでエラーになる。
 */
function resolveTargetBody(
  targetBodyRaw: unknown,
  path: string,
  state: FeatureCompileState,
  errors: ErrorCollector,
): { targetBodyId?: string; ok: boolean } {
  if (targetBodyRaw === null || targetBodyRaw === undefined) {
    if (state.bodyFeatureIds.length === 0) {
      errors.push(path, "まだボディが1つも作られていない状態でcut/add操作を行おうとしています(先にoperation:\"newBody\"のフィーチャーが必要です)");
      return { ok: false };
    }
    return { ok: true };
  }
  if (!isNonEmptyString(targetBodyRaw)) {
    errors.push(`${path}.targetBody`, "文字列またはnullである必要があります");
    return { ok: false };
  }
  const internalId = state.featureIdMap.get(targetBodyRaw);
  if (!internalId || !state.bodyFeatureIds.includes(internalId)) {
    errors.push(path, `"${targetBodyRaw}" というIDの対象ボディ(newBody操作のフィーチャー)が見つかりません`);
    return { ok: false };
  }
  return { targetBodyId: internalId, ok: true };
}

function registerFeatureId(idRaw: unknown, internalId: string, path: string, state: FeatureCompileState, errors: ErrorCollector): boolean {
  if (idRaw === null || idRaw === undefined) return true;
  if (!isNonEmptyString(idRaw)) {
    errors.push(`${path}.id`, "文字列またはnullである必要があります");
    return false;
  }
  if (state.featureIdMap.has(idRaw)) {
    errors.push(path, `フィーチャーID "${idRaw}" が重複しています`);
    return false;
  }
  state.featureIdMap.set(idRaw, internalId);
  return true;
}

function compileFeature(raw: unknown, index: number, state: FeatureCompileState, errors: ErrorCollector): Feature | null {
  const path = `features[${index}]`;
  if (!isRecord(raw)) {
    errors.push(path, "オブジェクトである必要があります");
    return null;
  }
  const type = raw.type;
  const sketchAuthoringId = raw.sketch;
  if (!isNonEmptyString(sketchAuthoringId)) {
    errors.push(`${path}.sketch`, "空でない文字列である必要があります");
    return null;
  }
  const sketchId = state.sketchIdMap.get(sketchAuthoringId);
  if (!sketchId) {
    errors.push(`${path}.sketch`, `"${sketchAuthoringId}" というIDのスケッチがありません`);
    return null;
  }
  const operation = raw.operation;
  if (operation !== "newBody" && operation !== "add" && operation !== "cut") {
    errors.push(`${path}.operation`, `"newBody"/"add"/"cut"のいずれかである必要があります`);
    return null;
  }

  if (type === "extrude") {
    const distance = raw.distance;
    if (!isPositiveFiniteNumber(distance)) {
      errors.push(`${path}.distance`, "正の数である必要があります");
      return null;
    }
    const directionRaw = raw.direction;
    let direction: 1 | -1 = 1;
    if (directionRaw !== null && directionRaw !== undefined) {
      if (directionRaw !== 1 && directionRaw !== -1) {
        errors.push(`${path}.direction`, "1、-1、またはnullである必要があります");
        return null;
      }
      direction = directionRaw;
    }
    const internalId = generateId("extrude");
    if (!registerFeatureId(raw.id, internalId, path, state, errors)) return null;
    const targetBodyResult = operation === "newBody" ? { ok: true } : resolveTargetBody(raw.targetBody, path, state, errors);
    if (!targetBodyResult.ok) return null;
    state.extrudeCount += 1;
    const feature: Feature = {
      type: "extrude",
      id: internalId,
      name: `Extrude${state.extrudeCount}`,
      sketchId,
      distance,
      direction,
      operation,
      ...(targetBodyResult.targetBodyId ? { targetBodyId: targetBodyResult.targetBodyId } : {}),
    };
    if (operation === "newBody") state.bodyFeatureIds.push(internalId);
    return feature;
  }

  if (type === "revolve") {
    const axis = raw.axis;
    if (axis !== "x" && axis !== "y") {
      errors.push(`${path}.axis`, `"x"または"y"である必要があります`);
      return null;
    }
    const angleRaw = raw.angle;
    let angle = 360;
    if (angleRaw !== null && angleRaw !== undefined) {
      if (!isFiniteNumber(angleRaw) || angleRaw <= 0 || angleRaw > 360) {
        errors.push(`${path}.angle`, "0より大きく360以下の数値、またはnullである必要があります");
        return null;
      }
      angle = angleRaw;
    }
    const internalId = generateId("revolve");
    if (!registerFeatureId(raw.id, internalId, path, state, errors)) return null;
    const targetBodyResult = operation === "newBody" ? { ok: true } : resolveTargetBody(raw.targetBody, path, state, errors);
    if (!targetBodyResult.ok) return null;
    state.revolveCount += 1;
    const feature: Feature = {
      type: "revolve",
      id: internalId,
      name: `Revolve${state.revolveCount}`,
      sketchId,
      axis,
      angle,
      operation,
      ...(targetBodyResult.targetBodyId ? { targetBodyId: targetBodyResult.targetBodyId } : {}),
    };
    if (operation === "newBody") state.bodyFeatureIds.push(internalId);
    return feature;
  }

  errors.push(`${path}.type`, `未対応のフィーチャー種別です: ${JSON.stringify(type)}("extrude"または"revolve")`);
  return null;
}

/**
 * アウソリングスキーマ(AuthoringModel、src/ai/authoringSchema.ts)のJSONを検証し、内部の
 * CadDocumentへ変換する。エラーがあれば{errors}(日本語+JSONパス)を返す。純粋関数(Worker/DOM/
 * ネットワークへ一切アクセスしない)なのでテストしやすい。
 * 注意: 拘束(constraints)を持つスケッチのsegmentsは、この関数では「解いていない」座標のまま返す
 * (PlaneGCSソルバはWASM初期化が必要な非同期処理のため、ここでは行わない)。呼び出し側
 * (src/ai/generate.ts)がsrc/sketch/solver.tsのsolveDocumentSketchesAsync()で解いてから
 * ドライラン評価・最終読み込みに使うこと。
 */
export function compileAuthoringModel(json: unknown): CompileResult {
  const errors = new ErrorCollector();

  if (!isRecord(json)) {
    errors.push("root", "JSONオブジェクトである必要があります");
    return { errors: errors.errors };
  }
  if (!Array.isArray(json.sketches)) {
    errors.push("sketches", "配列である必要があります");
  }
  if (!Array.isArray(json.features)) {
    errors.push("features", "配列である必要があります");
  }
  if (errors.hasErrors) return { errors: errors.errors };

  const sketchesRaw = json.sketches as unknown[];
  const featuresRaw = json.features as unknown[];

  if (sketchesRaw.length === 0) {
    errors.push("sketches", "少なくとも1つのスケッチが必要です");
  }
  if (featuresRaw.length === 0) {
    errors.push("features", "少なくとも1つのフィーチャー(extrude/revolve)が必要です");
  }

  const sketchFeatures: SketchFeature[] = [];
  const sketchIdMap = new Map<string, string>();
  const seenSketchAuthoringIds = new Set<string>();
  sketchesRaw.forEach((raw, i) => {
    const compiled = compileSketch(raw, i, errors);
    if (!compiled) return;
    if (seenSketchAuthoringIds.has(compiled.authoringId)) {
      errors.push(`sketches[${i}]`, `スケッチID "${compiled.authoringId}" が重複しています`);
      return;
    }
    seenSketchAuthoringIds.add(compiled.authoringId);
    sketchIdMap.set(compiled.authoringId, compiled.feature.id);
    sketchFeatures.push(compiled.feature);
  });

  const state: FeatureCompileState = {
    sketchIdMap,
    featureIdMap: new Map(),
    bodyFeatureIds: [],
    extrudeCount: 0,
    revolveCount: 0,
  };

  const compiledFeatures: Feature[] = [];
  featuresRaw.forEach((raw, i) => {
    const feature = compileFeature(raw, i, state, errors);
    if (feature) compiledFeatures.push(feature);
  });

  if (errors.hasErrors) return { errors: errors.errors };

  const doc: CadDocument = {
    version: 1,
    features: [...sketchFeatures, ...compiledFeatures],
  };
  return { doc };
}
