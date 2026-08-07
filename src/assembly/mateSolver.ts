// 合致(メイト)ソルバ(Phase 28c)。ReactにもThree.jsにもReplicad(OCCT)にも依存しない
// 純粋TypeScript(src/sketch/solver.tsと同じ方針)。
//
// 変数モデル: 合致(MateInput)群に関与するpartInstanceごとに6変数
// (position[x,y,z] + rotation[rx,ry,rz]度、いずれもワールド座標系)を持つ。合致に関与しない
// partInstance・通常ボディは固定として扱う(残差計算には現れるが、変数ベクトルには含まれない)。
//
// 解法: src/sketch/solver.tsと同じLevenberg-Marquardt法(2段階: 正則化ありのウォームアップ→
// 正則化なしの仕上げ)を踏襲するが、ヤコビアンは解析的に導出せず中心差分の数値微分で求める
// (残差式が面同士の幾何関係で複雑になるため。値自体は厳密なので収束判定・矛盾判定には影響しない)。
// 正規方程式(J^T*J + λ*diag)Δ = -J^T*r を解く部分はsolver.tsのsolveLinearSystem()を再利用する。
import { solveLinearSystem } from "../sketch/solver";

export type Tuple3 = [number, number, number];

function dot(a: Tuple3, b: Tuple3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Tuple3, b: Tuple3): Tuple3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function subtract(a: Tuple3, b: Tuple3): Tuple3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add(a: Tuple3, b: Tuple3): Tuple3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: Tuple3, s: number): Tuple3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function length(a: Tuple3): number {
  return Math.sqrt(dot(a, a));
}
function normalize(a: Tuple3): Tuple3 {
  const len = length(a);
  if (len < 1e-12) return a;
  return [a[0] / len, a[1] / len, a[2] / len];
}

/** 合致の残差計算対象になる面ジオメトリ(平面=中心+法線、円筒=軸上の点+軸方向)。 */
export type MateGeom = { surface: "plane"; center: Tuple3; normal: Tuple3 } | { surface: "cylinder"; axisPoint: Tuple3; axisDir: Tuple3 };

/**
 * 合致1面分の入力。"fixed"はワールド座標で固定(通常ボディ、または合致に関与しない部品)、
 * "variable"はpartId(partInstanceのfeatureId)の6変数で毎反復ワールド座標へ変換される
 * (localはpartInstanceローカル原点基準のジオメトリ)。
 */
export type MateFaceInput = { kind: "fixed"; geom: MateGeom } | { kind: "variable"; partId: string; local: MateGeom };

export interface MateInput {
  /** 元のmateフィーチャーのid(収束エラー時の帰属表示に使う)。 */
  id: string;
  kind: "coincident" | "distance" | "concentric";
  /** kind:"distance"のときのみ使う(mm)。 */
  value?: number;
  a: MateFaceInput;
  b: MateFaceInput;
}

export interface PartPlacement {
  position: Tuple3;
  rotation: Tuple3;
}

export interface MateSolveSuccess {
  ok: true;
  /** partId(partInstanceのfeatureId) -> 解いた配置。合致に関与するpartInstanceのみを含む。 */
  placements: Map<string, PartPlacement>;
}

export interface MateSolveFailure {
  ok: false;
  /** 収束できなかった合致の中で最も残差が大きかったもの(エラー表示のfeatureId付与に使う)。 */
  worstMateId: string;
  maxResidual: number;
}

export type MateSolveResult = MateSolveSuccess | MateSolveFailure;

