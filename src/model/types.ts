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
  /**
   * SolidWorksスケッチの「点」相当の自由点(Phase 47)。ボディの押し出し/カットには使わない
   * (regions.ts等の閉領域検出の対象外)、位置決め専用のマーカー。GCSでは自由な点として扱われ、
   * circleのcenterと同様に一致・距離拘束や寸法の対象になる(src/sketch/gcsAdapter.ts参照)。
   */
  | { kind: "point"; id: string; position: [number, number] }
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
 * segments内の円弧セグメント(kind:"arc"かつbulgeが非0)を指す参照(Phase 42b、円弧の一級化)。
 * EntityRef({entityId})と構造的に区別できるよう、あえてsegmentIdのみを持つ最小形にする
 * (`"entityId" in ref`で判別する既存の慣習[coincidentOriginのpoint等]と同じ設計)。
 * tangent.entity・concentric.a/bがcircleエンティティと並んで円弧セグメントも指せるようにするために使う。
 */
export type ArcRef = { segmentId: string };

/**
 * 円の中心↔辺の距離拘束(distanceEntityLine)が参照する「辺」(Phase 22)。
 * "entityEdge" は rectangle/polygon エンティティの辺(edgeIndex: rectangleは0=下/1=右/2=上/3=左、
 * polygonはpoints[i]→points[i+1 mod n])を指し、エンティティが動けば辺も追従する(常に生値から解決)。
 * "segmentEdge" は自由な線分セグメント(kind:"line"、rectangle/polygonエンティティに属さない、
 * 例: 線分ツールで描いた矩形状のチェーン)本体を指す(ユーザー報告対応: 矩形を線分チェーンとして
 * 描いた場合にdistanceEntityLineが常にrefEdge[固定]化され、円を固定すると矛盾になっていたバグの
 * 修正。segmentIdの指す2端点は元々ソルバの変数[varIndex]なので、entityEdgeと同様にエンティティ
 * ではなく線分自体が動く)。
 * "refEdge" はボディ端面参照(Phase 22、src/worker/evaluator.tsのreferenceEdges)のスナップショットで、
 * p1/p2はピック時点のスケッチローカル2D座標を凍結したもの。再評価のたびに
 * src/sketch/referenceEdgeMatch.ts が最新のreferenceEdgesと幾何マッチングして更新を試みる
 * (マッチしなければスナップショットを維持する。既知の制限)。
 */