/** LMの最大反復回数(ウォームアップ・仕上げそれぞれ)。 */
const MAX_ITERATIONS = 60;
/** 残差ノルムがこれを下回れば収束とみなし反復を打ち切る。 */
const CONVERGE_NORM = 1e-8;
/** 収束後、各合致の残差(正則化を除く)の絶対値最大がこれを超えていれば矛盾とみなす。 */
const CONFLICT_TOLERANCE = 1e-4;
/** 正則化(初期値からの移動量)の重み(位置、mm)。値が小さいほど拘束(合致)を優先する。 */
const REGULARIZATION_WEIGHT = 1e-4;
/**
 * 正則化の重み(回転、ラジアン)。位置用より大幅に大きくする(実装検証で判明した理由:
 * 面中心が部品原点[position]から離れているほど、その面の残差[距離]は回転に対して
 * 「てこの原理」で過敏になる[距離残差の回転方向の感度 ≈ 面中心と目標点の距離]。
 * position用と同じ重みのままだと、LMが「本来動かすべきでない回転」を経由して局所的に
 * 残差を稼ごうとし、位置が本来の解から大きくドリフトしたまま収束しなくなる現象を
 * 実装検証で確認した。回転の正則化を強くすることで、真に必要な場合(大きな向き違い)を
 * 除き、この「てこ」を利用した見せかけの改善を抑制し、並進のみで解ける合致は並進のみで
 * 解かれるようにする。値は複数の実データ(部品位置60mm程度のオフセット)で収束を確認した
 * 上での経験的な選択。
 */
const ROTATION_REGULARIZATION_WEIGHT = 1000;
/** 中心差分の数値微分ステップ幅(mm・度共通)。 */
const NUMERIC_DIFF_H = 1e-6;
/** LMの減衰係数の初期値・上限。 */
const INITIAL_LAMBDA = 1e-3;
const MAX_LAMBDA = 1e12;
/** 出力座標を丸めるグリッド幅(mm・度)。solveSketch()のROUND_GRIDと同じ「きれいな値に丸めて次回のドリフトを防ぐ」意図。 */
const ROUND_GRID = 1e-6;

/**
 * XYZオイラー角(ラジアン、X軸回転→Y軸回転→Z軸回転の順)の合成回転行列。replicadのShape3D#rotate()を
 * 同じ順序(X, Y, Zの順に world 軸まわりへ回転)で連続適用する変換と一致させる
 * (src/worker/evaluator.tsのapplyPartInstanceToBodies参照)。
 *
 * 単位について: ソルバの変数ベクトル(x[3..5])は意図的にラジアンで持つ(度ではない)。
 * PartPlacement/PartInstanceFeature.rotationは度で表現するが、度のままLMの変数にすると
 * 「位置(mm、スケール10〜100)」と「回転(度、スケール0〜360だが実際の残差への感度は
 * ラジアン換算でさらに1/57)」の間でJ^T*Jの対角成分(=各変数方向の感度の2乗)が3桁近く
 * 乖離し、正規方程式の条件数が悪化して収束が不安定になる(実装検証で確認: 度のままだと
 * 単純な並進のみで解けるはずの合致が、回転方向に大きくドリフトしたまま収束不能になる
 * ケースがあった)。ラジアンに揃えることで位置・回転の感度スケールが近くなり、数値微分
 * ベースのLMでも安定して収束するようになる。度⇔ラジアンの変換はsolveMates()の入出力境界
 * (初期値の変換・最終placementsの変換)とworldPointToLocal/worldDirectionToLocal
 * (PartInstanceFeature.rotation[度]を受け取るUI向けAPI)でのみ行う。
 */
function rotationMatrixRad(rx: number, ry: number, rz: number): number[][] {
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  // Rx, Ry, Rz(それぞれワールドX/Y/Z軸まわりの右手系回転)。
  const Rx = [
    [1, 0, 0],
    [0, cx, -sx],
    [0, sx, cx],
  ];
  const Ry = [
    [cy, 0, sy],
    [0, 1, 0],
    [-sy, 0, cy],
  ];
  const Rz = [
    [cz, -sz, 0],
    [sz, cz, 0],
    [0, 0, 1],
  ];
  return matMul(Rz, matMul(Ry, Rx));
}

function matMul(a: number[][], b: number[][]): number[][] {
  const out: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return out;
}