export type LineRef =
  | { kind: "entityEdge"; entityId: string; edgeIndex: number }
  | { kind: "segmentEdge"; segmentId: string }
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
  | { id: string; kind: "length"; segmentId: string; value: number; labelOffset?: [number, number] }
  /**
   * 2点間の距離(mm)。同一セグメント内・別セグメント間のどちらの点も指定できる。
   * axis(頂点ベースの寸法指定、Phase 30。省略=direct・後方互換)は"x"/"y"のとき
   * それぞれbx-ax/by-ayのみを距離として扱う(直線距離ではなく片方の軸成分のみを拘束する。
   * distanceEntityEntityのaxisと同じ考え方)。
   * signed(寸法値の符号仕様の明確化、Phase 33。省略=false・後方互換)がtrueかつaxis:"x"/"y"のとき、
   * 残差は|座標2-座標1|-valueではなく(座標2-座標1[=b-a])-valueになる(1点目[a]→2点目[b]の
   * クリック順が符号の基準、0=軸整列、負=bがaより小さい側)。旧データ(signed省略)は従来通り
   * 絶対値(常に非負のvalueを維持する挙動)のまま解釈する。axis:"direct"のときはsignedの影響を受けない
   * (直線距離は常に非負)。
   */
  | { id: string; kind: "distance"; a: PointRef; b: PointRef; value: number; axis?: "direct" | "x" | "y"; signed?: boolean; labelOffset?: [number, number] }
  /**
   * kind:"arc" のセグメントにのみ指定できる半径拘束(mm)。Phase 42bで円弧がPlaneGCSの
   * ネイティブarcプリミティ(中心・半径・start/end角が実変数)になったため、この拘束は
   * 円弧の実際の半径変数(arc_radius)を直接拘束する。端点は半径変更に応じて円周上を
   * 自由に滑る(以前の「bulge=挟角を固定して弦長を調整する」rigid-bulge挙動とは異なる、
   * gcsAdapter.tsのコメント参照)。
   */
  | { id: string; kind: "radius"; segmentId: string; value: number; labelOffset?: [number, number] }
  /** 点を(拘束追加時点の)現在位置に固定する。値はsolveSketch呼び出し時の入力座標から都度求める(拘束自体には持たない)。 */
  | { id: string; kind: "fix"; point: PointRef }
  /**
   * circleエンティティの中心↔原点の距離(mm、Phase 22)。
   * 「原点」はワールド原点(0,0,0)をスケッチ平面へ投影した点と定義する(仕様変更: 以前はスケッチの
   * ローカル原点[0,0]固定だったが、面上スケッチではローカル原点=面の基準点であり、ワールド原点とは
   * 一致しない場合があるため。originLocalはその投影点のスナップショット(スケッチローカル2D、mm)で、
   * refEdge(ボディ端面参照)と同様に評価のたびに最新のsketchPlanes基底から追従・更新される
   * (src/sketch/originSnapshot.ts、src/state/store.tsのapplyEvaluated参照)。省略時(旧データ、または
   * まだ一度も評価応答を受け取っていない新規拘束)はローカル原点[0,0]として扱う(worldOriginLocal()の
   * フォールバック)。
   */
  | {
      id: string;
      kind: "distanceEntityOrigin";
      entity: EntityRef;
      value: number;
      originLocal?: [number, number];
      /**
       * 省略/"direct"は原点までの直線距離、"x"/"y"は片方の軸成分のみ(Phase 35b-2、
       * distancePointOriginのaxisと同じ意味)。
       */
      axis?: "direct" | "x" | "y";
      /** signed(Phase 33と同じ意味)。distancePointOriginと同じく新規作成時のみtrue。 */
      signed?: boolean;
      /** 寸法ラベルのドラッグ移動オフセット(Phase 31a)。省略=既定位置(後方互換)。 */
      labelOffset?: [number, number];
    }
  /**
   * セグメント端点↔原点の距離(mm、追加項目: 原点ピック常時有効化に伴う新設)。
   * distanceEntityOriginの「対象がcircleエンティティではなく自由な線分の端点」版。原点の定義・
   * originLocalスナップショットの扱いはdistanceEntityOriginと同一。
   * axis(頂点ベースの寸法指定、Phase 30。省略=direct・後方互換)は"distance"拘束のaxisと同じ意味
   * (原点のoriginLocal[x,y]を固定側の座標として片方の軸成分のみを拘束する)。
   * signed(寸法値の符号仕様の明確化、Phase 33。省略=false・後方互換)は"distance"拘束のsignedと同じ意味。
   * point-origin間では原点を基準("1点目")・pointを"2点目"として(point[axis]-origin[axis])-valueを残差にする。
   */
  | {
      id: string;
      kind: "distancePointOrigin";
      point: PointRef;
      value: number;
      originLocal?: [number, number];
      axis?: "direct" | "x" | "y";
      signed?: boolean;
      /** 寸法ラベルのドラッグ移動オフセット(Phase 31a)。省略=既定位置(後方互換)。 */
      labelOffset?: [number, number];
    }
  /**
   * セグメント端点、またはcircleエンティティの中心を原点に一致させる(固定、追加項目)。
   * 拘束ツール(垂直・同心・接線と同じ選択ポップアップ)から追加する。残差は対象点の座標そのもの
   * (x,y、fix/fixEntityと似るが目標値が「作成時点の位置」ではなく常に原点である点が異なる)。
   * 原点の定義・originLocalスナップショットの扱いはdistanceEntityOriginと同一。
   */
  | { id: string; kind: "coincidentOrigin"; point: PointRef | EntityRef; originLocal?: [number, number] }
  /**
   * circleエンティティの中心↔中心の距離(mm、Phase 22)。axis(UI改善対応、省略=direct・後方互換)は
   * "x"/"y"のときそれぞれcx_b-cx_a/cy_b-cy_aのみを距離として扱う(中心間の直線距離ではなく、
   * 片方の軸成分のみを拘束する)。
   * signed(寸法値の符号仕様の明確化、Phase 33。省略=false・後方互換)は"distance"拘束のsignedと同じ意味。
   */
  | {
      id: string;
      kind: "distanceEntityEntity";
      a: EntityRef;
      b: EntityRef;
      value: number;
      axis?: "direct" | "x" | "y";
      signed?: boolean;
      /** 寸法ラベルのドラッグ移動オフセット(Phase 31a)。省略=既定位置(後方互換)。 */
      labelOffset?: [number, number];
    }
  /** circleエンティティの中心↔辺(直線、動かない)の垂直距離(mm、Phase 22)。 */
  | { id: string; kind: "distanceEntityLine"; entity: EntityRef; line: LineRef; value: number; labelOffset?: [number, number] }
  /**
   * セグメント端点↔線(rectangle/polygonの辺・自由な線分・参照エッジ)の垂直距離(mm、頂点ベースの
   * 寸法指定、Phase 30新設)。distanceEntityLineの「対象がcircleエンティティの中心ではなく自由な
   * 線分の端点」版で、lineの解決(entityEdge/segmentEdge=可動、refEdge=固定スナップショット)は
   * distanceEntityLineと完全に共通(src/sketch/solver.tsのdistanceEntityLineValue()をそのまま流用)。
   * 挙動の要: 端点に接続する線分に長さ拘束が無ければ線分が伸びて距離を満たし、長さ拘束があれば
   * (端点間距離が固定されるため)線分ごと平行移動する(ソルバの自然な帰結、特別な実装は無い)。
   */
  | { id: string; kind: "distancePointLine"; point: PointRef; line: LineRef; value: number; labelOffset?: [number, number] }
  /** circleエンティティの中心を(拘束追加時点の)現在位置に固定する(Phase 22、固定トグル)。 */
  | { id: string; kind: "fixEntity"; entity: EntityRef }
  /**
   * 円弧セグメント(kind:"arc"かつbulgeあり)の中心座標・半径を(拘束追加時点の)現在の形状から
   * 固定する(Phase 42b新設)。fix/fixEntityと同じく値は持たず、solveSketch呼び出し時の入力
   * segments(p1・p2・bulge)から都度center・radiusを計算して固定する。端点(p1・p2)自体は
   * 固定しない(=固定された円の上を自由に滑れる)点がfixEntity(旧来のrigid-bulge時代に
   * 「両端点をfixする」ことで円弧全体を凍結していた移行先)との違い。
   * trim.tsのmigrateEntityConstraintsForReplace()が、トリムでentity(円)が円弧セグメントへ
   * 置き換わる際、旧fixEntityの意図(「元の円の上に留まる」)を継承するために生成する
   * (ユーザーがこの拘束を直接選ぶUIは持たない)。
   */
  | { id: string; kind: "fixArc"; segmentId: string }
  /** 2本の直線セグメント(kind:"line"のみ対象)が垂直であること(Phase 23)。 */
  | { id: string; kind: "perpendicular"; a: string; b: string }
  /**
   * 2つの中心が一致すること(Phase 23、Phase 42bでcircleエンティティに加え円弧セグメント
   * [ArcRef]も指定可能に拡張。円弧側は中心点[GCSネイティブarcの中心変数]の一致として扱う)。
   */
  | { id: string; kind: "concentric"; a: EntityRef | ArcRef; b: EntityRef | ArcRef }
  /**
   * circleエンティティ、または円弧セグメント(Phase 42bでArcRefを追加)が直線セグメント、
   * または別のcircleエンティティに接すること(Phase 23)。円弧(ArcRef)を指定できるのは
   * target.kind:"segment"(直線)の場合のみ(UI上は「接線」は円弧+直線の組み合わせのみを許可し、
   * 円弧+円/円弧+円弧は「同心」のみを提示する。gcsAdapter.tsのtangent_la実装参照)。
   * target.kind:"segment" は直線セグメント(kind:"line"のみ)への接線(円中心↔直線の距離=半径)。
   * side(実機報告対応、Phase 32)は円の中心が直線のどちら側にあるかを固定する符号(1|-1、
   * lineSideSign()と同じ規約: (中心-p1)×(p2-p1)の外積が負なら-1、それ以外は+1)。拘束作成時点の
   * 現在位置から一度だけ決めて保存し、以後solveSketch()を何度呼んでも(その都度initXから符号を
   * 再計算する旧実装と違い)反対側の解へ非凸的に引っ張られないようにする(省略時はsolveSketch()側で
   * 従来通りinitXから都度計算する後方互換フォールバック、src/sketch/constraintDimensions.tsの
   * addTangentSegmentConstraint参照)。
   * target.kind:"entity" は円同士の接線で、mode:"external"(外接、中心間距離=r1+r2)/
   * "internal"(内接、中心間距離=|r1-r2|)のいずれか。modeは拘束作成時点の現在の中心間距離が
   * external/internalどちらの目標値に近いかで自動選択し、以後は固定値として保存する
   * (src/sketch/constraintGeom.tsのcreateTangentEntityConstraint参照)。
   */
  | {
      id: string;
      kind: "tangent";
      entity: EntityRef | ArcRef;
      target:
        | { kind: "segment"; segmentId: string; side?: 1 | -1 }
        | { kind: "entity"; entityId: string; mode: "external" | "internal" };
    }
  /**
   * 2本の直線セグメント(kind:"line"のみ対象)がほぼ平行なときの、平行距離拘束(Phase 24)。
   * 残差は線分aの両端点それぞれから線分bの無限直線への符号付き垂直距離−value(2残差)。
   * これにより平行(両端点が同じ距離になる)と距離が同時に拘束される。
   */
  | { id: string; kind: "distanceLineLine"; a: string; b: string; value: number; labelOffset?: [number, number] }
  /**
   * 2本の直線セグメント(kind:"line"のみ対象)が非平行なときの、方向のなす角拘束(度、Phase 24)。
   * 残差は方向ベクトルのなす角(atan2ベース、0〜180度)−value。
   */
  | { id: string; kind: "angleLineLine"; a: string; b: string; value: number; labelOffset?: [number, number] }
  /**
   * 直線セグメント(kind:"line")↔参照エッジ(既存ボディの辺、動かない)の平行距離拘束(Phase 24)。
   * distanceLineLineと同形だが、b側がsegmentIdではなくLineRef(常に"refEdge"、ピック時点の
   * スナップショット)である点のみが異なる。残差はsegmentの両端点それぞれからlineへの
   * 符号付き垂直距離−value(2残差、平行化と距離を同時に拘束する)。
   */
  | { id: string; kind: "distanceLineRefEdge"; segmentId: string; line: LineRef; value: number }
  /**
   * 直線セグメント(kind:"line")↔参照エッジの、方向のなす角拘束(度、Phase 24)。angleLineLineと
   * 同形だが、b側がLineRef(固定)である点のみが異なる。残差はsegmentの方向ベクトルとlineの
   * 方向ベクトルのなす角(0〜180度)−value。
   */
  | { id: string; kind: "angleLineRefEdge"; segmentId: string; line: LineRef; value: number };

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
  /**
   * 実測寸法(entities由来、SketchDimension)の寸法ラベルのドラッグ移動オフセット(Phase 31a、省略可・
   * 後方互換)。キーはsrc/sketch/dimensions.tsのdimensionKey()と同じ形式、値はスケッチローカルの
   * オフセットベクトル(mm、src/viewer/dimensionGraphics.tsのoffsetVecパラメータへそのまま渡す)。
   * 拘束由来の寸法(ConstraintDimension)は該当拘束自体のlabelOffsetフィールドを使う(こちらとは別)。
   */
  dimensionOffsets?: Record<string, [number, number]>;
}

/**
 * 押し出しフィーチャー(新規ボディ作成 or 既存ボディへのカット/追加、Phase 27a複数ボディ対応)。
 * targetBodyId は operation:"cut"|"add" のときのみ意味を持つ(newBodyは常に新しいボディを
 * 作るため無視される)。対象ボディを作った newBody フィーチャー(このExtrudeFeature自身、または
 * RevolveFeature)のidを指す。省略時はevaluator.tsが「最後に作られたボディ」(bodiesマップの
 * 挿入順で最後のキー)に自動的に適用する。指定した場合、参照先が存在しない/newBodyでない場合は
 * 評価時にfeatureId付きエラーになる(src/worker/evaluator.tsのapplyBodyOperation参照)。
 */
export interface ExtrudeFeature {
  type: "extrude";
  id: FeatureId;
  name: string;
  sketchId: FeatureId;
  distance: number;
  direction: 1 | -1;
  operation: "newBody" | "cut" | "add";
  targetBodyId?: FeatureId;
}

/**
 * 3Dエッジ選択で選んだ1本のエッジのスナップショット(Phase 25a)。edgeIdは選択時点の
 * B-Rep面ID同様の一時ID(replicadのedge.hashCode)で、再評価のたびに変わりうるため
 * 第一候補としてのみ使う。midpoint/p1/p2(いずれもワールド座標、mm)は幾何マッチングの
 * フォールバック(中点距離最近傍+方向一致)に使う(src/worker/evaluator.tsのresolveFilletEdges参照)。
 * length/isClosed(Phase 29c)は穴の縁のような閉じた円形エッジ(p1===p2で方向ベクトルが定義できない)
 * を中点距離+長さ一致で判定するために使う(開いたエッジは従来通り方向一致を使う)。
 */