function applyMat(m: number[][], v: Tuple3): Tuple3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/** 回転行列の転置(直交行列なので逆行列と一致)。ワールド→ローカル座標の逆変換に使う。 */
function transposeMat(m: number[][]): number[][] {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

/**
 * ワールド座標の点を、partInstanceのposition/rotationを使って部品ローカル座標(部品原点基準)へ
 * 逆変換する(Phase 28c)。合致(メイト)ツールのUI側(src/app/App.tsx)が、ビューアでピックした
 * ワールド座標の面センターを、src/worker/evaluator.tsのlocalFaceIndexById(部品ローカルの
 * 面ジオメトリ索引)と同じ座標系のMateFaceRefへ変換するために使う。
 *
 * 採用理由: replicadのface.hashCodeはShape3D#rotate()/#translate()の適用後は保持されない
 * (実測確認済み: 同一の論理面でもtranslate/rotate前後でhashCode値が完全に変わる)。そのため
 * partInstanceが作ったボディの面参照は、評価のたびに必ず幾何マッチング(center/normalの近さ)の
 * フォールバック経由で解決することになる。マッチング対象のlocalFaceIndexByIdは
 * 「変換前(部品ローカル)」のジオメトリで構築されるため、MateFaceRef側のcenter/normalも
 * 部品ローカル座標系で保存しておく必要がある(ワールド座標のまま保存すると、
 * 部品が原点から離れているほどフォールバック照合が一致しなくなる)。
 */
const DEG_TO_RAD = Math.PI / 180;

/** rotation(度、PartInstanceFeatureと同じ単位)からラジアン版の回転行列を作る(公開API境界用)。 */
function rotationMatrixDeg(rotationDeg: Tuple3): number[][] {
  return rotationMatrixRad(rotationDeg[0] * DEG_TO_RAD, rotationDeg[1] * DEG_TO_RAD, rotationDeg[2] * DEG_TO_RAD);
}

export function worldPointToLocal(worldPoint: Tuple3, position: Tuple3, rotation: Tuple3): Tuple3 {
  const Rt = transposeMat(rotationMatrixDeg(rotation));
  return applyMat(Rt, subtract(worldPoint, position));
}

/** ワールド座標の方向ベクトルを、rotationを使って部品ローカル方向へ逆変換する(平行移動は無関係)。 */
export function worldDirectionToLocal(worldDir: Tuple3, rotation: Tuple3): Tuple3 {
  const Rt = transposeMat(rotationMatrixDeg(rotation));
  return applyMat(Rt, worldDir);
}

/**
 * ローカル面ジオメトリを、6変数スライス[px,py,pz,rx,ry,rz]の現在値でワールド座標へ写像する。
 * rx/ry/rzはラジアン(ソルバの変数は度ではなくラジアンで持つ。rotationMatrixRadのコメント参照)。
 */
function transformGeom(local: MateGeom, slice: readonly number[]): MateGeom {
  const R = rotationMatrixRad(slice[3], slice[4], slice[5]);
  const t: Tuple3 = [slice[0], slice[1], slice[2]];
  if (local.surface === "plane") {
    return { surface: "plane", center: add(applyMat(R, local.center), t), normal: applyMat(R, local.normal) };
  }
  return { surface: "cylinder", axisPoint: add(applyMat(R, local.axisPoint), t), axisDir: applyMat(R, local.axisDir) };
}

/** 合致1面分の、現在の変数ベクトルxにおけるワールドジオメトリを求める。 */
function sampleSide(side: MateFaceInput, varIndex: ReadonlyMap<string, number>, x: readonly number[]): MateGeom {
  if (side.kind === "fixed") return side.geom;
  const base = varIndex.get(side.partId);
  if (base === undefined) return side.local;
  return transformGeom(side.local, x.slice(base, base + 6));
}

/**
 * 1つの合致の残差配列を返す。
 * coincident/distance(両面平面前提): [法線のcross×3、dot(nA,nB)+1、面B中心から面Aへの符号付き距離-value]
 *   (cross成分は3つとも使う。true解では自動的に0になるため冗長にはなるが、2成分を恣意的に選ぶ
 *   basisの取り方に依存しないぶん頑健。詳細はdocs/PLAN.mdのPhase 28c節参照)。
 * concentric(両面円筒前提): [軸方向のcross×3、軸上点間の垂直成分ベクトル×3]
 *   (垂直成分ベクトルは既に軸方向の投影を除いてあるため2自由度しか持たないが、3成分のまま残差にする)。
 */
function mateResiduals(mate: MateInput, varIndex: ReadonlyMap<string, number>, x: readonly number[]): number[] {
  const a = sampleSide(mate.a, varIndex, x);
  const b = sampleSide(mate.b, varIndex, x);

  if (mate.kind === "concentric") {
    if (a.surface !== "cylinder" || b.surface !== "cylinder") return [0, 0, 0, 0, 0, 0];
    const dirA = normalize(a.axisDir);
    const cr = cross(dirA, normalize(b.axisDir));
    const rel = subtract(b.axisPoint, a.axisPoint);
    const along = dot(rel, dirA);
    const perp = subtract(rel, scale(dirA, along));
    return [cr[0], cr[1], cr[2], perp[0], perp[1], perp[2]];
  }

  if (a.surface !== "plane" || b.surface !== "plane") return [0, 0, 0, 0];
  const nA = normalize(a.normal);
  const nB = normalize(b.normal);
  const cr = cross(nA, nB);
  const dotResidual = dot(nA, nB) + 1;
  const offset = mate.kind === "distance" ? (mate.value ?? 0) : 0;
  const distResidual = dot(subtract(b.center, a.center), nA) - offset;
  return [cr[0], cr[1], cr[2], dotResidual, distResidual];
}

function computeAllResiduals(
  mates: readonly MateInput[],
  varIndex: ReadonlyMap<string, number>,
  x: readonly number[],
): { flat: number[]; perMate: number[][] } {
  const perMate: number[][] = [];
  const flat: number[] = [];
  for (const mate of mates) {
    const r = mateResiduals(mate, varIndex, x);
    perMate.push(r);
    flat.push(...r);
  }
  return { flat, perMate };
}

function numericJacobian(residualFn: (x: number[]) => number[], x: readonly number[], r0: readonly number[]): number[][] {
  const m = r0.length;
  const n = x.length;
  const J: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
  for (let j = 0; j < n; j += 1) {
    const plus = x.slice();
    plus[j] += NUMERIC_DIFF_H;
    const minus = x.slice();
    minus[j] -= NUMERIC_DIFF_H;
    const rPlus = residualFn(plus);
    const rMinus = residualFn(minus);
    for (let i = 0; i < m; i += 1) J[i][j] = (rPlus[i] - rMinus[i]) / (2 * NUMERIC_DIFF_H);
  }
  return J;
}

function norm(r: readonly number[]): number {
  let sum = 0;
  for (const v of r) sum += v * v;
  return Math.sqrt(sum);
}
function cost(r: readonly number[]): number {
  let sum = 0;
  for (const v of r) sum += v * v;
  return sum;
}

/** src/sketch/solver.tsのrunLevenbergMarquardt()と同じ2フェーズLM反復。ヤコビアンのみ数値微分。 */
function runLM(residualFn: (x: number[]) => number[], x0: readonly number[], maxIterations: number): number[] {
  let x = [...x0];
  let lambda = INITIAL_LAMBDA;

  for (let iter = 0; iter < maxIterations; iter += 1) {
    const r = residualFn(x);
    if (norm(r) < CONVERGE_NORM) break;
    const J = numericJacobian(residualFn, x, r);
    const m = x.length;
    const jtj: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
    const jtr: number[] = new Array(m).fill(0);
    for (let i = 0; i < J.length; i += 1) {
      for (let a = 0; a < m; a += 1) {
        jtr[a] += J[i][a] * r[i];
        for (let bIdx = 0; bIdx < m; bIdx += 1) jtj[a][bIdx] += J[i][a] * J[i][bIdx];
      }
    }
    const currentCost = cost(r);

    let improved = false;
    for (let attempt = 0; attempt < 20 && !improved; attempt += 1) {
      const damped = jtj.map((row, i) => row.map((v, j) => (i === j ? v + lambda * Math.max(v, 1e-3) : v)));
      const rhs = jtr.map((v) => -v);
      const delta = solveLinearSystem(damped, rhs);
      if (!delta) {
        lambda = Math.min(lambda * 10, MAX_LAMBDA);
        if (lambda >= MAX_LAMBDA) break;
        continue;
      }
      const xTry = x.map((v, i) => v + delta[i]);
      const costTry = cost(residualFn(xTry));
      if (costTry < currentCost) {
        x = xTry;
        lambda = Math.max(lambda / 10, 1e-6);
        improved = true;
      } else {
        lambda = Math.min(lambda * 10, MAX_LAMBDA);
        if (lambda >= MAX_LAMBDA) break;
      }
    }
    if (!improved) break;
  }

  return x;
}

function roundToGrid(v: number): number {
  return Math.round(v / ROUND_GRID) * ROUND_GRID;
}

/**
 * mates群をまとめて解く。関与するpartInstance(featureId)ごとに6変数(position+rotation)を持ち、
 * initialPlacements(現在のドキュメントの値、無ければ[0,0,0]/[0,0,0])を初期値として
 * ウォームアップ(正則化あり)→仕上げ(正則化なし)の2段階LMで解く。
 * 収束後、いずれかの合致の残差(正則化を除く)の絶対値最大がCONFLICT_TOLERANCEを超えていれば
 * ok:falseを返す(worstMateIdは残差が最大だった合致のid)。
 */
export function solveMates(mates: readonly MateInput[], initialPlacements: ReadonlyMap<string, PartPlacement>): MateSolveResult {
  const partIds: string[] = [];
  const seen = new Set<string>();
  for (const mate of mates) {
    for (const side of [mate.a, mate.b]) {
      if (side.kind === "variable" && !seen.has(side.partId)) {
        seen.add(side.partId);
        partIds.push(side.partId);
      }
    }
  }

  if (partIds.length === 0 || mates.length === 0) {
    return { ok: true, placements: new Map() };
  }

  const varIndex = new Map<string, number>();
  partIds.forEach((id, i) => varIndex.set(id, i * 6));
  const m = partIds.length * 6;

  const x0 = new Array(m).fill(0);
  partIds.forEach((id, i) => {
    const placement = initialPlacements.get(id) ?? { position: [0, 0, 0] as Tuple3, rotation: [0, 0, 0] as Tuple3 };
    const base = i * 6;
    x0[base] = placement.position[0];
    x0[base + 1] = placement.position[1];
    x0[base + 2] = placement.position[2];
    // 回転はラジアンで変数化する(rotationMatrixRadのコメント参照。位置[mm]とスケールを
    // 揃えることでLMの条件数が改善する)。
    x0[base + 3] = placement.rotation[0] * DEG_TO_RAD;
    x0[base + 4] = placement.rotation[1] * DEG_TO_RAD;
    x0[base + 5] = placement.rotation[2] * DEG_TO_RAD;
  });

  const buildHardResiduals = (x: number[]): number[] => computeAllResiduals(mates, varIndex, x).flat;
  const sqrtPositionWeight = Math.sqrt(REGULARIZATION_WEIGHT);
  const sqrtRotationWeight = Math.sqrt(ROTATION_REGULARIZATION_WEIGHT);
  // 変数インデックス i%6 が 0,1,2(position)なら位置用、3,4,5(rotation)なら回転用の重みを使う。
  const buildWarmupResiduals = (x: number[]): number[] => [
    ...buildHardResiduals(x),
    ...x.map((v, i) => (i % 6 < 3 ? sqrtPositionWeight : sqrtRotationWeight) * (v - x0[i])),
  ];

  const warm = runLM(buildWarmupResiduals, x0, MAX_ITERATIONS);
  const solved = runLM(buildHardResiduals, warm, MAX_ITERATIONS);

  const { perMate } = computeAllResiduals(mates, varIndex, solved);
  let worstId = mates[0].id;
  let worstVal = 0;
  for (let i = 0; i < perMate.length; i += 1) {
    const maxAbs = perMate[i].reduce((acc, v) => Math.max(acc, Math.abs(v)), 0);
    if (maxAbs > worstVal) {
      worstVal = maxAbs;
      worstId = mates[i].id;
    }
  }
  if (worstVal > CONFLICT_TOLERANCE) {
    return { ok: false, worstMateId: worstId, maxResidual: worstVal };
  }

  const RAD_TO_DEG = 180 / Math.PI;
  const placements = new Map<string, PartPlacement>();
  partIds.forEach((id, i) => {
    const base = i * 6;
    placements.set(id, {
      position: [roundToGrid(solved[base]), roundToGrid(solved[base + 1]), roundToGrid(solved[base + 2])],
      rotation: [
        roundToGrid(solved[base + 3] * RAD_TO_DEG),
        roundToGrid(solved[base + 4] * RAD_TO_DEG),
        roundToGrid(solved[base + 5] * RAD_TO_DEG),
      ],
    });
  });
  return { ok: true, placements };
}