export interface FilletEdgeRef {
  edgeId: number;
  midpoint: [number, number, number];
  p1: [number, number, number];
  p2: [number, number, number];
  length: number;
  isClosed: boolean;
}

/**
 * 3Dフィレット/面取りフィーチャー(Phase 25a)。直前までのボディの指定エッジ群に
 * replicadのShape3D#fillet()/#chamfer()を適用する。edgesは選択時点のスナップショット配列
 * (1つ以上必須)。再評価のたびにsrc/worker/evaluator.tsのresolveFilletEdges()が現在ボディの
 * エッジから幾何マッチングして解決し直す(マッチできなければfeatureId付きエラーになる。
 * v1ではエッジ再選択UIを持たないため、作り直しが必要)。
 */
export interface Fillet3DFeature {
  type: "fillet3d";
  id: FeatureId;
  name: string;
  kind: "fillet" | "chamfer";
  size: number;
  edges: FilletEdgeRef[];
}

/**
 * シェル(中抜き)の対象面のスナップショット(Phase 25b)。FilletEdgeRefと同じ考え方で、
 * faceIdは選択時点のB-Rep面ID(replicadのface.hashCode)であり再評価のたびに変わりうるため
 * 第一候補としてのみ使う。center/normal(いずれもワールド座標、mm)は幾何マッチングの
 * フォールバック(src/worker/evaluator.tsのresolveShellFaces参照。resolveFaceGeometryと同じ
 * 「平面かつ法線一致+中心最近傍」判定を、複数面かつ重複マッチ不可の条件で行う)に使う。
 */
export interface ShellFaceRef {
  faceId: number;
  center: [number, number, number];
  normal: [number, number, number];
}

/**
 * シェル(中抜き)フィーチャー(Phase 25b)。直前までのボディに replicad の Shape3D#shell() を
 * 適用し、facesで指定した面を開口したまま、残りの面から厚みthickness(mm)の殻状の形状を作る
 * (replicadのshell()は正の厚みで内側へ肉厚を確保する規約。node_modules/replicad/dist/replicad.js
 * のshell()実装[-thicknessをBRepOffsetAPI_MakeThickSolidへ渡す]で確認済み)。
 * facesは選択時点のスナップショット配列(1つ以上必須)。再評価のたびにevaluator.tsの
 * resolveShellFaces()が現在ボディの面から幾何マッチングして解決し直す(マッチできなければ
 * featureId付きエラーになる。v1では面再選択UIを持たないため、作り直しが必要)。
 */
export interface ShellFeature {
  type: "shell";
  id: FeatureId;
  name: string;
  thickness: number;
  faces: ShellFaceRef[];
}

/**
 * 回転体(Revolve)フィーチャー(Phase 25b)。sketchIdのプロファイル(押し出しと同じ
 * buildDrawingParts()の外形/穴)を、スケッチローカルのX軸またはY軸(いずれもスケッチ原点を通る)を
 * 回転軸としてangle度だけ回転させる。angleの既定値は360(v1ではUIのデフォルト値として扱う。
 * このフィールド自体は必須)。operationは押し出しと同じ newBody/add/cut の3種で、
 * evaluator側の分岐(ボディへのfuse/cut)も押し出しと共通のロジックを使う。
 * targetBodyId は ExtrudeFeature と同じ意味(Phase 27a複数ボディ対応。operation:"cut"|"add"時のみ
 * 有効、省略時は最後に作られたボディが対象になる)。
 */
export interface RevolveFeature {
  type: "revolve";
  id: FeatureId;
  name: string;
  sketchId: FeatureId;
  axis: "x" | "y";
  angle: number;
  operation: "newBody" | "add" | "cut";
  targetBodyId?: FeatureId;
}

/** ねじフィーチャー(Phase 25c)のISO並目ねじプリセット名。呼び径・ピッチはsrc/model/threadPresets.ts参照。 */
export type ThreadPreset = "M3" | "M4" | "M5" | "M6" | "M8" | "M10" | "M12";

/**
 * ねじフィーチャーの配置面のスナップショット(Phase 25c)。ShellFaceRefと同じ考え方
 * (faceId第一候補+center/normalによる幾何マッチングのフォールバック、
 * src/worker/evaluator.tsのresolveFaceGeometryをそのまま流用する。単一面のみが対象)。
 */
export interface ThreadFaceRef {
  faceId: number;
  center: [number, number, number];
  normal: [number, number, number];
}

/**
 * ねじフィーチャー(Phase 25c、Phase 41で簡易表示化)。雄ねじ(hand:"male")は呼び径の単純円柱を
 * ボディにfuseする(旧v1のヘリカルねじ山loftソリッドはPhase 41で廃止、評価は事実上瞬時)。
 * 雌ねじ(hand:"female")は実ねじ山を切らず、規格の下穴径(呼び径−ピッチ)の円柱をボディから
 * cutする簡易表現(変更なし)。両方とも、見た目上の「ねじらしさ」はWorker評価応答の
 * threadAnnotations(src/protocol/messages.ts)経由でビューアが描く二重円+ヘリックスの
 * 線オーバーレイが担う(このFeature自体・B-Repには含まれない)。
 *
 * preset(呼び径・ピッチ)はsrc/model/threadPresets.tsのテーブルを参照する。lengthはmm。
 * faceは配置面のスナップショット(evaluator.tsのresolveFaceGeometryで再解決する、ShellFeatureと
 * 同様に直前までの「現在ボディ」に対して解決する。特定のfeatureIdを参照しない)。
 * positionは配置面ローカル2D座標(faceのcenter/normalから求めた平面基底上の、配置クリック点)。
 * directionは面法線に対するねじ軸の向き(1=法線方向、-1=法線と逆方向)。
 */
export interface ThreadFeature {
  type: "thread";
  id: FeatureId;
  name: string;
  hand: "male" | "female";
  preset: ThreadPreset;
  length: number;
  face: ThreadFaceRef;
  position: [number, number];
  direction: 1 | -1;
  /**
   * 配置基準をスケッチの円参照に切り替える(Phase 46: ねじのスケッチ参照配置、省略可・後方互換)。
   * 設定すると、評価のたびにsrc/worker/evaluator.tsがsketchId(面上スケッチである必要がある)の
   * entityId(circleエンティティ)の中心を、faceと同じ面上のローカル座標として解決し、positionを
   * 上書きする(evaluate応答経由でこのFeatureのpositionへ書き戻される。src/state/store.tsの
   * applyThreadPositionUpdates参照。合致[mate]のsolvedPlacements書き戻しと同じ設計)。
   * sketchIdの平面がfaceと異なる面、またはsketchId/entityIdの参照先が見つからない場合は
   * 評価エラーになる(featureId付き、日本語メッセージ)。null/省略時はpositionを手動編集の対象とする
   * (従来通り)。手動編集(数値入力/クリック配置し直し)に戻す際はpositionRefをnullに戻すのみで、
   * position自体は直前に解決した値を保持する(src/components/ThreadEditor.tsx参照)。
   */
  positionRef?: { sketchId: FeatureId; entityId: string } | null;
}

/**
 * 部品配置(簡易アセンブリ)フィーチャー(Phase 27b)。他の.l3dcadプロジェクト(部品)の
 * CadDocumentを丸ごと埋め込み、位置(mm)・回転(度、XYZオイラー順=X軸回転→Y軸回転→Z軸回転の順で
 * 適用)で配置する。ブラウザ環境ではファイルシステム参照ができないため、ファイル参照ではなく
 * 埋め込みコピー方式を取る(部品を後から更新したい場合は、元の.l3dcadを開いて編集・保存し、
 * このフィーチャーを削除して配置し直す運用。v1では部品の中身をこのフィーチャーから直接編集する
 * UIは持たない)。
 *
 * バリデーション: part.features に type:"partInstance" のフィーチャーを含めることは禁止する
 * (入れ子=アセンブリのアセンブリを防ぎ、再帰評価の爆発・無限ループを避ける。
 * src/model/validation.tsのvalidateFeature参照)。これにより評価側(src/worker/evaluator.ts)は
 * 常に「外側の1回のみ」partInstanceを処理すればよく、実際の再帰は発生しない。
 *
 * evaluator.tsは、bodiesマップ(Phase 27a複数ボディ)に「このpartInstance自身が作った1つの
 * 新規ボディ」として追加する(newBodyフィーチャーと同じ扱い。以降のextrude/revolveの
 * targetBodyIdでこのボディをcut/addの対象にできる)。部品の評価結果(変換前のcompound)は
 * 同一の part(JSON文字列で比較)ごとにWorkerメモリ内でキャッシュされ、位置・回転の変更だけでは
 * 部品の再評価(重いフィーチャーの再計算)を伴わない。
 */
export interface PartInstanceFeature {
  type: "partInstance";
  id: FeatureId;
  name: string;
  /** 部品プロジェクトの埋め込みコピー。この中に type:"partInstance" を含めてはならない。 */
  part: CadDocument;
  /** 部品原点のワールド座標での配置位置(mm)。 */
  position: [number, number, number];
  /** 部品のワールド座標での回転(度)。X軸→Y軸→Z軸の順で適用する。 */
  rotation: [number, number, number];
}

/**
 * 合致(メイト、Phase 28c)フィーチャーが参照する1つの面のスナップショット。ShellFaceRef等と同じ
 * 「faceId第一候補+center/normalによる幾何マッチングのフォールバック」の考え方に加え、
 * bodyFeatureId(その面が属するボディを作ったフィーチャーのid。newBody操作のextrude/revolve、
 * またはpartInstance)とsurface(平面/円筒の別。合致の種別バリデーション・面マッチングの両方に使う)を持つ。
 * 円筒面の軸(向き・軸上の点)はここには保存せず、評価のたびにsrc/worker/evaluator.tsが
 * 解決済みの面ジオメトリから再抽出する(スナップショットはあくまで「同じ面を再特定するための
 * 手がかり」であり、実際の残差計算に使う幾何情報は毎回ライブに求める設計。他のFaceRef系と同じ方針)。
 */
export interface MateFaceRef {
  bodyFeatureId: FeatureId;
  faceId: number;
  center: [number, number, number];
  normal: [number, number, number];
  surface: "plane" | "cylinder";
}

/**
 * 合致(メイト、Phase 28c、アセンブリの最終ピース)フィーチャー。2つのボディ(少なくとも一方は
 * partInstanceが作ったボディであること。動かせる対象が無い合致は無意味なため、
 * src/model/validation.tsのvalidateFeature()で拒否する)の面を指定した関係で満たすよう、
 * 関与するpartInstanceの位置・回転を数値ソルバ(src/assembly/mateSolver.ts)で solveする。
 * kind:
 *   - "coincident": 両面が平面であること。法線が逆平行(面同士が向き合う)かつ同一平面上に載る。
 *   - "distance": 両面が平面であること。coincidentと同じ向き条件+法線方向にvalue(mm)だけ離す。
 *   - "concentric": 両面が円筒であること。軸方向が平行かつ軸が一致する(軸に沿った並進・
 *     軸まわりの回転は拘束しない)。
 * valueはkind:"distance"のときのみ意味を持つ(mm、正の有限数)。
 * 解いた結果(関与するpartInstanceのposition/rotation)はWorker評価応答のsolvedPlacementsで返り、
 * src/state/store.tsが該当partInstanceフィーチャーへ書き戻す(履歴は積まない。
 * src/sketch/solver.tsの拘束ソルバの書き戻しと同じ設計)。
 */
export interface MateFeature {
  type: "mate";
  id: FeatureId;
  name: string;
  kind: "coincident" | "distance" | "concentric";
  value?: number;
  a: MateFaceRef;
  b: MateFaceRef;
}

/** フィーチャー(履歴列の1要素)。 */
export type Feature =
  | SketchFeature
  | ExtrudeFeature
  | Fillet3DFeature
  | ShellFeature
  | RevolveFeature
  | ThreadFeature
  | PartInstanceFeature
  | MateFeature;

/**
 * CADドキュメント全体。features は順序付き(=編集履歴)。
 * rollbackIndex(SolidWorks風ロールバックバー)は省略可(後方互換)。null/undefinedは
 * 「末尾」=全フィーチャーが評価対象であることを表す。数値nは「features先頭からn個のみ」が
 * 評価対象であることを表す(0〜features.lengthにクランプして解釈する。詳細は
 * src/model/document.ts の resolveEvaluationDocument()/effectiveFeatureCount() 参照)。
 * 正本のfeatures配列自体は変更しない(評価用に一時的に絞り込んだドキュメントを別途作る)。
 */
export interface CadDocument {
  version: 1;
  features: Feature[];
  rollbackIndex?: number | null;
}
