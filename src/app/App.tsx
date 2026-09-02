import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import { DimensionOverlay } from "../components/DimensionOverlay";
import { DimensionToolPopup } from "../components/DimensionToolPopup";
import { ExtrudeEditor } from "../components/ExtrudeEditor";
import { FeatureTree } from "../components/FeatureTree";
import { Fillet3DEditor } from "../components/Fillet3DEditor";
import { MateEditor } from "../components/MateEditor";
import { PartInstanceEditor } from "../components/PartInstanceEditor";
import { RevolveEditor } from "../components/RevolveEditor";
import { ShellEditor } from "../components/ShellEditor";
import { SketchEditor } from "../components/SketchEditor";
import { ThreadEditor } from "../components/ThreadEditor";
import { ToolIcon, type ToolIconName } from "../components/ToolIcon";
import { worldDirectionToLocal, worldPointToLocal } from "../assembly/mateSolver";

// AIモデル生成パネル(Phase 37)。@anthropic-ai/sdkを含む重い依存(src/ai/generate.ts経由で
// さらに動的import)をメインバンドルから分離するため、React.lazy()で遅延読み込みする。
const AiGeneratePanel = lazy(() => import("../components/AiGeneratePanel"));
// 「ギャラリーに投稿」ダイアログ(Phase 40d)。使用頻度が低いUIのため同様に遅延読み込みする。
const GallerySubmitDialog = lazy(() => import("../components/GallerySubmitDialog"));
import { downloadBlob } from "../export/downloadBlob";
import { downloadStl } from "../export/downloadStl";
import {
  addSketchEntity,
  addSketchSegments,
  applySegmentCornerToSketch,
  convertRectangleToPolygon,
  extendSketchSegmentAtPoint,
  findFeature,
  getDependentFeatureIds,
  patchPartInstanceFeature,
  removeSketchElementCascade,
  renameFeature,
  replaceFillet3DEdges,
  replaceMateFaces,
  replaceShellFaces,
  replaceThreadPlacement,
  setPolygonVertexCorner,
  setSketchConstraints,
  trimSketchEntityAtPoint,
  trimSketchSegmentAtPoint,
  updateSketchEntity,
  updateSketchGeometry,
} from "../model/document";
import { buildAutoConstraintsForChain } from "../sketch/autoConstraints";
import {
  createArcSegment,
  createCircleEntity,
  createLineSegment,
  createPointEntity,
  createPolygonEntity,
  createRectangleEntity,
  createSlotEntity,
} from "../model/entity";
import type {
  ArcRef,
  CadDocument,
  EntityRef,
  FeatureId,
  Fillet3DFeature,
  FilletEdgeRef,
  MateFaceRef,
  MateFeature,
  PolygonCorner,
  ShellFaceRef,
  ShellFeature,
  ThreadFeature,
  ThreadPreset,
} from "../model/types";
import { THREAD_PRESET_LIST } from "../model/threadPresets";
import {
  addCoincidentOriginConstraint,
  addConcentricConstraint,
  addPerpendicularConstraint,
  addTangentArcLineConstraint,
  addTangentEntityConstraint,
  addTangentSegmentConstraint,
  angleBetweenLines,
  describeAxisDistanceConflict,
  distanceBetweenRefs,
  foldToAcuteAngle,
  isNearlyParallelAngle,
  pointFromRef,
  segmentLength,
  segmentRadius,
  upsertAngleLineLineConstraint,
  upsertAngleLineRefEdgeConstraint,
  upsertDistanceConstraint,
  upsertDistanceEntityEntityConstraint,
  upsertDistanceEntityLineConstraint,
  upsertDistanceEntityOriginConstraint,
  upsertDistanceLineLineConstraint,
  upsertDistanceLineOriginConstraint,
  upsertDistanceLineRefEdgeConstraint,
  upsertDistancePointLineConstraint,
  upsertDistancePointOriginConstraint,
  upsertLengthConstraint,
  upsertRadiusConstraint,
} from "../sketch/constraintDimensions";
import { deserializeProject, serializeProject } from "../project/serialization";
import { runBootLoad } from "../project/bootLoad";
import { extractGallerySlug, fetchGalleryModel, stripGallerySlugFromSearch } from "../project/galleryLoad";
import {
  buildShareLinkUrl,
  decodeShareLinkPayload,
  extractShareLinkData,
  encodeShareLinkPayload,
  isShareLinkSupported,
  SHARE_LINK_WARN_CHARS,
} from "../project/shareLink";
import { resolveLineRefPoints } from "../sketch/entityEdges";
import { distanceBetweenPoints, distancePointToLine } from "../sketch/positionDimensions";
import { worldOriginLocal } from "../sketch/originRef";
import { rectangleFromCorners, regularPolygonVertices } from "../sketch/shapeFromPoints";
import { getSketchDiagnostics } from "../sketch/solver";
import { updateDocumentWithConflictRollback } from "../state/constraintUpdate";
import { loadAutosavedDocument, useCadStore } from "../state/store";
import {
  CadViewer,
  type ConstraintPickTarget,
  type DimensionToolTarget,
  type MatePickTarget,
  type SketchOverlayEntry,
} from "../viewer/CadViewer";
import type { StandardView } from "../viewer/standardViews";

/**
 * ツールバーで選択中の作図ツール(未選択はnull)。rect/circleはPhase 14の2クリック作図、
 * slotはPhase 17→Phase 21で3クリック作図(始点・終点・幅)に変更、regularPolygonは
 * Phase 17の2クリック作図(中心・頂点、辺数はツール開始時に固定。Phase 21でボタン名を
 * 「多角形」に改名し、生成エンティティをregularPolygonから頂点計算済みのpolygonに変更した。
 * 内部の tool state キー名は"regularPolygon"のまま据え置く)、segmentはPhase 19bの自由な
 * 線分・円弧チェーン作図(閉じる必要が無い。フリーな多角形を描きたい場合はこちらを使う)。
 * "line"(旧: 複数頂点の閉多角形を自由にクリックして描く専用ツール)はPhase 21で廃止した
 * (自由描画はsegmentツールが担い、regularPolygon経由でも頂点編集でpolygonエンティティを
 * 個別に調整できるため)。
 */
type DrawingTool = "rect" | "circle" | "point" | "slot" | "regularPolygon" | "segment" | null;

/**
 * CommandManagerリボン(Phase 38a)のタブ。"sketch"=スケッチ、"feature"=フィーチャー、
 * "assembly"=アセンブリ、"view"=表示。スケッチの選択状態が変化した境界(入る/出る)で
 * 自動的にsketch⇄featureへ切り替わる(App本体のuseEffect参照)。手動クリックはいつでも優先される。
 */
type RibbonTab = "sketch" | "feature" | "assembly" | "view";
const RIBBON_TABS: { id: RibbonTab; label: string }[] = [
  { id: "sketch", label: "スケッチ" },
  { id: "feature", label: "フィーチャー" },
  { id: "assembly", label: "アセンブリ" },
  { id: "view", label: "表示" },
];

/**
 * ツールバーの標準ビューボタン(正面/背面/左/右/上/下/等角、Phase 16)。
 * Phase 38aでリボン化: 「他のビュー」セレクトは廃止し、7つすべてをボタンとして常設
 * ヘッズアップビュークラスタ(タブに関わらず常時表示)+表示タブの両方に並べる。
 */
const STANDARD_VIEW_BUTTONS: { view: StandardView; label: string; title: string; icon: ToolIconName }[] = [
  { view: "front", label: "正面", title: "正面(-Y側)から見る", icon: "viewFront" },
  { view: "back", label: "背面", title: "背面(+Y側)から見る", icon: "viewBack" },
  { view: "left", label: "左", title: "左側面(-X側)から見る", icon: "viewLeft" },
  { view: "right", label: "右", title: "右側面(+X側)から見る", icon: "viewRight" },
  { view: "top", label: "上", title: "上面(+Z側)から見る", icon: "viewTop" },
  { view: "bottom", label: "下", title: "下面(-Z側)から見る", icon: "viewBottom" },
  { view: "iso", label: "等角", title: "等角(アイソメトリック)ビュー", icon: "viewIso" },
];

export default function App() {
  const viewerContainerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<CadViewer | null>(null);
  // プロジェクトを開く(Phase 26)用の隠しfile input。
  const openProjectInputRef = useRef<HTMLInputElement | null>(null);
  // 部品を配置(簡易アセンブリ、Phase 27b)用の隠しfile input。
  const openPartInputRef = useRef<HTMLInputElement | null>(null);

  const doc = useCadStore((s) => s.doc);
  const status = useCadStore((s) => s.status);
  const mesh = useCadStore((s) => s.mesh);
  const faceInfo = useCadStore((s) => s.faceInfo);
  const edgeInfo = useCadStore((s) => s.edgeInfo);
  const sketchPlanes = useCadStore((s) => s.sketchPlanes);
  const referenceEdges = useCadStore((s) => s.referenceEdges);
  const bodyGroups = useCadStore((s) => s.bodyGroups);
  const bodyOperationTargets = useCadStore((s) => s.bodyOperationTargets);
  const threadAnnotations = useCadStore((s) => s.threadAnnotations);
  const errorMessage = useCadStore((s) => s.errorMessage);
  const errorFeatureId = useCadStore((s) => s.errorFeatureId);
  const kernelCrashed = useCadStore((s) => s.kernelCrashed);
  const restartKernel = useCadStore((s) => s.restartKernel);
  const autosaveRestoreSkipped = useCadStore((s) => s.autosaveRestoreSkipped);
  const retryAutosaveRestore = useCadStore((s) => s.retryAutosaveRestore);
  const selectedFeatureId = useCadStore((s) => s.selectedFeatureId);
  const selectedEntityId = useCadStore((s) => s.selectedEntityId);
  const sketches = doc.features.filter((f) => f.type === "sketch");
  const selectedFeature = selectedFeatureId ? findFeature(doc, selectedFeatureId) : undefined;
  const selectedSketchFeature = selectedFeature?.type === "sketch" ? selectedFeature : null;
  // スケッチ編集モード中かどうか(選択中フィーチャーがスケッチかどうかと同義)。スケッチ表示の
  // 自動デフォルト(Phase 43)・CommandManagerリボンのタブ自動切替の両方がこれを基準にする。
  const isInSketchMode = selectedSketchFeature !== null;
  // 選択中スケッチの拘束診断(自由度[dof]・矛盾/冗長拘束id、拘束診断UI、Phase 35b-2)。solve後の
  // 状態から都度取得する(GCS未初期化中はnull=診断バッジ・スケッチ線の定義状態別配色は非表示)。
  // ビューア(setSketchOverlay、下のuseEffect)とSketchEditor(定義状態バッジ・拘束一覧の色分け)の
  // 両方がこの値を参照する。
  const selectedSketchDiagnostics = useMemo(() => {
    if (!selectedSketchFeature) return null;
    return getSketchDiagnostics(selectedSketchFeature.segments ?? [], selectedSketchFeature.constraints ?? [], selectedSketchFeature.entities);
  }, [selectedSketchFeature]);
  const selectedFace = useCadStore((s) => s.selectedFace);
  const sketchVisibilityOverride = useCadStore((s) => s.sketchVisibilityOverride);
  // スケッチ表示の実効値(Phase 43): 手動オーバーライドがあればそれを優先し、無ければ
  // 「スケッチ編集モード中は表示・それ以外は非表示」を自動適用する。
  const showSketches = sketchVisibilityOverride ?? isInSketchMode;
  const exporting = useCadStore((s) => s.exporting);
  const exportError = useCadStore((s) => s.exportError);
  const interferenceResult = useCadStore((s) => s.interferenceResult);
  const interferenceChecking = useCadStore((s) => s.interferenceChecking);
  const interferenceError = useCadStore((s) => s.interferenceError);
  const checkInterference = useCadStore((s) => s.checkInterference);
  const clearInterference = useCadStore((s) => s.clearInterference);
  const initialize = useCadStore((s) => s.initialize);
  const selectFeature = useCadStore((s) => s.selectFeature);
  const setRollbackIndex = useCadStore((s) => s.setRollbackIndex);
  const selectFace = useCadStore((s) => s.selectFace);
  const addSketch = useCadStore((s) => s.addSketch);
  const addExtrude = useCadStore((s) => s.addExtrude);
  const addRevolve = useCadStore((s) => s.addRevolve);
  const addFaceSketch = useCadStore((s) => s.addFaceSketch);
  const editThreadPlacementSketch = useCadStore((s) => s.editThreadPlacementSketch);
  const removeFeature = useCadStore((s) => s.removeFeature);
  const addFillet3D = useCadStore((s) => s.addFillet3D);
  const addShell3D = useCadStore((s) => s.addShell3D);
  const addThread = useCadStore((s) => s.addThread);
  const addPartInstance = useCadStore((s) => s.addPartInstance);
  const addMate = useCadStore((s) => s.addMate);
  const exportStl = useCadStore((s) => s.exportStl);
  const exportStep = useCadStore((s) => s.exportStep);
  const loadDocument = useCadStore((s) => s.loadDocument);
  const newProject = useCadStore((s) => s.newProject);
  // AI生成パネルの貼り付けモード(Phase 45)が提案したギャラリー投稿用メタ情報。
  // GallerySubmitDialogの初期入力値として渡す(store.tsのコメント参照)。
  const pendingGalleryMeta = useCadStore((s) => s.pendingGalleryMeta);
  const previewFeatureContext = useCadStore((s) => s.previewFeatureContext);
  const setSketchVisibilityOverride = useCadStore((s) => s.setSketchVisibilityOverride);
  const showGrid = useCadStore((s) => s.showGrid);
  const setShowGrid = useCadStore((s) => s.setShowGrid);
  const updateDocument = useCadStore((s) => s.updateDocument);
  const undo = useCadStore((s) => s.undo);
  const redo = useCadStore((s) => s.redo);
  const canUndo = useCadStore((s) => s.history.past.length > 0);
  const canRedo = useCadStore((s) => s.history.future.length > 0);

  // CommandManagerリボン(Phase 38a)のアクティブタブ。既定は「フィーチャー」。
  const [ribbonTab, setRibbonTab] = useState<RibbonTab>("feature");
  // 現在アクティブな作図ツール(line/rect/circle、未選択はnull)。実体(頂点列・プレビュー)はCadViewerが持つ。
  const [activeTool, setActiveTool] = useState<DrawingTool>(null);
  // 描画モード開始時点で対象だったスケッチID。選択が他に移ったら自動キャンセルするために使う
  // (フィレット/面取りツールの開始時にも同じフィールドを使い回す)。
  const [drawingSketchId, setDrawingSketchId] = useState<string | null>(null);
  // 1mmグリッドスナップ(デフォルトON)。
  const [gridSnap, setGridSnap] = useState(true);
  // 共有リンク機能(Phase 40a)がこの環境で使えるか(CompressionStream/DecompressionStream対応)。
  // 実行中に変化しない値のため、マウント時に一度だけ計算する。
  const [shareLinkSupported] = useState(() => isShareLinkSupported());
  // 「開く」で選んだ.l3dcadファイルの読み込みに失敗したときのエラーメッセージ(Phase 26)。未発生はnull。
  const [openProjectError, setOpenProjectError] = useState<string | null>(null);
  // 「部品を配置」で選んだ.l3dcadファイルの読み込みに失敗したときのエラーメッセージ(Phase 27b)。未発生はnull。
  const [openPartError, setOpenPartError] = useState<string | null>(null);
  // AI生成パネル(Phase 37)の開閉状態。
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  // 「ギャラリーに投稿」ダイアログ(Phase 40d)の開閉状態。
  const [gallerySubmitOpen, setGallerySubmitOpen] = useState(false);
  // 「スケッチ追加」ボタンで使う平面選択(Phase 13)。基準平面クリックと同等の機能をUIからも操作できるようにする。
  const [newSketchPlane, setNewSketchPlane] = useState<"XY" | "XZ" | "YZ">("XY");
  // 現在アクティブなフィレット/面取りツール(未選択はnull、Phase 18)。
  const [cornerTool, setCornerTool] = useState<"fillet" | "chamfer" | null>(null);
  // 現在アクティブな3Dフィレット/面取りツール(未選択はnull、Phase 25a)。cornerTool(2Dスケッチの
  // 頂点フィレット/面取り)とは別物で、ボディのB-Repエッジを直接選択する。
  const [edgeTool, setEdgeTool] = useState<"fillet" | "chamfer" | null>(null);
  // 3Dフィレット/面取りツールで適用するサイズ(mm、デフォルト5)。
  const [edgeToolSize, setEdgeToolSize] = useState(5);
  // 3Dフィレット/面取りツールで現在選択中のエッジ集合(選択した順、Phase 25a)。
  const [edgeSelection, setEdgeSelection] = useState<FilletEdgeRef[]>([]);
  // 現在アクティブなシェルツール(未選択はfalse、Phase 25b)。ボディのB-Rep面を直接選択する。
  const [shellTool, setShellTool] = useState(false);
  // シェルツールで適用する肉厚(mm、デフォルト2)。
  const [shellToolThickness, setShellToolThickness] = useState(2);
  // シェルツールで現在選択中の面集合(選択した順、Phase 25b)。
  const [shellSelection, setShellSelection] = useState<ShellFaceRef[]>([]);
  // 現在アクティブなねじツール(未選択はfalse、Phase 25c)。trueの間はミニフォームを表示し、
  // 平面のクリックで即座にフィーチャーが追加される(適用ボタンは無い、面/エッジツールと異なる)。
  const [threadTool, setThreadTool] = useState(false);
  // ねじツールのミニフォームの値(プリセット・雄雌・長さ)。クリックコールバックからは
  // ref経由で最新値を読む(cornerSizeRefと同じパターン)。
  const [threadPreset, setThreadPreset] = useState<ThreadPreset>("M6");
  const [threadHand, setThreadHand] = useState<"male" | "female">("male");
  const [threadLength, setThreadLength] = useState(10);
  const threadPresetRef = useRef(threadPreset);
  threadPresetRef.current = threadPreset;
  const threadHandRef = useRef(threadHand);
  threadHandRef.current = threadHand;
  const threadLengthRef = useRef(threadLength);
  threadLengthRef.current = threadLength;
  // 部品移動ツール(未選択はfalse、Phase 28a)。partInstanceが作ったボディをドラッグして位置を動かす。
  const [partDragTool, setPartDragTool] = useState(false);
  // ドラッグ中の対象部品featureId・ドラッグ開始時点の位置(コールバックのクロージャが古い値を掴まない
  // ようrefで保持する。cornerSizeRef等と同じパターン)。
  const partDragFeatureIdRef = useRef<string | null>(null);
  const partDragBasePositionRef = useRef<[number, number, number] | null>(null);
  // 合致(メイト)ツール(未選択はfalse、Phase 28c)。面を2つ順にクリックし、2つ目確定時に
  // matePopup(適用可能な合致の選択ポップアップ)を開く。
  const [mateTool, setMateTool] = useState(false);
  // 合致ツールの1つ目待ち状態のステータス表示(constraintPendingLabelと同じ位置に表示)。未保留はnull。
  const [matePendingLabel, setMatePendingLabel] = useState<string | null>(null);
  // 合致ツールが2つの対象を確定した後に表示する、適用可能な合致種別を選ぶ小さなポップアップ(Phase 28c)。
  const [matePopup, setMatePopup] = useState<{ a: MatePickTarget; b: MatePickTarget; screen: { x: number; y: number } } | null>(
    null,
  );
  // 合致ポップアップの「距離」入力欄の値(mm、デフォルト5)。
  const [mateDistanceValue, setMateDistanceValue] = useState(5);

  /**
   * 参照切れ時の再選択UI(Phase 29b)。フィーチャー編集パネルの「選び直す」ボタンで、対応する
   * ビューアツールを再選択モードで起動する(既存の「新規追加」フロー[edgeTool/shellTool/
   * threadTool/mateTool]とは別の状態として管理し、対象フィーチャーIDを持つ。エッジ/面の
   * 選択集合自体は既存のedgeSelection/shellSelectionを流用する(新規追加フローと再選択フローは
   * CadViewer側の排他制御により同時に片方しかアクティブにならないため、状態の使い回しで問題ない)。
   * 適用時は新規フィーチャー追加ではなく、対象フィーチャーの参照スナップショットを直接差し替える。
   */
  const [edgeReselectTargetId, setEdgeReselectTargetId] = useState<FeatureId | null>(null);
  const [shellReselectTargetId, setShellReselectTargetId] = useState<FeatureId | null>(null);
  const [threadReselectTargetId, setThreadReselectTargetId] = useState<FeatureId | null>(null);
  const [mateReselectTargetId, setMateReselectTargetId] = useState<FeatureId | null>(null);
  const anyReselectActive = !!(edgeReselectTargetId || shellReselectTargetId || threadReselectTargetId || mateReselectTargetId);
  /**
   * ねじの「配置スケッチを編集」ガイド付きフロー(Phase 47)。対象スケッチのselectedSketchPlaneが
   * 解決される(既存スケッチなら即座、新規作成したスケッチならWorker再評価完了後)まで待ってから
   * 点ツールを事前アクティブ化するための保留id(下のuseEffect参照)。
   */
  const [pendingGuidedPointToolSketchId, setPendingGuidedPointToolSketchId] = useState<FeatureId | null>(null);
  // トリムツール(未選択はfalse、Phase 19b)。
  const [trimTool, setTrimTool] = useState(false);
  // 延長ツール(未選択はfalse、Phase 31b)。トリムの逆: 直線セグメントの近い側の端点を、最初に交わる
  // 相手(他のsegments・entities輪郭・参照エッジ)まで伸ばす。
  const [extendTool, setExtendTool] = useState(false);
  // 寸法ツール(未選択はfalse、Phase 20b)。segmentをクリックしてlength/radius/distance拘束を作成する。
  const [dimensionTool, setDimensionTool] = useState(false);
  // 寸法ツールがヒット対象を確定した後に表示する値入力ポップアップ(未表示はnull、Phase 20b)。
  const [dimensionPopup, setDimensionPopup] = useState<{
    target: DimensionToolTarget;
    titleLabel: string;
    initialValue: number;
    screen: { x: number; y: number };
    /** ポップアップ下に一行表示する補足(Phase 21b、位置寸法)。未指定は非表示。 */
    hintLabel?: string;
    /** 円↔円の距離のときだけtrue: 距離/X距離/Y距離の3択を表示する(UI改善対応)。 */
    axisOptions?: boolean;
    /**
     * 0を許容する距離系の値かどうか(寸法値の符号仕様の明確化、Phase 33)。X/Y距離
     * (axisOptions対象の3種)・端点↔線の距離・線↔線(参照エッジ含む)の距離のときtrue。
     * 長さ・半径・幅・高さ・中心↔原点/辺の距離・角度は対象外(常に正の数のみ、従来通り)。
     */
    allowZero?: boolean;
    /**
     * 線分↔線分・線分↔参照エッジの寸法(Phase 24)のときだけ設定: 「距離/角度」の選択(ラジオ)を
     * 表示する。distanceValue/angleValueはそれぞれの入力欄の初期値、initialは既定の選択
     * (折り畳み角<5度なら"distance"、それ以外は"angle")。
     */
    quantityOptions?: { distanceValue: number; angleValue: number; initial: "distance" | "angle" };
  } | null>(null);
  // 寸法ツールの1点目待ち状態のステータス表示(ツールバー付近に1行、UI改善対応)。未保留はnull。
  const [dimensionPendingLabel, setDimensionPendingLabel] = useState<string | null>(null);
  // 拘束ツール(未選択はfalse、Phase 23。Phase 42bで円弧も対象に追加)。線分/円弧/円を2つ順にクリックして垂直・同心・接線拘束を作成する。
  const [constraintTool, setConstraintTool] = useState(false);
  // 拘束ツールの1つ目待ち状態のステータス表示(寸法ツールのdimensionPendingLabelと同じ位置に表示)。未保留はnull。
  const [constraintPendingLabel, setConstraintPendingLabel] = useState<string | null>(null);
  // 拘束ツールが2つの対象を確定した後に表示する、適用可能な拘束種別を選ぶ小さなポップアップ(Phase 23)。
  const [constraintPopup, setConstraintPopup] = useState<{
    a: ConstraintPickTarget;
    b: ConstraintPickTarget;
    screen: { x: number; y: number };
  } | null>(null);
  // 拘束の矛盾で自動巻き戻しが起きたときの一時メッセージ(Phase 20b)。数秒後に自動で消える。
  // variant(トーストの色分け、Phase 46): "success"=成功系(緑)/"error"=失敗・矛盾系(赤、既定と同じ見た目)/
  // "info"=それ以外の中立的な通知(濃紺グレー)。省略時は既存呼び出し元との後方互換のため"info"。
  const [transientMessage, setTransientMessage] = useState<{ text: string; variant: "success" | "error" | "info" } | null>(null);
  const transientMessageTimer = useRef<number | null>(null);
  function showTransientMessage(message: string, variant: "success" | "error" | "info" = "info") {
    setTransientMessage({ text: message, variant });
    if (transientMessageTimer.current !== null) window.clearTimeout(transientMessageTimer.current);
    transientMessageTimer.current = window.setTimeout(() => setTransientMessage(null), 3000);
  }
  useEffect(() => {
    return () => {
      if (transientMessageTimer.current !== null) window.clearTimeout(transientMessageTimer.current);
    };
  }, []);
  // フィレット/面取りツールで頂点クリック時に適用するサイズ(mm、デフォルト5)。
  const [cornerSize, setCornerSize] = useState(5);
  // 正多角形ツール開始時に固定する辺数(3〜24、デフォルト6、Phase 17)。
  const [polygonSides, setPolygonSides] = useState(6);
  // 線描画モード中の円弧セグメント(Phase 17)トグルの見た目用状態(実体はCadViewer側が持つ。
  // Aキーでも切り替わるため、onArcModeChangeコールバックで同期する)。
  const [arcModeActive, setArcModeActive] = useState(false);
  // クリックコールバック(マウント時に一度だけ渡す)から最新のcornerSizeを参照するためのref。
  const cornerSizeRef = useRef(cornerSize);
  cornerSizeRef.current = cornerSize;

  // Workerを起動し、初期ドキュメントの評価を1回だけ要求する。
  useEffect(() => {
    initialize();
  }, [initialize]);

  /**
   * 起動時、URLに共有リンク(location.hash="#m=...")があれば読み込む(Phase 40a)。
   * ストアのresolveInitialDocument()による自動保存の復元(store.tsモジュール読み込み時に同期的に
   * 完了済み)より後に実行されるため、共有リンクは自動保存より優先して読み込まれる。ただし
   * 自動保存に現在の作業内容が残っており、かつそれが共有リンクの内容と異なる場合は、無言で
   * 上書きせずconfirm()で確認する(キャンセル時は自動保存された内容のまま、hashだけ取り除く)。
   * マウント時に一度だけチェックすればよい(以後のhash変更、例えば#m=読み込み後のreplaceStateは
   * このeffect自身が行うため無視してよい)ため依存配列は空。
   * 自動保存差分確認→読み込み→トースト表示の共通オーケストレーションは
   * src/project/bootLoad.ts の runBootLoad()(モデルギャラリー[Phase 40c]の起動時ロードと共有)。
   */
  useEffect(() => {
    const shareData = extractShareLinkData(window.location.hash);
    if (!shareData) return;

    function stripShareLinkHash() {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }

    let cancelled = false;
    void runBootLoad({
      resolve: () => decodeShareLinkPayload(shareData),
      isCancelled: () => cancelled,
      getAutosaved: loadAutosavedDocument,
      confirm: (message) => window.confirm(message),
      confirmMessage: "共有リンクのモデルを開きますか?現在の作業は破棄されます",
      onSuccess: (doc) => {
        viewerRef.current?.requestFitOnNextMesh();
        loadDocument(doc);
        stripShareLinkHash();
        showTransientMessage("共有モデルを読み込みました", "success");
      },
      onError: (message) => {
        showTransientMessage(`共有リンクの読み込みに失敗しました: ${message}`, "error");
        stripShareLinkHash();
      },
      onCancelled: stripShareLinkHash,
    });

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 起動時、URLにモデルギャラリーのクエリ(location.search="?g=<slug>")があれば読み込む
   * (Phase 40c)。models/<slug>/model.l3dcad をfetchする点以外は共有リンク(上記effect)と
   * 完全に同じ流れ(自動保存差分確認→読み込み→トースト、runBootLoad()で共通化)。
   * 共有リンク(hash)とギャラリー(query)が同時に指定されることは通常想定しないが、
   * 別々のURL部分・別々のeffectのため両方処理されても害はない(後勝ち)。
   */
  useEffect(() => {
    const slug = extractGallerySlug(window.location.search);
    if (!slug) return;

    function stripGalleryQuery() {
      const search = stripGallerySlugFromSearch(window.location.search);
      window.history.replaceState(null, "", window.location.pathname + search + window.location.hash);
    }

    let cancelled = false;
    void runBootLoad({
      resolve: () => fetchGalleryModel(import.meta.env.BASE_URL, slug),
      isCancelled: () => cancelled,
      getAutosaved: loadAutosavedDocument,
      confirm: (message) => window.confirm(message),
      confirmMessage: "ギャラリーモデルを開きますか?現在の作業は破棄されます",
      onSuccess: (doc) => {
        viewerRef.current?.requestFitOnNextMesh();
        loadDocument(doc);
        stripGalleryQuery();
        showTransientMessage("ギャラリーモデルを読み込みました", "success");
      },
      onError: (message) => {
        showTransientMessage(`ギャラリーモデルの読み込みに失敗しました: ${message}`, "error");
        stripGalleryQuery();
      },
      onCancelled: stripGalleryQuery,
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // Three.jsビューア初期化(マウント時に一度だけ)。
  // 面クリック時のコールバックはストアの最新スナップショットを直接参照する
  // (依存配列は空のまま=マウント時に一度だけ生成するビューアに対して安定した参照を渡す)。
  useEffect(() => {
    if (!viewerContainerRef.current) return;
    const viewer = new CadViewer(
      viewerContainerRef.current,
      (face) => {
        useCadStore.getState().selectFace(face);
      },
      (plane) => {
        // 基準平面クリック(Phase 13): その平面で新規スケッチを作り、選択状態にする。
        useCadStore.getState().addSketch(plane);
      },
      (sketchId, targetId) => {
        // ツール未使用時のスケッチ線直接クリック(Phase 31b): そのスケッチを選択し、
        // クリックしたentity/segmentを強調+SketchEditorパネルへ自動スクロールする。
        useCadStore.getState().selectSketchEntity(sketchId, targetId);
      },
    );
    // スケッチジオメトリのドラッグ編集(Phase 34)。部品移動ツール(startPartDragTool、下記)と同じ
    // beginDragHistory/updateDocumentDuringDragパターンで、ドラッグ全体をUndo1回にまとめる。
    // Escでの中断(onDragCancel)はundo()でbeginDragHistory()が積んだ開始時点へ戻す。
    viewer.setSketchDragCallbacks({
      onDragStart: () => {
        useCadStore.getState().beginDragHistory();
      },
      onDragMove: (sketchId, segments, entities) => {
        useCadStore.getState().updateDocumentDuringDrag((d) => updateSketchGeometry(d, sketchId, { segments, entities }));
      },
      onDragEnd: (sketchId, segments, entities) => {
        useCadStore.getState().updateDocumentDuringDrag((d) => updateSketchGeometry(d, sketchId, { segments, entities }));
      },
      onDragCancel: () => {
        useCadStore.getState().undo();
      },
    });
    viewerRef.current = viewer;
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  // ストアのmesh/faceInfoが更新されるたびにビューアへ反映する。
  // mesh===nullは初回未評価のみ(Phase 13以降、ボディなしは空配列のmeshとして届くため、
  // ここでのnullチェックは「まだ一度もWorkerから応答が無い」ケースのみを意味する)。
  useEffect(() => {
    if (mesh) {
      viewerRef.current?.setMesh(mesh, faceInfo, edgeInfo, bodyGroups);
    }
  }, [mesh, faceInfo, edgeInfo, bodyGroups]);

  // ねじフィーチャーの簡易表示(Phase 41): threadAnnotationsが更新されるたびに二重円+ヘリックス線の
  // オーバーレイを再構築する(setMesh()とは独立。ボディが再構築されない場合でもthreadAnnotationsだけ
  // 変わることは無いはずだが、依存配列は他の派生状態と同じくstore側の配列参照で判定する)。
  useEffect(() => {
    viewerRef.current?.setThreadAnnotations(threadAnnotations);
  }, [threadAnnotations]);

  // 部品移動ツール(Phase 28a): ドキュメントが変わるたびに、partInstanceフィーチャーのfeatureId集合を
  // ビューアへ同期する(ドラッグ対象=部品ボディかどうかの判定に使う)。
  useEffect(() => {
    const ids = new Set(doc.features.filter((f) => f.type === "partInstance").map((f) => f.id));
    viewerRef.current?.setPartInstanceFeatureIds(ids);
  }, [doc]);

  // 干渉チェック結果(Phase 28b)が変わるたびにビューアへ反映する。干渉ペアがある間は交差領域を
  // 赤半透明でオーバーレイし、無い(未実行・クリア済み・ペア0件)場合は消去する
  // (store側がドキュメント変更のたびにinterferenceResultをnullへ自動クリアするため、
  // 「クリア」ボタン・自動クリアのいずれもこの1本のuseEffectで反映される)。
  useEffect(() => {
    if (interferenceResult && interferenceResult.pairs.length > 0) {
      viewerRef.current?.setInterferenceMeshes(interferenceResult.meshes);
    } else {
      viewerRef.current?.clearInterferenceMeshes();
    }
  }, [interferenceResult]);

  // ドキュメントに1つもフィーチャーが無い(=空ドキュメント、ボディなし)間だけ基準平面3枚を表示する。
  // 基準平面クリック等で最初のスケッチが作られた時点(features.length>0)で非表示になる(Phase 13)。
  useEffect(() => {
    viewerRef.current?.setReferencePlanesVisible(doc.features.length === 0);
  }, [doc.features.length]);

  // doc(スケッチのentities)とsketchPlanes(Workerが解決した平面基底)を突き合わせて
  // ビューア描画用のオーバーレイ入力を作る。平面解決に失敗したスケッチ(sketchPlanesに無い)は
  // 描画対象から外れる(エラーは既存のeval-errorで表示される)。
  const sketchOverlays = useMemo<SketchOverlayEntry[]>(() => {
    const planeById = new Map(sketchPlanes.map((p) => [p.sketchId, p]));
    const overlays: SketchOverlayEntry[] = [];
    for (const feature of doc.features) {
      if (feature.type !== "sketch") continue;
      const plane = planeById.get(feature.id);
      if (!plane) continue;
      overlays.push({
        sketchId: feature.id,
        entities: feature.entities,
        segments: feature.segments,
        // スケッチジオメトリのドラッグ編集(Phase 34): ドラッグ中のsolveSketch()呼び出しに使う
        // (CadViewerはドキュメントの正本を持たないため、拘束もオーバーレイ入力として渡す)。
        constraints: feature.constraints,
        origin: plane.origin,
        xDir: plane.xDir,
        yDir: plane.yDir,
        normal: plane.normal,
      });
    }
    return overlays;
  }, [doc, sketchPlanes]);

  // 選択中スケッチの線の配色に使う定義状態(拘束診断UI、Phase 35b-2。SolidWorks流:
  // 完全定義=黒っぽく/未定義=青系/矛盾=赤、対象は選択中スケッチ全体単位[要素単位のDOF色分けは
  // スコープ外])。診断が無い(GCS未初期化・図形が無い)場合はnull(=従来通りの選択色[オレンジ])。
  const selectedSketchDefinitionState: "conflicting" | "underDefined" | "fullyDefined" | null = (() => {
    if (!selectedSketchDiagnostics || !selectedSketchFeature) return null;
    const hasGeometry = (selectedSketchFeature.segments?.length ?? 0) > 0 || selectedSketchFeature.entities.length > 0;
    if (!hasGeometry) return null;
    if (selectedSketchDiagnostics.conflicting.length > 0) return "conflicting";
    return selectedSketchDiagnostics.dof === 0 ? "fullyDefined" : "underDefined";
  })();

  // オーバーレイ入力・選択スケッチ・表示トグル・選択中エンティティ・定義状態が変わるたびにビューアへ反映する。
  useEffect(() => {
    viewerRef.current?.setSketchOverlay(sketchOverlays, selectedFeatureId, showSketches, selectedEntityId, selectedSketchDefinitionState);
  }, [sketchOverlays, selectedFeatureId, showSketches, selectedEntityId, selectedSketchDefinitionState]);

  // 押し出し選択時の対象ハイライト(Phase 46): 選択中フィーチャーがextrude/revolveのとき、
  // それが実際に作用したボディのfeatureId(bodyOperationTargets経由)を求める。それ以外はnull
  // (ビューア側は対象ボディ強調を解除する)。
  const selectedBodyTintTarget: FeatureId | null =
    selectedFeature && (selectedFeature.type === "extrude" || selectedFeature.type === "revolve")
      ? (bodyOperationTargets.find((t) => t.featureId === selectedFeature.id)?.bodyFeatureId ?? null)
      : null;
  useEffect(() => {
    viewerRef.current?.setSelectedBodyTint(selectedBodyTintTarget);
    // mesh(setMesh()呼び出し)のたびにmaterialIndexの対応が変わりうるため、meshが更新されたら
    // 対象ボディが変わっていなくても必ず再適用する(CadViewer.setMesh()がtintedGroupIndicesを
    // リセットする側と対になる)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBodyTintTarget, mesh]);

  // 押し出し選択時、元になったスケッチの輪郭を一時強調する(Phase 46)。showSketches(表示トグル)の
  // 状態に関わらず常時表示する(setSketchOverlay()とは独立したオーバーレイ)。
  const selectedExtrudeSourceEntry: SketchOverlayEntry | null =
    selectedFeature && (selectedFeature.type === "extrude" || selectedFeature.type === "revolve")
      ? (sketchOverlays.find((e) => e.sketchId === selectedFeature.sketchId) ?? null)
      : null;
  useEffect(() => {
    viewerRef.current?.setExtrudeSourceHighlight(selectedExtrudeSourceEntry);
  }, [selectedExtrudeSourceEntry]);

  // スケッチジオメトリのドラッグ編集(Phase 34): 既存の「スナップ」トグルの値をビューアへ同期する
  // (部品移動ツールと違い明示的なツール開始が無いため、都度startXxxTool()の引数として渡せない)。
  useEffect(() => {
    viewerRef.current?.setSketchDragSnap(gridSnap);
  }, [gridSnap]);

  // 地面の無限グリッド表示トグル(Phase 44)をビューアへ同期する。
  useEffect(() => {
    viewerRef.current?.setGridVisible(showGrid);
  }, [showGrid]);

  // 選択中の面が再評価後のfaceInfoに存在しなくなった場合(トポロジカルネーミングのずれ等)は
  // 選択状態をクリアする。
  useEffect(() => {
    if (selectedFace && !faceInfo.some((f) => f.faceId === selectedFace.faceId)) {
      selectFace(null);
    }
  }, [faceInfo, selectedFace, selectFace]);

  // 描画モード中にフィーチャーツリーの選択が別のフィーチャーに移った場合は、描画モードを
  // 自動的にキャンセルする(ビューア側のcancelPolygonDrawing()がonCancelを呼び、
  // activeToolのReact stateもそこで null に戻る)。フィレット/面取りツール(cornerTool)・
  // トリムツール(trimTool)も同様。
  useEffect(() => {
    if (activeTool && selectedFeatureId !== drawingSketchId) {
      viewerRef.current?.cancelPolygonDrawing();
    }
    if (cornerTool && selectedFeatureId !== drawingSketchId) {
      viewerRef.current?.cancelCornerTool();
    }
    if (trimTool && selectedFeatureId !== drawingSketchId) {
      viewerRef.current?.cancelTrimTool();
    }
    if (extendTool && selectedFeatureId !== drawingSketchId) {
      viewerRef.current?.cancelExtendTool();
    }
    if (dimensionTool && selectedFeatureId !== drawingSketchId) {
      viewerRef.current?.cancelDimensionTool();
    }
    if (constraintTool && selectedFeatureId !== drawingSketchId) {
      viewerRef.current?.cancelConstraintTool();
    }
  }, [activeTool, cornerTool, trimTool, extendTool, dimensionTool, constraintTool, selectedFeatureId, drawingSketchId]);

  // 参照切れ再選択UI(Phase 29b): 再選択モード中にフィーチャーツリーの選択が他のフィーチャーへ
  // 移った場合は、対応するビューアツールをキャンセルする(元の参照のまま、Escキャンセルと同じ経路)。
  useEffect(() => {
    if (edgeReselectTargetId && selectedFeatureId !== edgeReselectTargetId) {
      viewerRef.current?.cancelEdgeSelectTool();
    }
    if (shellReselectTargetId && selectedFeatureId !== shellReselectTargetId) {
      viewerRef.current?.cancelFaceSelectTool();
    }
    if (threadReselectTargetId && selectedFeatureId !== threadReselectTargetId) {
      viewerRef.current?.cancelThreadPlaceTool();
    }
    if (mateReselectTargetId && selectedFeatureId !== mateReselectTargetId) {
      viewerRef.current?.cancelMateTool();
    }
  }, [selectedFeatureId, edgeReselectTargetId, shellReselectTargetId, threadReselectTargetId, mateReselectTargetId]);

  // フィレット/面取りツール中、対象スケッチのentities/segmentsが変わった場合はヒット判定対象を更新する
  // (rectangle→polygon変換・線分同士のコーナー適用はentities/segmentsの両方を変えるため必須、Phase 24)。
  useEffect(() => {
    if (!cornerTool) return;
    const feature = selectedFeatureId ? findFeature(doc, selectedFeatureId) : undefined;
    if (feature?.type === "sketch") {
      viewerRef.current?.updateCornerToolEntities(feature.entities, feature.segments ?? []);
    }
  }, [cornerTool, doc, selectedFeatureId]);

  // トリムツール中、対象スケッチのsegmentsが変わった場合(トリム適用・アンドゥ等)はヒット判定対象を
  // 最新化する(Phase 19b)。
  useEffect(() => {
    if (!trimTool) return;
    const feature = selectedFeatureId ? findFeature(doc, selectedFeatureId) : undefined;
    if (feature?.type === "sketch") {
      viewerRef.current?.updateTrimSegments(feature.segments ?? [], feature.entities ?? []);
    }
  }, [trimTool, doc, selectedFeatureId]);

  // 延長ツール中、対象スケッチのsegments/entities/参照エッジが変わった場合(延長適用・アンドゥ等)は
  // ヒット判定対象を最新化する(Phase 31b)。
  useEffect(() => {
    if (!extendTool) return;
    const feature = selectedFeatureId ? findFeature(doc, selectedFeatureId) : undefined;
    if (feature?.type === "sketch") {
      const edges = referenceEdges.find((r) => r.sketchId === feature.id)?.edges ?? [];
      viewerRef.current?.updateExtendSegments(feature.segments ?? [], feature.entities ?? [], edges);
    }
  }, [extendTool, doc, selectedFeatureId, referenceEdges]);

  // 寸法ツール中、対象スケッチのsegments/entitiesが変わった場合(拘束適用・entity直接更新・アンドゥ等)は
  // ヒット判定対象を最新化する(Phase 20b、Phase 21でentitiesも対象に追加)。
  useEffect(() => {
    if (!dimensionTool) return;
    const feature = selectedFeatureId ? findFeature(doc, selectedFeatureId) : undefined;
    if (feature?.type === "sketch") {
      viewerRef.current?.updateDimensionToolTargets(feature.segments ?? [], feature.entities, feature.constraints ?? []);
    }
  }, [dimensionTool, doc, selectedFeatureId]);

  // 拘束ツール中、対象スケッチのsegments/entitiesが変わった場合(拘束適用・アンドゥ等)は
  // ヒット判定対象を最新化する(Phase 23)。
  useEffect(() => {
    if (!constraintTool) return;
    const feature = selectedFeatureId ? findFeature(doc, selectedFeatureId) : undefined;
    if (feature?.type === "sketch") {
      viewerRef.current?.updateConstraintToolTargets(feature.segments ?? [], feature.entities, feature.constraints ?? []);
    }
  }, [constraintTool, doc, selectedFeatureId]);

  // ボディ端面参照エッジ(Phase 22)のオーバーレイ+寸法ツールのピック対象を、選択中スケッチの
  // referenceEdges(Worker評価応答)が変わるたびに同期する。選択中フィーチャーがスケッチでない、
  // または平面が未解決の場合は表示・ピック対象ともクリアする。
  useEffect(() => {
    const feature = selectedFeatureId ? findFeature(doc, selectedFeatureId) : undefined;
    const plane = feature?.type === "sketch" ? sketchPlanes.find((p) => p.sketchId === feature.id) : undefined;
    if (!feature || feature.type !== "sketch" || !plane) {
      viewerRef.current?.setReferenceEdges(null, []);
      return;
    }
    const edges = referenceEdges.find((r) => r.sketchId === feature.id)?.edges ?? [];
    viewerRef.current?.setReferenceEdges(plane, edges);
  }, [doc, selectedFeatureId, sketchPlanes, referenceEdges]);

  // Ctrl+Z(Mac: Cmd+Z)でアンドゥ、Ctrl+Shift+Z(Mac: Cmd+Shift+Z)でリドゥ(Phase 14)。
  // Delete/Backspaceでビューア直接選択中のスケッチセグメント/エンティティを削除する(実機報告対応、
  // Phase 32②)。テキスト入力欄にフォーカスがある間はブラウザ標準の編集動作(Undo/文字削除)を
  // 優先し、何もしない。selectedFeatureId/selectedEntityId/docは常に最新のstoreから読む(このeffect
  // 自体は初回のみ登録するリスナーのため、useCadStore.getState()で都度取得することで古いクロージャの
  // 値を参照しないようにする)。
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isEditable =
        !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (isEditable) return;

      if (event.key === "Delete" || event.key === "Backspace") {
        const state = useCadStore.getState();
        if (!state.selectedFeatureId || !state.selectedEntityId) return;
        const feature = findFeature(state.doc, state.selectedFeatureId);
        if (feature?.type !== "sketch") return;
        const { doc: nextDoc, removedConstraintCount } = removeSketchElementCascade(
          state.doc,
          state.selectedFeatureId,
          state.selectedEntityId,
        );
        if (nextDoc === state.doc) return; // 対象idが見つからなかった(何もしない)
        event.preventDefault();
        state.updateDocument(() => nextDoc);
        useCadStore.setState({ selectedEntityId: null });
        if (removedConstraintCount > 0) {
          showTransientMessage(`関連する拘束${removedConstraintCount}件も削除しました`);
        }
        return;
      }

      const meta = event.ctrlKey || event.metaKey;
      if (!meta || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (event.shiftKey) {
        useCadStore.getState().redo();
      } else {
        useCadStore.getState().undo();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 選択中フィーチャーがスケッチで、かつWorkerが平面基底を解決済みの場合のみ取得できる。
  // (未評価・面解決失敗中はundefinedになり、線描画・平面正対ボタンが無効化される)
  const selectedSketchPlane =
    selectedFeature?.type === "sketch"
      ? sketchPlanes.find((p) => p.sketchId === selectedFeature.id)
      : undefined;
  // 3Dフィレット/面取りツールのボタン有効化条件(押し出しフィーチャーによりボディが存在するか)。
  const hasBody = mesh !== null && mesh.positions.length > 0;
  // 干渉チェックボタンの有効化条件(Phase 28b): bodiesマップのキー(newBody操作のextrude/revolve、
  // またはpartInstance)を数える。src/worker/evaluator.tsのbodiesマップ構築ロジックと対応させる。
  const bodyCount = doc.features.filter(
    (f) => f.type === "partInstance" || ((f.type === "extrude" || f.type === "revolve") && f.operation === "newBody"),
  ).length;

  // CommandManagerリボン(Phase 38a): スケッチの選択状態が変化した境界(入る/出る)で
  // 自動的にタブを切り替える(スケッチ選択→「スケッチ」タブ、スケッチ選択解除→「フィーチャー」タブ)。
  // アセンブリ/表示タブへは自動遷移しない(手動クリックのみ)ため、ユーザーの明示的なタブ選択は
  // スケッチへの出入り以外では維持される。
  const wasInSketchModeRef = useRef(isInSketchMode);
  useEffect(() => {
    if (isInSketchMode && !wasInSketchModeRef.current) setRibbonTab("sketch");
    else if (!isInSketchMode && wasInSketchModeRef.current) setRibbonTab("feature");
    if (isInSketchMode !== wasInSketchModeRef.current) {
      // スケッチ表示の自動化(Phase 43): スケッチ編集モードへ入る/出る境界で、手動オーバーライドを
      // リセットする。次のモードでは再び自動判定(スケッチ編集中=表示/外=非表示)に戻る。
      useCadStore.getState().setSketchVisibilityOverride(null);
    }
    wasInSketchModeRef.current = isInSketchMode;
  }, [isInSketchMode]);

  const busy = status === "initializing" || status === "evaluating";
  // WASM初期化は"evaluate"リクエストの中で行われる(initialize()参照)ため、
  // 初回ロード中は mesh がまだ無い状態で status が "evaluating" になる期間が長く続く。
  // そのためオーバーレイは「初回のmesh取得が完了するまで」を基準に表示する
  // (status==="initializing"のみだと、実際にWASMを読み込んでいる間表示されない)。
  const showInitOverlay = mesh === null && (status === "initializing" || status === "evaluating");

  function handleDelete(featureId: string) {
    const dependentIds = getDependentFeatureIds(doc, featureId);
    if (dependentIds.length > 0) {
      const names = dependentIds
        .map((id) => findFeature(doc, id)?.name ?? id)
        .join(", ");
      const ok = window.confirm(
        `このフィーチャーには依存するフィーチャーがあります: ${names}\n一緒に削除します。よろしいですか?`,
      );
      if (!ok) return;
    }
    removeFeature(featureId);
  }

  function handleAddExtrude() {
    if (sketches.length === 0) return;
    // デフォルトは最後のスケッチ。作成後の編集パネルで変更できる。
    const target = sketches[sketches.length - 1];
    addExtrude(target.id);
  }

  function handleAddRevolve() {
    if (sketches.length === 0) return;
    // デフォルトは最後のスケッチ。作成後の編集パネルで軸・角度・操作を変更できる。
    const target = sketches[sketches.length - 1];
    addRevolve(target.id);
  }

  async function handleDownloadStl() {
    try {
      const blob = await exportStl();
      downloadStl(blob, "model.stl");
    } catch {
      // エラーはストアのexportErrorに反映済み。
    }
  }

  async function handleDownloadStep() {
    try {
      const blob = await exportStep();
      downloadBlob(blob, "model.step");
    } catch {
      // エラーはストアのexportErrorに反映済み。
    }
  }

  /** 「保存」ボタン(Phase 26): 現在のドキュメントを.l3dcad(JSON)としてダウンロードする。 */
  function handleSaveProject() {
    const text = serializeProject(doc);
    const blob = new Blob([text], { type: "application/json" });
    downloadBlob(blob, "model.l3dcad");
  }

  /**
   * 「共有リンクをコピー」ボタン(Phase 40a): 現在のドキュメントをgzip圧縮+base64url化して
   * location.hash("#m=...")に埋め込んだURLをクリップボードにコピーする(バックエンド不要)。
   * CompressionStream非対応環境ではボタン自体を無効化している(下のisShareLinkSupported参照)ため、
   * ここが呼ばれるのは対応環境のみだが、念のためtry/catchで囲み失敗時もクラッシュしない。
   */
  async function handleCopyShareLink() {
    try {
      const { data, byteLength } = await encodeShareLinkPayload(doc);
      const url = buildShareLinkUrl(location.origin, location.pathname, data);
      await navigator.clipboard.writeText(url);
      const kb = (byteLength / 1024).toFixed(1);
      const sizeWarning = data.length > SHARE_LINK_WARN_CHARS ? "(URLが長いため一部の環境では開けない可能性があります)" : "";
      showTransientMessage(`共有リンクをコピーしました(${kb}KB)${sizeWarning}`, "success");
    } catch (err) {
      showTransientMessage(`共有リンクの作成に失敗しました: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  /** 「開く」ボタン(Phase 26): 隠しfile inputのクリックを発火する。 */
  function handleOpenProjectClick() {
    setOpenProjectError(null);
    openProjectInputRef.current?.click();
  }

  /**
   * file input のファイル選択確定時(Phase 26)。JSONとして読み、deserializeProject()で検証・復元する。
   * 成功時はloadDocument()でドキュメントを差し替える(アンドゥ履歴クリア・選択解除・再評価はstore側で行う)。
   * 失敗時はopenProjectErrorに表示する。同じファイルを連続で選び直せるよう、成否に関わらずinputの値をリセットする。
   */
  async function handleOpenProjectFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const result = deserializeProject(text);
      if (!result.ok) {
        setOpenProjectError(result.message);
        return;
      }
      // 開いたプロジェクトの初回評価完了時に自動フィットする(Phase 29a)。
      viewerRef.current?.requestFitOnNextMesh();
      loadDocument(result.doc);
      setOpenProjectError(null);
    } catch (err) {
      setOpenProjectError(err instanceof Error ? err.message : String(err));
    }
  }

  /** 「AI生成」ボタン(Phase 37): 隠しfile inputではなくパネルを開く。 */
  function handleOpenAiPanel() {
    setAiPanelOpen(true);
  }

  /**
   * AI生成パネル(生成 or JSON貼り付け)から得られたCadDocumentを読み込む(Phase 37)。
   * 「開く」と同じ責務分担: 確認ダイアログ→fitToView予約→loadDocument()。生成された/貼り付けられた
   * モデルは既に何らかの作業内容を上書きするため、「新規」ボタンと同様に確認する。
   * Phase 39: パネル自体を閉じるかどうかはAiGeneratePanel側の判断に委ねる(貼り付けモードは
   * 即座に閉じるが、生成モードは設計メモを表示するためパネルを開いたままにする)ため、ここでは
   * 閉じない。
   */
  function handleLoadAiGeneratedDocument(generatedDoc: CadDocument) {
    const ok = window.confirm("現在の作業内容を破棄してAIが生成したモデルを読み込みますか?(自動保存には現在の内容が残っています)");
    if (!ok) return;
    viewerRef.current?.requestFitOnNextMesh();
    loadDocument(generatedDoc);
  }

  /**
   * 自動保存の復元「再試行」ボタン(Phase 29a、起動クラッシュループ防止)。
   * 「開く」と同様、読み込んだドキュメントの初回評価完了時に自動フィットする。
   */
  function handleRetryAutosaveRestore() {
    viewerRef.current?.requestFitOnNextMesh();
    retryAutosaveRestore();
  }

  /** 「新規」ボタン(Phase 26): 確認ダイアログの上、空ドキュメントに差し替え自動保存を消去する。 */
  function handleNewProject() {
    const ok = window.confirm("現在の作業内容を破棄して新規プロジェクトを開始しますか?(自動保存も消去されます)");
    if (!ok) return;
    setOpenProjectError(null);
    newProject();
  }

  /** 「部品を配置」ボタン(簡易アセンブリ、Phase 27b): 隠しfile inputのクリックを発火する。 */
  function handleAddPartClick() {
    setOpenPartError(null);
    openPartInputRef.current?.click();
  }

  /**
   * 部品配置用file input のファイル選択確定時(Phase 27b)。deserializeProject()で検証した上で、
   * その部品ドキュメント自体が部品配置(partInstance)を含んでいないか(=入れ子になっていないか)を
   * ここでも確認する(model/validation.tsのvalidateFeature()も同じ制約を持つが、UI側で早期に
   * わかりやすいエラーを出すため)。原点(position:[0,0,0]、回転なし)に配置する。
   * 成否に関わらずinputの値をリセットする(同じファイルを選び直せるように)。
   */
  async function handleAddPartFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const result = deserializeProject(text);
      if (!result.ok) {
        setOpenPartError(result.message);
        return;
      }
      if (result.doc.features.some((f) => f.type === "partInstance")) {
        setOpenPartError(
          "選択したファイルは既に部品配置(アセンブリ)を含んでいるため、部品として配置できません(入れ子は禁止されています)",
        );
        return;
      }
      const name = file.name.replace(/\.l3dcad$/i, "") || "部品";
      addPartInstance({ name, part: result.doc, position: [0, 0, 0], rotation: [0, 0, 0] });
      setOpenPartError(null);
    } catch (err) {
      setOpenPartError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleAlignToPlane() {
    if (!selectedSketchPlane) return;
    viewerRef.current?.lookAtPlane(selectedSketchPlane);
  }

  function handleStartSegmentDrawing() {
    if (!viewerRef.current || !selectedFeature || selectedFeature.type !== "sketch" || !selectedSketchPlane) return;
    const sketchId = selectedFeature.id;
    viewerRef.current.startSegmentDrawing(
      selectedSketchPlane,
      gridSnap,
      selectedFeature.entities,
      selectedFeature.segments ?? [],
      {
        onComplete: (points, bulges, axisLocks) => {
          const segments: ReturnType<typeof createLineSegment>[] = [];
          for (let i = 0; i < points.length - 1; i += 1) {
            const bulge = bulges[i];
            segments.push(
              bulge ? createArcSegment({ p1: points[i], p2: points[i + 1], bulge }) : createLineSegment({ p1: points[i], p2: points[i + 1] }),
            );
          }
          // 接続端点のcoincident・軸ロック確定辺のhorizontal/verticalを自動付与する(Phase 20a)。
          // ソルバへの反映(store.ts)まではUIの見た目は変わらない(20bで拘束編集UIを追加する)。
          const autoConstraints = buildAutoConstraintsForChain({
            newSegments: segments,
            axisLocks,
            existingSegments: selectedFeature.segments ?? [],
          });
          updateDocument((d) => addSketchSegments(d, sketchId, segments, autoConstraints));
          setActiveTool(null);
          setDrawingSketchId(null);
          setArcModeActive(false);
        },
        onCancel: () => {
          setActiveTool(null);
          setDrawingSketchId(null);
          setArcModeActive(false);
        },
        onArcModeChange: (active) => setArcModeActive(active),
      },
    );
    setDrawingSketchId(sketchId);
    setActiveTool("segment");
  }

  /**
   * スロットツール(3クリック、Phase 21でSolidWorks式の「始点→終点→幅」操作に変更)を開始する。
   * onCompleteはCadViewer側でカーソルの中心線からの垂直距離×2として決定された幅(3クリック目時点)
   * を渡してくるので、そのままcreateSlotEntity()のwidthに使う(事前の幅入力欄は廃止した)。
   */
  function handleStartSlotDrawing() {
    if (!viewerRef.current || !selectedFeature || selectedFeature.type !== "sketch" || !selectedSketchPlane) return;
    const sketchId = selectedFeature.id;
    viewerRef.current.startSlotDrawing(selectedSketchPlane, gridSnap, selectedFeature.entities, {
      onComplete: (start, end, width) => {
        const entity = createSlotEntity({ start, end, width });
        updateDocument((d) => addSketchEntity(d, sketchId, entity));
        setActiveTool(null);
        setDrawingSketchId(null);
      },
      onCancel: () => {
        setActiveTool(null);
        setDrawingSketchId(null);
      },
    });
    setDrawingSketchId(sketchId);
    setActiveTool("slot");
  }

  /**
   * 「多角形」ツール(Phase 21で「正多角形」から改名)。2クリック(中心→頂点)の作図操作自体は
   * 従来の正多角形ツール(CadViewer.startRegularPolygonDrawing、辺数はツール開始時に固定)を
   * そのまま使うが、確定時に作るエンティティはregularPolygonではなく、頂点を計算済みのpolygon
   * エンティティにする(regularPolygonVertices()で頂点列を求めcreatePolygonEntity()に渡す)。
   * こうすることで、既存の辺長寸法ラベル・頂点フィレット/面取り・頂点ごとの数値編集(いずれも
   * polygonエンティティ前提)がそのまま使える。regularPolygon型自体は後方互換のためmodel/evaluatorに
   * 残っているが、このツールからは作らない。
   */
  function handleStartRegularPolygonDrawing() {
    if (!viewerRef.current || !selectedFeature || selectedFeature.type !== "sketch" || !selectedSketchPlane) return;
    const sketchId = selectedFeature.id;
    viewerRef.current.startRegularPolygonDrawing(selectedSketchPlane, gridSnap, selectedFeature.entities, polygonSides, {
      onComplete: (center, radius, rotation) => {
        const points = regularPolygonVertices(center, radius, polygonSides, rotation);
        const entity = createPolygonEntity({ points });
        updateDocument((d) => addSketchEntity(d, sketchId, entity));
        setActiveTool(null);
        setDrawingSketchId(null);
      },
      onCancel: () => {
        setActiveTool(null);
        setDrawingSketchId(null);
      },
    });
    setDrawingSketchId(sketchId);
    setActiveTool("regularPolygon");
  }

  function handleToggleArcMode() {
    const active = viewerRef.current?.togglePolygonArcMode() ?? false;
    setArcModeActive(active);
  }

  function handleStartRectDrawing() {
    if (!viewerRef.current || !selectedFeature || selectedFeature.type !== "sketch" || !selectedSketchPlane) return;
    const sketchId = selectedFeature.id;
    viewerRef.current.startRectDrawing(selectedSketchPlane, gridSnap, selectedFeature.entities, {
      onComplete: (corner1, corner2) => {
        const { center, width, height } = rectangleFromCorners(corner1, corner2);
        const entity = createRectangleEntity({ center, width, height });
        updateDocument((d) => addSketchEntity(d, sketchId, entity));
        setActiveTool(null);
        setDrawingSketchId(null);
      },
      onCancel: () => {
        setActiveTool(null);
        setDrawingSketchId(null);
      },
    });
    setDrawingSketchId(sketchId);
    setActiveTool("rect");
  }

  function handleStartCircleDrawing() {
    if (!viewerRef.current || !selectedFeature || selectedFeature.type !== "sketch" || !selectedSketchPlane) return;
    const sketchId = selectedFeature.id;
    viewerRef.current.startCircleDrawing(selectedSketchPlane, gridSnap, selectedFeature.entities, {
      onComplete: (center, radius) => {
        const entity = createCircleEntity({ center, radius });
        updateDocument((d) => addSketchEntity(d, sketchId, entity));
        setActiveTool(null);
        setDrawingSketchId(null);
      },
      onCancel: () => {
        setActiveTool(null);
        setDrawingSketchId(null);
      },
    });
    setDrawingSketchId(sketchId);
    setActiveTool("circle");
  }

  /**
   * 点ツール(Phase 47、1クリック)。SolidWorksスケッチの「点」相当の位置決め専用マーカーを置く。
   * ねじの配置スケッチ編集(handleThreadEditPlacementSketch)からもactivateOnEnter経由で
   * 事前アクティブ化される。
   */
  function handleStartPointDrawing() {
    if (!viewerRef.current || !selectedFeature || selectedFeature.type !== "sketch" || !selectedSketchPlane) return;
    const sketchId = selectedFeature.id;
    viewerRef.current.startPointDrawing(selectedSketchPlane, gridSnap, selectedFeature.entities, {
      onComplete: (position) => {
        const entity = createPointEntity({ position });
        updateDocument((d) => addSketchEntity(d, sketchId, entity));
        setActiveTool(null);
        setDrawingSketchId(null);
      },
      onCancel: () => {
        setActiveTool(null);
        setDrawingSketchId(null);
      },
    });
    setDrawingSketchId(sketchId);
    setActiveTool("point");
  }

  function handleCancelDrawing() {
    viewerRef.current?.cancelPolygonDrawing();
  }

  function handleGridSnapChange(checked: boolean) {
    setGridSnap(checked);
    viewerRef.current?.setPolygonDrawingSnap(checked);
  }

  /** 指定ツールのボタンをdisabledにすべきか(他のツールが実行中、または対象スケッチ平面が未確定)。 */
  function isToolDisabled(tool: Exclude<DrawingTool, null>): boolean {
    if (cornerTool || trimTool || extendTool || dimensionTool || constraintTool || edgeTool || shellTool || threadTool || partDragTool || mateTool || anyReselectActive) return true;
    if (activeTool) return activeTool !== tool;
    return !selectedSketchPlane;
  }

  /**
   * フィレット/面取りツール(Phase 18)を開始する。ビューア上でpolygon頂点付近をクリックすると
   * その頂点にcornerSizeで指定したサイズのフィレット/面取りを適用する(既に同種が設定済みなら
   * トグルで解除)。onVertexClickはstartCornerTool呼び出し時に一度だけ渡すコールバックのため、
   * 最新のドキュメント・サイズはgetState()/refから読む(古いクロージャを掴まないようにするため)。
   */
  function handleStartCornerTool(kind: "fillet" | "chamfer") {
    if (!viewerRef.current || !selectedFeature || selectedFeature.type !== "sketch" || !selectedSketchPlane) return;
    const sketchId = selectedFeature.id;
    viewerRef.current.startCornerTool(selectedSketchPlane, selectedFeature.entities, selectedFeature.segments ?? [], {
      onVertexClick: (entityId, vertexIndex) => {
        const currentDoc = useCadStore.getState().doc;
        const feature = findFeature(currentDoc, sketchId);
        if (!feature || feature.type !== "sketch") return;
        const entity = feature.entities.find((e) => e.id === entityId);
        if (!entity) return;
        if (entity.kind === "rectangle") {
          // rectangleは同寸法のpolygonへ変換してからコーナーを適用する(1回のドキュメント更新)。
          const next: PolygonCorner = { kind, size: cornerSizeRef.current };
          useCadStore.getState().updateDocument((d) =>
            setPolygonVertexCorner(convertRectangleToPolygon(d, sketchId, entityId), sketchId, entityId, vertexIndex, next),
          );
          return;
        }
        if (entity.kind !== "polygon") return;
        const current = entity.corners?.[vertexIndex] ?? null;
        // 既に同種のコーナーが設定済みならトグルで解除、それ以外は現在のサイズで新規/種別変更する。
        const next: PolygonCorner = current && current.kind === kind ? null : { kind, size: cornerSizeRef.current };
        useCadStore.getState().updateDocument((d) => setPolygonVertexCorner(d, sketchId, entityId, vertexIndex, next));
      },
      onSegmentCornerClick: (aSegmentId, bSegmentId) => {
        useCadStore.getState().updateDocument((d) =>
          applySegmentCornerToSketch(d, sketchId, aSegmentId, bSegmentId, kind, cornerSizeRef.current),
        );
      },
      onCancel: () => {
        setCornerTool(null);
        setDrawingSketchId(null);
      },
    });
    setDrawingSketchId(sketchId);
    setCornerTool(kind);
  }

  function handleCancelCornerTool() {
    viewerRef.current?.cancelCornerTool();
  }

  /** フィレット/面取りボタンをdisabledにすべきか(他の作図ツール実行中、または対象スケッチ平面が未確定)。 */
  function isCornerToolDisabled(kind: "fillet" | "chamfer"): boolean {
    if (activeTool || trimTool || extendTool || dimensionTool || constraintTool || edgeTool || shellTool || threadTool || partDragTool || mateTool || anyReselectActive) return true;
    if (cornerTool) return cornerTool !== kind;
    return !selectedSketchPlane;
  }

  /**
   * 3Dフィレット/面取りツール(Phase 25a)を開始する。スケッチではなくボディのB-Repエッジを
   * 直接クリックして選択する(スケッチ選択・スケッチ平面は不要、ボディが存在すればよい)。
   * 選択集合が変わるたびにonSelectionChangeが呼ばれ、edgeSelection(React state、「適用」ボタンの
   * 有効化・件数表示に使う)を更新する。実際のフィーチャー追加は「適用」ボタン
   * (handleApplyEdgeTool)が行う。
   */
  function handleStartEdgeTool(kind: "fillet" | "chamfer") {
    if (!viewerRef.current || !hasBody) return;
    viewerRef.current.startEdgeSelectTool({
      onSelectionChange: (edges) => setEdgeSelection(edges),
      onCancel: () => {
        setEdgeTool(null);
        setEdgeSelection([]);
      },
    });
    setEdgeSelection([]);
    setEdgeTool(kind);
  }

  function handleCancelEdgeTool() {
    viewerRef.current?.cancelEdgeSelectTool();
  }

  /** 「適用」ボタン: 現在の選択エッジ集合・サイズでfillet3dフィーチャーを追加し、ツールを終了する。 */
  function handleApplyEdgeTool() {
    if (!edgeTool || edgeSelection.length === 0) return;
    addFillet3D(edgeTool, edgeToolSize, edgeSelection);
    viewerRef.current?.cancelEdgeSelectTool();
  }

  /**
   * 「エッジを選び直す」(Phase 29b、Fillet3DEditor): 既存のfillet3dフィーチャーを対象に
   * エッジ選択ツールを再選択モードで起動する(空の選択から選び直す)。previewFeatureContext()で
   * このフィーチャーを適用する直前の最新ボディを一度取り直してからツールを開始することで、
   * 参照切れの原因になった直前の編集(ボディ寸法変更等)を反映したエッジをクリックできるようにする。
   */
  function handleStartEdgeReselect(fillet: Fillet3DFeature) {
    if (!viewerRef.current) return;
    previewFeatureContext(fillet.id);
    viewerRef.current.startEdgeSelectTool({
      onSelectionChange: (edges) => setEdgeSelection(edges),
      onCancel: () => {
        setEdgeReselectTargetId(null);
        setEdgeSelection([]);
      },
    });
    setEdgeSelection([]);
    setEdgeReselectTargetId(fillet.id);
  }

  /** エッジ再選択の「適用」: 選択中のエッジ集合で対象フィーチャーのedgesスナップショットを差し替える。 */
  function handleApplyEdgeReselect() {
    if (!edgeReselectTargetId || edgeSelection.length === 0) return;
    const targetId = edgeReselectTargetId;
    updateDocument((d) => replaceFillet3DEdges(d, targetId, edgeSelection));
    viewerRef.current?.cancelEdgeSelectTool();
  }

  function handleCancelEdgeReselect() {
    viewerRef.current?.cancelEdgeSelectTool();
  }

  /**
   * シェルツール(Phase 25b)を開始する。3Dフィレット/面取りツールと同じく、ボディのB-Rep面を
   * 直接クリックして選択する(スケッチ選択・スケッチ平面は不要、ボディが存在すればよい)。
   * 実際のフィーチャー追加は「適用」ボタン(handleApplyShellTool)が行う。
   */
  function handleStartShellTool() {
    if (!viewerRef.current || !hasBody) return;
    viewerRef.current.startFaceSelectTool({
      onSelectionChange: (faces) => setShellSelection(faces),
      onCancel: () => {
        setShellTool(false);
        setShellSelection([]);
      },
    });
    setShellSelection([]);
    setShellTool(true);
  }

  function handleCancelShellTool() {
    viewerRef.current?.cancelFaceSelectTool();
  }

  /** 「適用」ボタン: 現在の選択面集合・肉厚でshellフィーチャーを追加し、ツールを終了する。 */
  function handleApplyShellTool() {
    if (!shellTool || shellSelection.length === 0) return;
    addShell3D(shellToolThickness, shellSelection);
    viewerRef.current?.cancelFaceSelectTool();
  }

  /**
   * 「面を選び直す」(Phase 29b、ShellEditor): 既存のshellフィーチャーを対象に面選択ツールを
   * 再選択モードで起動する。handleStartEdgeReselectと同じくpreviewFeatureContext()で最新ボディを
   * 一度取り直してから開始する。
   */
  function handleStartShellReselect(shell: ShellFeature) {
    if (!viewerRef.current) return;
    previewFeatureContext(shell.id);
    viewerRef.current.startFaceSelectTool({
      onSelectionChange: (faces) => setShellSelection(faces),
      onCancel: () => {
        setShellReselectTargetId(null);
        setShellSelection([]);
      },
    });
    setShellSelection([]);
    setShellReselectTargetId(shell.id);
  }

  /** 面再選択の「適用」: 選択中の面集合で対象フィーチャーのfacesスナップショットを差し替える。 */
  function handleApplyShellReselect() {
    if (!shellReselectTargetId || shellSelection.length === 0) return;
    const targetId = shellReselectTargetId;
    updateDocument((d) => replaceShellFaces(d, targetId, shellSelection));
    viewerRef.current?.cancelFaceSelectTool();
  }

  function handleCancelShellReselect() {
    viewerRef.current?.cancelFaceSelectTool();
  }

  /** シェルボタンをdisabledにすべきか(他のツール実行中、またはボディが存在しない)。 */
  function isShellToolDisabled(): boolean {
    if (activeTool || cornerTool || trimTool || extendTool || dimensionTool || constraintTool || edgeTool || threadTool || partDragTool || mateTool || anyReselectActive) return true;
    if (shellTool) return false;
    return !hasBody;
  }

  /**
   * ねじツール(Phase 25c)を開始する。ボディのエッジ/面選択ツールと違い、平面を1回クリックした
   * 時点で(「適用」ボタン無しに)即座にaddThread()が呼ばれてフィーチャーが追加される。
   * プリセット・雄雌・長さはミニフォーム(ツールバー)で変更でき、クリック時点の最新値を
   * ref(threadPresetRef等)経由で読む(startEdgeSelectTool呼び出し時に一度だけ渡す
   * コールバックのため、古いクロージャを掴まないようにする、cornerSizeRefと同じパターン)。
   */
  function handleStartThreadTool() {
    if (!viewerRef.current || !hasBody) return;
    viewerRef.current.startThreadPlaceTool({
      onPick: (ref) => {
        addThread({
          preset: threadPresetRef.current,
          hand: threadHandRef.current,
          length: threadLengthRef.current,
          face: { faceId: ref.faceId, center: ref.center, normal: ref.normal },
          position: ref.position,
        });
        setThreadTool(false);
      },
      onCancel: () => {
        setThreadTool(false);
      },
    });
    setThreadTool(true);
  }

  function handleCancelThreadTool() {
    viewerRef.current?.cancelThreadPlaceTool();
  }

  /**
   * 「配置し直す」(Phase 29b、ThreadEditor): 既存のthreadフィーチャーを対象にねじ配置ツールを
   * 再選択モードで起動する。平面のクリック1回でonPickが呼ばれ、即座にface/positionを差し替える
   * (通常のねじ配置ツールと同じく「適用」ボタンは無い)。previewFeatureContext()は
   * handleStartEdgeReselectと同じ理由で呼ぶ。
   */
  function handleStartThreadReselect(thread: ThreadFeature) {
    if (!viewerRef.current) return;
    previewFeatureContext(thread.id);
    viewerRef.current.startThreadPlaceTool({
      onPick: (ref) => {
        updateDocument((d) =>
          replaceThreadPlacement(d, thread.id, {
            face: { faceId: ref.faceId, center: ref.center, normal: ref.normal },
            position: ref.position,
          }),
        );
        setThreadReselectTargetId(null);
      },
      onCancel: () => {
        setThreadReselectTargetId(null);
      },
    });
    setThreadReselectTargetId(thread.id);
  }

  function handleCancelThreadReselect() {
    viewerRef.current?.cancelThreadPlaceTool();
  }

  /**
   * 「配置スケッチを編集」(Phase 47、ThreadEditor): positionRefが設定済みならその参照先スケッチを
   * 選択するだけ(既存の選択フロー)。未設定ならstore.editThreadPlacementSketch()が配置面と同じ面の
   * スケッチを探す/新規作成してpendingThreadPlacementLinkを設定するので、そのスケッチを選択し、
   * 点ツールを事前アクティブ化する(selectedSketchPlaneが解決されるまで待つ、下のuseEffect参照)。
   */
  function handleEditThreadPlacementSketch(thread: ThreadFeature) {
    const result = editThreadPlacementSketch(thread.id);
    if (!result) return;
    selectFeature(result.sketchId);
    if (result.guided) setPendingGuidedPointToolSketchId(result.sketchId);
  }

  // pendingGuidedPointToolSketchId(上記)が指すスケッチのselectedSketchPlaneが解決され次第、
  // 点ツールを起動する(新規作成したスケッチはWorker再評価完了まで平面が無いため、既存スケッチなら
  // 即座に、新規なら再評価完了後に発火する)。
  useEffect(() => {
    if (!pendingGuidedPointToolSketchId) return;
    if (selectedFeature?.type !== "sketch" || selectedFeature.id !== pendingGuidedPointToolSketchId) return;
    if (!selectedSketchPlane) return;
    setPendingGuidedPointToolSketchId(null);
    handleStartPointDrawing();
    // handleStartPointDrawingは選択中スケッチ(selectedFeature/selectedSketchPlane)を直接参照するため、
    // 依存配列にも含める(古いクロージャで別スケッチを対象にしないため)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGuidedPointToolSketchId, selectedFeature, selectedSketchPlane]);

  // ねじのpositionRef自動リンク(Phase 47、store.selectFeature()がpendingThreadPlacementLinkを
  // 消費した際にセットするトーストメッセージ)。検知したら表示して直後にクリアする(一度きり)。
  const pendingThreadAutoLinkMessage = useCadStore((s) => s.pendingThreadAutoLinkMessage);
  useEffect(() => {
    if (!pendingThreadAutoLinkMessage) return;
    showTransientMessage(pendingThreadAutoLinkMessage, "success");
    useCadStore.setState({ pendingThreadAutoLinkMessage: null });
  }, [pendingThreadAutoLinkMessage]);

  /** ねじボタンをdisabledにすべきか(他のツール実行中、またはボディが存在しない)。 */
  function isThreadToolDisabled(): boolean {
    if (activeTool || cornerTool || trimTool || extendTool || dimensionTool || constraintTool || edgeTool || shellTool || partDragTool || mateTool || anyReselectActive) return true;
    if (threadTool) return false;
    return !hasBody;
  }

  /**
   * 部品移動ツール(Phase 28a)を開始する。ボディのエッジ/面選択ツールと違い、確定操作はクリックでは
   * なくドラッグ(mousedown〜mouseup)で完結する。onDragStart/onDragMove/onDragEndはCadViewer側の
   * コールバックで、ドラッグ開始時に対象featureId・その時点の部品位置(base)をrefへ記録し、以降は
   * base+delta(ドラッグ開始点からの累積オフセット)を部品のpositionとして
   * updateDocumentDuringDrag()(履歴を積まない直接更新)へ渡す。onDragStartでのみ
   * beginDragHistory()を1回呼ぶことで、ドラッグ全体(開始〜終了)がアンドゥ1回になる。
   */
  function handleStartPartDragTool() {
    if (!viewerRef.current) return;
    viewerRef.current.startPartDragTool(gridSnap, {
      onDragStart: (featureId) => {
        partDragFeatureIdRef.current = featureId;
        const feature = findFeature(useCadStore.getState().doc, featureId);
        partDragBasePositionRef.current = feature && feature.type === "partInstance" ? feature.position : [0, 0, 0];
        useCadStore.getState().beginDragHistory();
      },
      onDragMove: (delta) => {
        const featureId = partDragFeatureIdRef.current;
        const base = partDragBasePositionRef.current;
        if (!featureId || !base) return;
        const next: [number, number, number] = [base[0] + delta[0], base[1] + delta[1], base[2] + delta[2]];
        useCadStore.getState().updateDocumentDuringDrag((d) => patchPartInstanceFeature(d, featureId, { position: next }));
      },
      onDragEnd: (delta) => {
        const featureId = partDragFeatureIdRef.current;
        const base = partDragBasePositionRef.current;
        if (featureId && base) {
          const next: [number, number, number] = [base[0] + delta[0], base[1] + delta[1], base[2] + delta[2]];
          useCadStore.getState().updateDocumentDuringDrag((d) => patchPartInstanceFeature(d, featureId, { position: next }));
        }
        partDragFeatureIdRef.current = null;
        partDragBasePositionRef.current = null;
      },
      onCancel: () => setPartDragTool(false),
    });
    setPartDragTool(true);
  }

  function handleCancelPartDragTool() {
    viewerRef.current?.cancelPartDragTool();
  }

  /** 部品移動ボタンをdisabledにすべきか(他のツール実行中、または部品[partInstance]が1つも無い)。 */
  function isPartDragToolDisabled(): boolean {
    if (activeTool || cornerTool || trimTool || extendTool || dimensionTool || constraintTool || edgeTool || shellTool || threadTool || mateTool || anyReselectActive) return true;
    if (partDragTool) return false;
    return !doc.features.some((f) => f.type === "partInstance");
  }

  /**
   * 合致(メイト、Phase 28c)ツールを開始する。ビューア上でボディの面(平面/円筒面)を2つ順に
   * クリックすると`onPairPicked`が呼ばれ、面の組み合わせ(平面+平面/円筒+円筒/それ以外)に応じて
   * 適用可能な合致の選択ポップアップ(matePopup)を開く。実際のフィーチャー追加は
   * handleApplyMateKindが行う(constraintTool[2D拘束ツール]と同じ「ポップアップで選ぶまでは
   * 確定しない」設計)。適用後もツール自体は継続する(連続して複数の合致を追加できる)。
   */
  function handleStartMateTool() {
    if (!viewerRef.current || !hasBody) return;
    viewerRef.current.startMateTool({
      onPairPicked: (a, b, screenX, screenY) => {
        setMatePopup({ a, b, screen: { x: screenX, y: screenY } });
      },
      onCancel: () => {
        setMateTool(false);
        setMatePopup(null);
        setMatePendingLabel(null);
      },
      onPendingChange: (pending) => {
        if (!pending) {
          setMatePendingLabel(null);
          return;
        }
        const label = pending.surface === "plane" ? "平面" : pending.surface === "cylinder" ? "円筒面" : "面";
        setMatePendingLabel(`1つ目: ${label} → 2つ目の面を選択`);
      },
    });
    setMateTool(true);
  }

  function handleCancelMateTool() {
    viewerRef.current?.cancelMateTool();
  }

  /**
   * 「面を選び直す」(Phase 29b、MateEditor): 既存のmateフィーチャーを対象に合致ツールを
   * 再選択モードで起動する。通常の合致ツール(handleStartMateTool)と違い、2つ目の面が確定しても
   * 種別選択ポップアップ(matePopup)は開かず、既存のkindを維持したままa/bだけを即座に差し替える。
   * ピックした組み合わせがtoMateFaceRef()で変換できない(平面/円筒面以外)場合は一時トーストで
   * 知らせ、ツール自体は継続する(選び直せる)。previewFeatureContext()は他の再選択と同じ理由で呼ぶ。
   */
  function handleStartMateReselect(mate: MateFeature) {
    if (!viewerRef.current) return;
    previewFeatureContext(mate.id);
    viewerRef.current.startMateTool({
      onPairPicked: (a, b) => {
        const aRef = toMateFaceRef(a);
        const bRef = toMateFaceRef(b);
        if (!aRef || !bRef) {
          showTransientMessage("この組み合わせの面は選択できません(平面または円筒面を選んでください)", "error");
          return;
        }
        updateDocument((d) => replaceMateFaces(d, mate.id, { a: aRef, b: bRef }));
        viewerRef.current?.cancelMateTool();
        setMateReselectTargetId(null);
      },
      onCancel: () => {
        setMateReselectTargetId(null);
        setMatePendingLabel(null);
      },
      onPendingChange: (pending) => {
        if (!pending) {
          setMatePendingLabel(null);
          return;
        }
        const label = pending.surface === "plane" ? "平面" : pending.surface === "cylinder" ? "円筒面" : "面";
        setMatePendingLabel(`1つ目: ${label} → 2つ目の面を選択`);
      },
    });
    setMateReselectTargetId(mate.id);
  }

  function handleCancelMateReselect() {
    viewerRef.current?.cancelMateTool();
  }

  /** 合致ボタンをdisabledにすべきか(他のツール実行中、または部品[partInstance]と他ボディの組み合わせが無い)。 */
  function isMateToolDisabled(): boolean {
    if (activeTool || cornerTool || trimTool || extendTool || dimensionTool || constraintTool || edgeTool || shellTool || threadTool || partDragTool || anyReselectActive) {
      return true;
    }
    if (mateTool) return false;
    const hasPart = doc.features.some((f) => f.type === "partInstance");
    return !hasPart || bodyCount < 2;
  }

  /**
   * ピックした2面の組み合わせから適用可能な合致の選択肢を返す(表示ラベル+kind)。
   * 平面+平面=一致/距離、円筒+円筒=同軸、それ以外の組み合わせは空配列(ポップアップ側で
   * 「適用できる合致がありません」メッセージを表示する)。
   */
  function mateOptionsFor(a: MatePickTarget, b: MatePickTarget): { label: string; kind: MateFeature["kind"] }[] {
    if (a.surface === "plane" && b.surface === "plane") {
      return [
        { label: "一致", kind: "coincident" },
        { label: "距離", kind: "distance" },
      ];
    }
    if (a.surface === "cylinder" && b.surface === "cylinder") {
      return [{ label: "同軸", kind: "concentric" }];
    }
    return [];
  }

  /**
   * MatePickTarget(ビューアがワールド座標で報告するピック結果)をMateFaceRefへ変換する。
   * bodyFeatureIdがpartInstanceの場合、center/normalを「そのpartInstanceの現在の位置・回転」を
   * 使って部品ローカル座標系へ逆変換する(worldPointToLocal/worldDirectionToLocal、
   * src/assembly/mateSolver.ts)。replicadのface.hashCodeはrotate()/translate()後は保持されないため
   * (実測確認済み)、partInstanceが作ったボディの面参照は評価のたびに幾何マッチングの
   * フォールバックで解決される。マッチング対象(evaluator.tsのlocalFaceIndexById)が
   * 部品ローカル座標系のジオメトリであるため、ここで保存するcenter/normalも同じ座標系に
   * 揃えておく必要がある(通常ボディ[fixedとして扱う]はワールド座標のまま=変換しない)。
   */
  function toMateFaceRef(target: MatePickTarget): MateFaceRef | null {
    if (target.surface === "other") return null;
    const owner = findFeature(doc, target.bodyFeatureId);
    if (owner?.type === "partInstance") {
      const center = worldPointToLocal(target.center, owner.position, owner.rotation);
      const normal = worldDirectionToLocal(target.normal, owner.rotation);
      return { bodyFeatureId: target.bodyFeatureId, faceId: target.faceId, center, normal, surface: target.surface };
    }
    return {
      bodyFeatureId: target.bodyFeatureId,
      faceId: target.faceId,
      center: target.center,
      normal: target.normal,
      surface: target.surface,
    };
  }

  /** 合致ポップアップで種別が選ばれたときの合致フィーチャー追加(即ソルブ、Worker評価は既存経路で自動発行される)。 */
  function handleApplyMateKind(kind: MateFeature["kind"]) {
    if (!matePopup) return;
    const aRef = toMateFaceRef(matePopup.a);
    const bRef = toMateFaceRef(matePopup.b);
    if (!aRef || !bRef) return;
    const count = doc.features.filter((f) => f.type === "mate").length + 1;
    addMate({
      name: `合致${count}`,
      kind,
      value: kind === "distance" ? mateDistanceValue : undefined,
      a: aRef,
      b: bRef,
    });
    setMatePopup(null);
  }

  /**
   * 干渉チェックの実行(Phase 28b)。他のツールと違いモードを持たず、クリック1回で即座に
   * Workerへリクエストを送り、結果をストアのinterferenceResultへ反映する(実行中インジケータは
   * interferenceChecking、UIへのビューア反映は上のuseEffectが担う)。
   * 干渉が0件だった場合のみ、既存の一時トースト機構(showTransientMessage、拘束矛盾時と共通)で
   * 「干渉はありません」を表示する(干渉ありの場合はサイドパネルの一覧+赤ハイライトで十分明示的なため
   * トーストは出さない)。
   */
  async function handleCheckInterference() {
    const result = await checkInterference();
    if (result && result.pairs.length === 0) {
      showTransientMessage("干渉はありません", "success");
    }
  }

  /** 干渉チェックボタンをdisabledにすべきか(他のツール実行中、またはボディが2個未満)。 */
  function isInterferenceCheckDisabled(): boolean {
    if (activeTool || cornerTool || trimTool || extendTool || dimensionTool || constraintTool || edgeTool || shellTool || partDragTool || threadTool || mateTool || anyReselectActive) return true;
    return bodyCount < 2;
  }

  /**
   * トリムツール(Phase 19b)を開始する。ビューア上でセグメントの区間をクリックすると
   * その区間を削除する(実際の適用はここで行う。onTrimClickはstartTrimTool呼び出し時に一度だけ
   * 渡すコールバックのため、最新のドキュメントはgetState()から読む)。
   * 自由な線分・円弧(isEntity:false)のトリムはtrimSketchSegmentAtPoint()(実機報告対応、Phase 31a)を
   * 使う。断片へのID引き継ぎ・拘束の付け替えを行った上で、意味が変わるlength拘束を削除した場合は
   * 一時トーストで件数を知らせる。entity輪郭のトリム(isEntity:true)はtrimSketchEntityAtPoint()。
   * どちらも断片化で生じた断点(cut point)には、隣接する他セグメントの端点とCUT_MATCH_EPS(1e-4mm)
   * 以内で座標が一致すればcoincident拘束を自動付与する(src/sketch/trim.tsのcoincidentsForCutPoints、
   * Phase 36。断片同士が一致拘束を持たないままソルバ再実行のたびにドリフトし、領域検出が外枠を
   * 見失う実機報告バグの根本原因の修正)。
   */
  function handleStartTrimTool() {
    if (!viewerRef.current || !selectedFeature || selectedFeature.type !== "sketch" || !selectedSketchPlane) return;
    const sketchId = selectedFeature.id;
    viewerRef.current.startTrimTool(
      selectedSketchPlane,
      selectedFeature.segments ?? [],
      {
        onTrimClick: (targetId, clickPoint, isEntity) => {
          const currentDoc = useCadStore.getState().doc;
          const feature = findFeature(currentDoc, sketchId);
          if (!feature || feature.type !== "sketch") return;
          if (isEntity) {
            // entity(円・矩形・多角形・スロット等)輪郭のトリム: entities/segmentsの置き換えを1回の更新にまとめる。
            // Phase 42: entityId自体を参照していた拘束(fixEntity/tangent等)の移行・削除件数が
            // 1件以上あれば一時トーストで通知する(実機報告バグ対応)。
            const { doc: nextDoc, removedConstraintCount } = trimSketchEntityAtPoint(currentDoc, sketchId, targetId, clickPoint);
            useCadStore.getState().updateDocument(() => nextDoc);
            if (removedConstraintCount > 0) {
              showTransientMessage(`トリムにより不要になった拘束${removedConstraintCount}件を削除しました`);
            }
            return;
          }
          const { doc: nextDoc, removedLengthConstraintCount, removedDanglingConstraintCount } = trimSketchSegmentAtPoint(
            currentDoc,
            sketchId,
            targetId,
            clickPoint,
          );
          useCadStore.getState().updateDocument(() => nextDoc);
          // Phase 42: 長さ寸法の削除(意味が変わるため常に削除)と、参照切れ拘束の掃除(セグメント
          // 全体削除で付け替え先が無くなったcoincident/fix等)の両方をまとめて通知する
          // (既存e2e[dimension-drag-and-trim.spec.ts]は長さ寸法のみのケースの文言に依存するため、
          // 単独の場合は既存文言を維持する)。
          if (removedLengthConstraintCount > 0 && removedDanglingConstraintCount === 0) {
            showTransientMessage(`トリムにより長さ寸法${removedLengthConstraintCount}件を削除しました`);
          } else if (removedDanglingConstraintCount > 0 && removedLengthConstraintCount === 0) {
            showTransientMessage(`トリムにより不要になった拘束${removedDanglingConstraintCount}件を削除しました`);
          } else if (removedLengthConstraintCount > 0 && removedDanglingConstraintCount > 0) {
            showTransientMessage(
              `トリムにより長さ寸法${removedLengthConstraintCount}件・不要になった拘束${removedDanglingConstraintCount}件を削除しました`,
            );
          }
        },
        onCancel: () => {
          setTrimTool(false);
          setDrawingSketchId(null);
        },
      },
      selectedFeature.entities ?? [],
    );
    setDrawingSketchId(sketchId);
    setTrimTool(true);
  }

  function handleCancelTrimTool() {
    viewerRef.current?.cancelTrimTool();
  }

  /** トリムボタンをdisabledにすべきか(他のツール実行中、または対象スケッチ平面が未確定)。 */
  function isTrimToolDisabled(): boolean {
    if (activeTool || cornerTool || extendTool || dimensionTool || constraintTool || edgeTool || shellTool || threadTool || partDragTool || mateTool || anyReselectActive) return true;
    if (trimTool) return false;
    return !selectedSketchPlane;
  }

  /**
   * 延長ツール(Phase 31b、トリムの逆)を開始する。ビューア上で直線セグメントの近い側の端点付近を
   * クリックすると、その端点を最初に交わる相手(他のsegments・entities輪郭・参照エッジ)まで伸ばす
   * (実際のextendSegmentAtPoint()適用はここで行う。onExtendClickはstartExtendTool呼び出し時に
   * 一度だけ渡すコールバックのため、最新のドキュメントはgetState()から読む)。延長で動く端点に
   * 一致拘束が付いている場合は矛盾しうるため、その拘束を削除してから延長し、トースト通知する
   * (src/model/document.tsのextendSketchSegmentAtPoint()参照)。
   */
  function handleStartExtendTool() {
    if (!viewerRef.current || !selectedFeature || selectedFeature.type !== "sketch" || !selectedSketchPlane) return;
    const sketchId = selectedFeature.id;
    const initialReferenceEdges = referenceEdges.find((r) => r.sketchId === sketchId)?.edges ?? [];
    viewerRef.current.startExtendTool(
      selectedSketchPlane,
      selectedFeature.segments ?? [],
      {
        onExtendClick: (targetId, clickPoint) => {
          const currentReferenceEdges = useCadStore.getState().referenceEdges.find((r) => r.sketchId === sketchId)?.edges ?? [];
          let removedCoincidentConstraint = false;
          useCadStore.getState().updateDocument((d) => {
            const feature = findFeature(d, sketchId);
            if (!feature || feature.type !== "sketch") return d;
            const result = extendSketchSegmentAtPoint(d, sketchId, targetId, clickPoint, currentReferenceEdges);
            removedCoincidentConstraint = result.removedCoincidentConstraint;
            return result.doc;
          });
          if (removedCoincidentConstraint) {
            showTransientMessage("延長した端点の一致拘束を解除しました");
          }
        },
        onCancel: () => {
          setExtendTool(false);
          setDrawingSketchId(null);
        },
      },
      selectedFeature.entities ?? [],
      initialReferenceEdges,
    );
    setDrawingSketchId(sketchId);
    setExtendTool(true);
  }

  function handleCancelExtendTool() {
    viewerRef.current?.cancelExtendTool();
  }

  /** 延長ボタンをdisabledにすべきか(他のツール実行中、または対象スケッチ平面が未確定)。 */
  function isExtendToolDisabled(): boolean {
    if (activeTool || cornerTool || trimTool || dimensionTool || constraintTool || edgeTool || shellTool || threadTool || partDragTool || mateTool || anyReselectActive) return true;
    if (extendTool) return false;
    return !selectedSketchPlane;
  }

  /**
   * 寸法ツール(Phase 20b、Phase 21でrectangle/circleエンティティにも対応、Phase 21bで
   * 円の位置寸法に対応)を開始する。ビューア上でセグメント本体をクリックするとlength/radius、
   * 端点を2つ順にクリックするとdistance、circleの円周・rectangleの辺をクリックすると
   * entity-radius/entity-width/entity-heightのヒット対象として`onTargetPicked`が呼ばれ、
   * 現在値をデフォルトにした値入力ポップアップを開く。
   * 位置寸法(circle-distance-*): circleをクリックした直後(entity-radiusポップアップが開いている間)に
   * 続けて原点マーカー/別のcircle/辺をクリックすると、CadViewer側がそのcircleを基準にした
   * circle-distance-origin/circle-distance-circle/circle-distance-edgeを渡してくる
   * (「後にクリックした方(2点目)が移動する」)。
   * 適用は`handleApplyDimensionTarget`が行う(entity系・circle-distance系はいずれも拘束を経由せず
   * entity自身を直接更新する)。
   */
  function handleStartDimensionTool() {
    if (!viewerRef.current || !selectedFeature || selectedFeature.type !== "sketch" || !selectedSketchPlane) return;
    const sketchId = selectedFeature.id;
    viewerRef.current.startDimensionTool(selectedSketchPlane, selectedFeature.segments ?? [], selectedFeature.entities, selectedFeature.constraints ?? [], {
      onTargetPicked: (target, screenX, screenY) => {
        const currentDoc = useCadStore.getState().doc;
        const feature = findFeature(currentDoc, sketchId);
        const segments = feature?.type === "sketch" ? (feature.segments ?? []) : [];
        const entities = feature?.type === "sketch" ? feature.entities : [];
        // 「原点」=ワールド原点をスケッチ平面へ投影した点(仕様変更対応)。selectedSketchPlaneは
        // startDimensionTool呼び出し時点でnon-nullが保証済み(この関数の冒頭で早期returnしている)。
        const originLocal = worldOriginLocal(selectedSketchPlane);
        let titleLabel = "距離 (mm)";
        let initialValue = 0;
        let hintLabel: string | undefined;
        let axisOptions = false;
        // 0を許容する距離系の値かどうか(寸法値の符号仕様の明確化、Phase 33)。対象の種別ごとに
        // 下のif連鎖で該当すればtrueにする(axisOptions対象の3種・端点↔線距離・線↔線距離)。
        let allowZero = false;
        if (target.kind === "length") {
          titleLabel = "長さ (mm)";
          const seg = segments.find((s) => s.id === target.segmentId);
          initialValue = seg ? segmentLength(seg) : 0;
        } else if (target.kind === "radius") {
          titleLabel = "半径 (mm)";
          const seg = segments.find((s) => s.id === target.segmentId);
          initialValue = (seg && segmentRadius(seg)) ?? 0;
        } else if (target.kind === "distance") {
          // 端点↔端点の距離(頂点ベースの寸法指定、Phase 30: X/Y距離にも対応)。
          initialValue = distanceBetweenRefs(segments, target.a, target.b) ?? 0;
          axisOptions = true;
          allowZero = true;
        } else if (target.kind === "entity-radius") {
          titleLabel = "半径 (mm)";
          const entity = entities.find((e) => e.id === target.entityId);
          initialValue = entity?.kind === "circle" ? entity.radius : 0;
          hintLabel = "距離指定へ: 原点/別の円/辺(直線)をクリック";
        } else if (target.kind === "entity-width" || target.kind === "entity-height") {
          titleLabel = target.kind === "entity-width" ? "幅 (mm)" : "高さ (mm)";
          const entity = entities.find((e) => e.id === target.entityId);
          initialValue =
            entity?.kind === "rectangle" ? (target.kind === "entity-width" ? entity.width : entity.height) : 0;
        } else if (target.kind === "circle-distance-origin") {
          // 円の中心↔原点の距離(頂点ベースの寸法指定と同じ考え方でX/Y距離にも対応、Phase 35b-2:
          // Y距離拘束が付いた円をドラッグするとX方向のみ追従する挙動の土台)。
          titleLabel = "中心↔原点の距離 (mm)";
          const entity = entities.find((e) => e.id === target.entityId);
          initialValue = entity?.kind === "circle" ? distanceBetweenPoints(entity.center, originLocal) : 0;
          axisOptions = true;
          allowZero = true;
        } else if (target.kind === "point-distance-origin") {
          // セグメント端点↔原点の距離(追加項目: 原点ピック常時有効化。頂点ベースの寸法指定、
          // Phase 30でX/Y距離にも対応)。
          titleLabel = "端点↔原点の距離 (mm)";
          const p = pointFromRef(segments, target.point, entities);
          initialValue = p ? distanceBetweenPoints(p, originLocal) : 0;
          axisOptions = true;
          allowZero = true;
        } else if (target.kind === "point-distance-line") {
          // 頂点↔線の距離(頂点ベースの寸法指定、Phase 30新設)。circle-distance-edge/refedgeと同じ
          // 考え方だが対象がcircleの中心ではなく自由な端点である点のみが異なる。
          titleLabel = target.line.kind === "refEdge" ? "端点↔参照エッジの距離 (mm)" : "端点↔辺の距離 (mm)";
          const p = pointFromRef(segments, target.point, entities);
          initialValue = p ? distancePointToLine(p, target.edgeA, target.edgeB) : 0;
          allowZero = true;
          hintLabel =
            target.line.kind === "refEdge"
              ? "参照エッジは動かず、端点だけが移動します"
              : "長さ拘束の無い線分は伸び、長さ拘束があれば線分ごと平行移動します";
        } else if (target.kind === "line-distance-origin") {
          // 辺↔原点の距離(Phase 48b: 寸法ツールの原点との組み合わせを円/端点に加え辺にも拡張)。
          // point-distance-lineと同じ考え方だが対象がentityの頂点ではなく辺(無限直線扱い)、
          // 相手が線ではなく原点(常に固定)である点のみが異なる。
          titleLabel = "辺↔原点の距離 (mm)";
          initialValue = distancePointToLine(originLocal, target.edgeA, target.edgeB);
          allowZero = true;
          hintLabel = "原点は動かず、辺(固定していなければ)が移動します";
        } else if (target.kind === "circle-distance-circle") {
          titleLabel = "中心間の距離 (mm)";
          const from = entities.find((e) => e.id === target.fromEntityId);
          const to = entities.find((e) => e.id === target.toEntityId);
          initialValue =
            from?.kind === "circle" && to?.kind === "circle" ? distanceBetweenPoints(from.center, to.center) : 0;
          hintLabel = "後にクリックした円(この円)が移動します";
          axisOptions = true;
          allowZero = true;
        } else if (target.kind === "circle-distance-edge" || target.kind === "circle-distance-refedge") {
          titleLabel = target.kind === "circle-distance-refedge" ? "中心↔参照エッジの距離 (mm)" : "中心↔辺の距離 (mm)";
          const entity = entities.find((e) => e.id === target.entityId);
          initialValue = entity?.kind === "circle" ? distancePointToLine(entity.center, target.edgeA, target.edgeB) : 0;
          // 矩形・多角形・線分をソルバで動かせるようにする改善(ユーザー報告対応)で、rectangle/
          // polygonの辺・自由な線分は円の「固定」チェック次第でどちらも動けるようになった。
          // 参照エッジ(refedge)はボディ端面のスナップショットで常に固定なので円だけが動く。
          hintLabel =
            target.kind === "circle-distance-refedge"
              ? "参照エッジは動かず、円の中心だけが移動します"
              : "円を固定していれば辺が、していなければ円が移動します";
        }
        let quantityOptions: { distanceValue: number; angleValue: number; initial: "distance" | "angle" } | undefined;
        if (target.kind === "line-line" || target.kind === "line-refedge") {
          // 線↔線距離は0を許可(平行かつ線上一致、寸法値の符号仕様の明確化、Phase 33)。
          // DimensionToolPopup側で「角度」選択中はこのフラグを無視する(角度は従来通り正の数のみ)。
          allowZero = true;
        }
        if (target.kind === "line-line") {
          // 線分↔線分の寸法(Phase 24、Phase 48でrectangle/polygon/regularPolygon/slotの辺にも拡張):
          // ほぼ平行(折り畳み角<5度)なら平行距離、それ以外は角度をデフォルト選択する。逆向きに描いた
          // 平行線(なす角≈180度)も折り畳んで平行判定するため、foldToAcuteAngle/isNearlyParallelAngleを
          // 介す(素の角度<5度だけを見ていた旧実装のバグ修正)。
          const lineA = resolveLineRefPoints(target.a, entities, segments);
          const lineB = resolveLineRefPoints(target.b, entities, segments);
          const angle = lineA && lineB ? angleBetweenLines(lineA[0], lineA[1], lineB[0], lineB[1]) : null;
          const foldedAngle = angle !== null ? foldToAcuteAngle(angle) : 0;
          const distanceValue = lineA && lineB ? distancePointToLine(lineA[0], lineB[0], lineB[1]) : 0;
          const initial: "distance" | "angle" = isNearlyParallelAngle(angle) ? "distance" : "angle";
          quantityOptions = { distanceValue, angleValue: foldedAngle, initial };
          titleLabel = initial === "distance" ? "距離 (mm)" : "角度 (°)";
          initialValue = initial === "distance" ? distanceValue : foldedAngle;
        } else if (target.kind === "line-refedge") {
          // 線分/辺↔参照エッジの寸法(Phase 24項目2、Phase 48でrectangle/polygon/regularPolygon/slotの
          // 辺にも拡張): line-lineと同じく距離/角度を選べる。参照エッジは固定線として扱うため、
          // 残差は線分側の端点から参照エッジ直線への距離・角度。
          const lineA = resolveLineRefPoints(target.a, entities, segments);
          const angle = lineA ? angleBetweenLines(lineA[0], lineA[1], target.edgeA, target.edgeB) : null;
          const foldedAngle = angle !== null ? foldToAcuteAngle(angle) : 0;
          const distanceValue = lineA ? distancePointToLine(lineA[0], target.edgeA, target.edgeB) : 0;
          const initial: "distance" | "angle" = isNearlyParallelAngle(angle) ? "distance" : "angle";
          quantityOptions = { distanceValue, angleValue: foldedAngle, initial };
          titleLabel = initial === "distance" ? "距離 (mm)" : "角度 (°)";
          initialValue = initial === "distance" ? distanceValue : foldedAngle;
          hintLabel = "参照エッジは動きません";
        }
        setDimensionPopup({
          target,
          titleLabel,
          initialValue,
          screen: { x: screenX, y: screenY },
          hintLabel,
          axisOptions,
          allowZero,
          quantityOptions,
        });
      },
      onCancel: () => {
        setDimensionTool(false);
        setDrawingSketchId(null);
        setDimensionPopup(null);
        setDimensionPendingLabel(null);
      },
      // 1点目待ち状態のステータス表示(UI改善対応)。
      onPendingChange: (state) => {
        if (!state) {
          setDimensionPendingLabel(null);
        } else if (state.kind === "circle") {
          setDimensionPendingLabel("1つ目: 円 → 2つ目を選択(原点/円/辺/端面)");
        } else if (state.kind === "line") {
          // 選択順柔軟化(Phase 48で辺[entityEdge]・Phase 48bで原点との組み合わせにも対応)。
          setDimensionPendingLabel("1つ目: 線分 → 2つ目の線分/辺/参照エッジ/端点/原点を選択(距離/角度/垂直距離)");
        } else if (state.kind === "edge") {
          // 選択順柔軟化(UI改善): 辺(矩形・多角形等)を1つ目としてクリックした状態。Phase 48で
          // 線分/参照エッジとの組み合わせ、Phase 48bで原点との組み合わせにも対応した。
          setDimensionPendingLabel("1つ目: 辺 → 次: 円/端点/線分/参照エッジ/原点をクリック");
        } else if (state.kind === "refedge") {
          // 参照エッジを1つ目に選べるようにする改善(追加項目): ボディ端面参照エッジ(破線)を
          // 1つ目としてクリックした状態。次は円(円↔参照エッジの距離)・線分/辺(線分↔参照エッジの
          // 距離/角度、Phase 48で辺にも対応)・端点(頂点ベースの寸法指定、Phase 30新設: 端点↔参照エッジの
          // 垂直距離)のいずれも選べる(原点との組み合わせは対象外、Phase 48b)。
          setDimensionPendingLabel("1つ目: 参照エッジ → 次: 円/線分/辺/端点をクリック");
        } else if (state.kind === "origin") {
          // 原点ピック常時有効化(追加項目、ユーザー報告対応)。Phase 48でentityの頂点(rectangle等の
          // 角、点エンティティ含む)、Phase 48bで辺との組み合わせにも対応した。
          setDimensionPendingLabel("1つ目: 原点 → 2つ目を選択(円/端点/頂点/点/辺)");
        } else {
          // 頂点ベースの寸法指定(Phase 30新設): 端点↔線(自由な線分/rectangle・polygonの辺/
          // 参照エッジ)の垂直距離にも対応。
          setDimensionPendingLabel("1つ目: 端点 → 2つ目を選択(端点/原点/線)");
        }
      },
    });
    setDrawingSketchId(sketchId);
    setDimensionTool(true);
  }

  function handleCancelDimensionTool() {
    viewerRef.current?.cancelDimensionTool();
  }

  /** 寸法ツールボタンをdisabledにすべきか(他のツール実行中、または対象スケッチ平面が未確定)。 */
  function isDimensionToolDisabled(): boolean {
    if (activeTool || cornerTool || trimTool || extendTool || constraintTool || edgeTool || shellTool || threadTool || partDragTool || mateTool || anyReselectActive) return true;
    if (dimensionTool) return false;
    return !selectedSketchPlane;
  }

  /**
   * 寸法ツールの値入力ポップアップの確定。
   * segments系(length/radius/distance)は既存拘束があれば流用・無ければ新規作成し、矛盾したら
   * 自動的に巻き戻す。entity系(entity-radius/entity-width/entity-height、Phase 21)は拘束を
   * 経由せずrectangle/circleエンティティのradius/width/heightフィールドを直接更新する
   * (SketchEditorの数値編集と同じ経路。ソルバを経由しないため矛盾巻き戻しの対象外)。
   * circle-distance-*(Phase 22)は distanceEntityOrigin/distanceEntityEntity/distanceEntityLine
   * 拘束のupsertに置き換えた(以前は円のcenterを直接書き換えていたが、ソルバに乗せることで
   * 他の拘束[矩形のサイズ変更等]と共存できるようにするため)。他のsegments系と同じく
   * updateDocumentWithConflictRollbackを通すため、矛盾すれば自動的に取り消される。
   */
  function handleApplyDimensionTarget(value: number, axis?: "direct" | "x" | "y", quantity?: "distance" | "angle") {
    if (!dimensionPopup || !selectedFeature || selectedFeature.type !== "sketch") return;
    const sketchId = selectedFeature.id;
    const target = dimensionPopup.target;
    // 距離/角度の選択(Phase 24項目3、UI改善): ポップアップのラジオで明示的に選ばれた方を使う
    // (未指定ならポップアップ表示時に決めた既定[折り畳み角<5度なら距離]にフォールバック)。
    const wantsDistance = (quantity ?? dimensionPopup.quantityOptions?.initial) !== "angle";
    // 「原点」=ワールド原点をスケッチ平面へ投影した点(仕様変更対応)。selectedSketchPlaneが
    // 解決できていない(面参照が壊れた等)場合はundefinedのまま渡し、upsert側の[0,0]フォールバックに任せる。
    const originLocal = selectedSketchPlane ? worldOriginLocal(selectedSketchPlane) : undefined;

    if (target.kind === "entity-radius") {
      updateDocument((doc) => updateSketchEntity(doc, sketchId, target.entityId, { radius: value }));
      setDimensionPopup(null);
      return;
    }
    if (target.kind === "entity-width" || target.kind === "entity-height") {
      const field = target.kind === "entity-width" ? "width" : "height";
      updateDocument((doc) => updateSketchEntity(doc, sketchId, target.entityId, { [field]: value }));
      setDimensionPopup(null);
      return;
    }

    if (target.kind === "line-line") {
      // 線分↔線分の寸法(Phase 24): ユーザーが選んだ距離/角度(ラジオ)に応じてどちらの拘束にするかを決める。
      updateDocumentWithConflictRollback(
        sketchId,
        (doc) => {
          const feature = doc.features.find((f) => f.id === sketchId);
          if (feature?.type !== "sketch") return doc;
          const constraints = feature.constraints ?? [];
          const next = wantsDistance
            ? upsertDistanceLineLineConstraint(constraints, target.a, target.b, value)
            : upsertAngleLineLineConstraint(constraints, target.a, target.b, value);
          return setSketchConstraints(doc, sketchId, next);
        },
        (message) => showTransientMessage(message, "error"),
      );
      setDimensionPopup(null);
      return;
    }

    if (target.kind === "line-refedge") {
      // 線分↔参照エッジの寸法(Phase 24項目2): line-lineと同じく距離/角度の選択に応じて切り替える。
      updateDocumentWithConflictRollback(
        sketchId,
        (doc) => {
          const feature = doc.features.find((f) => f.id === sketchId);
          if (feature?.type !== "sketch") return doc;
          const constraints = feature.constraints ?? [];
          const next = wantsDistance
            ? upsertDistanceLineRefEdgeConstraint(constraints, target.a, target.line, value)
            : upsertAngleLineRefEdgeConstraint(constraints, target.a, target.line, value);
          return setSketchConstraints(doc, sketchId, next);
        },
        (message) => showTransientMessage(message, "error"),
      );
      setDimensionPopup(null);
      return;
    }

    // 矛盾巻き戻しの誘導メッセージ(頂点ベースの寸法指定、Phase 30新設): distance/point-distance-origin
    // (axis省略/"direct")のみ、適用前の座標から典型的な解なしケース(既にX/Y方向に離れている量より
    // 小さい直線距離を要求)を検出して具体的なメッセージを出す。他のtarget種別・検出できない場合は
    // updateDocumentWithConflictRollback側の既定メッセージにフォールバックする。
    const describeConflict = (before: CadDocument): string | null => {
      const feature = findFeature(before, sketchId);
      if (feature?.type !== "sketch") return null;
      const beforeSegments = feature.segments ?? [];
      if (target.kind === "distance") {
        const pa = pointFromRef(beforeSegments, target.a);
        const pb = pointFromRef(beforeSegments, target.b);
        if (!pa || !pb) return null;
        return describeAxisDistanceConflict(pa, pb, value, axis);
      }
      if (target.kind === "point-distance-origin") {
        const p = pointFromRef(beforeSegments, target.point);
        if (!p) return null;
        return describeAxisDistanceConflict(p, originLocal ?? [0, 0], value, axis);
      }
      if (target.kind === "circle-distance-origin") {
        const entity = feature.entities.find((e) => e.id === target.entityId);
        if (!entity || entity.kind !== "circle") return null;
        return describeAxisDistanceConflict(entity.center, originLocal ?? [0, 0], value, axis);
      }
      return null;
    };

    updateDocumentWithConflictRollback(
      sketchId,
      (doc) => {
        const feature = doc.features.find((f) => f.id === sketchId);
        if (feature?.type !== "sketch") return doc;
        const constraints = feature.constraints ?? [];
        const next =
          target.kind === "length"
            ? upsertLengthConstraint(constraints, target.segmentId, value)
            : target.kind === "radius"
              ? upsertRadiusConstraint(constraints, target.segmentId, value)
              : target.kind === "distance"
                ? upsertDistanceConstraint(constraints, target.a, target.b, value, axis)
                : target.kind === "circle-distance-origin"
                  ? upsertDistanceEntityOriginConstraint(constraints, target.entityId, value, originLocal, axis)
                  : target.kind === "point-distance-origin"
                    ? upsertDistancePointOriginConstraint(constraints, target.point, value, originLocal, axis)
                    : target.kind === "circle-distance-circle"
                      ? upsertDistanceEntityEntityConstraint(constraints, target.fromEntityId, target.toEntityId, value, axis)
                      : target.kind === "point-distance-line"
                        ? upsertDistancePointLineConstraint(constraints, target.point, target.line, value)
                        : target.kind === "line-distance-origin"
                          ? upsertDistanceLineOriginConstraint(constraints, target.line, value, originLocal)
                          : upsertDistanceEntityLineConstraint(constraints, target.entityId, target.line, value);
        return setSketchConstraints(doc, sketchId, next);
      },
      (message) => showTransientMessage(message, "error"),
      describeConflict,
    );
    setDimensionPopup(null);
  }

  /**
   * 拘束ツール(Phase 23)を開始する。ビューア上で直線セグメント本体またはcircleエンティティの
   * 境界を2つ順にクリックすると`onPairPicked`が呼ばれ、対象の組み合わせ(線+線/円+円/円+線)に
   * 応じて適用可能な拘束の選択ポップアップ(constraintPopup)を開く。実際の拘束作成は
   * handleApplyConstraintKindが行う。
   */
  function handleStartConstraintTool() {
    if (!viewerRef.current || !selectedFeature || selectedFeature.type !== "sketch" || !selectedSketchPlane) return;
    const sketchId = selectedFeature.id;
    viewerRef.current.startConstraintTool(selectedSketchPlane, selectedFeature.segments ?? [], selectedFeature.entities, selectedFeature.constraints ?? [], {
      onPairPicked: (a, b, screenX, screenY) => {
        setConstraintPopup({ a, b, screen: { x: screenX, y: screenY } });
      },
      onCancel: () => {
        setConstraintTool(false);
        setDrawingSketchId(null);
        setConstraintPopup(null);
        setConstraintPendingLabel(null);
      },
      onPendingChange: (pending) => {
        if (!pending) {
          setConstraintPendingLabel(null);
        } else if (pending.kind === "segment") {
          setConstraintPendingLabel("1つ目: 線分/円弧 → 2つ目を選択(線分/円弧/円)");
        } else if (pending.kind === "circle") {
          setConstraintPendingLabel("1つ目: 円 → 2つ目を選択(円/線分/円弧/原点)");
        } else if (pending.kind === "point") {
          // 原点一致(追加項目): 線分端点を1つ目としてクリックした状態。
          setConstraintPendingLabel("1つ目: 端点 → 2つ目を選択(原点)");
        } else {
          // 原点を1つ目としてクリックした状態(追加項目: 拘束ツールに「原点一致」を追加)。
          setConstraintPendingLabel("1つ目: 原点 → 2つ目を選択(円/端点)");
        }
      },
    });
    setDrawingSketchId(sketchId);
    setConstraintTool(true);
  }

  function handleCancelConstraintTool() {
    viewerRef.current?.cancelConstraintTool();
  }

  /** 拘束ツールボタンをdisabledにすべきか(他のツール実行中、または対象スケッチ平面が未確定)。 */
  function isConstraintToolDisabled(): boolean {
    if (activeTool || cornerTool || trimTool || extendTool || dimensionTool || edgeTool || shellTool || threadTool || partDragTool || mateTool || anyReselectActive) return true;
    if (constraintTool) return false;
    return !selectedSketchPlane;
  }

  /** 3Dフィレット/面取りボタンをdisabledにすべきか(他のツール実行中、またはボディが無い)。 */
  function isEdgeToolDisabled(kind: "fillet" | "chamfer"): boolean {
    if (activeTool || cornerTool || trimTool || extendTool || dimensionTool || constraintTool || shellTool || threadTool || partDragTool || mateTool || anyReselectActive) return true;
    if (edgeTool) return edgeTool !== kind;
    return !hasBody;
  }

  /** segmentIdが円弧セグメント(kind:"arc"かつbulgeあり、Phase 42b)を指しているかどうか。 */
  function isArcSegmentId(segmentId: string): boolean {
    const segments = selectedFeature?.type === "sketch" ? (selectedFeature.segments ?? []) : [];
    const seg = segments.find((s) => s.id === segmentId);
    return !!seg && seg.kind === "arc" && !!seg.bulge;
  }

  /** ConstraintPickTarget(circle/segment)をconcentric/tangentのEntityRef|ArcRefへ変換する。それ以外はnull。 */
  function curveRefFromPickTarget(t: ConstraintPickTarget): EntityRef | ArcRef | null {
    if (t.kind === "circle") return { entityId: t.entityId };
    if (t.kind === "segment") return { segmentId: t.segmentId };
    return null;
  }

  /**
   * ピックした2対象の組み合わせから適用可能な拘束の選択肢を返す(表示ラベル+kind)。
   * 線分+線分=垂直のみ、円+円=同心/接線(外接or内接は自動判定)、円+線分=接線のみ、
   * 円弧+線分=接線のみ、円弧+円弧/円弧+円=同心のみ(Phase 42b: 円弧の一級化。接線は「円弧+直線」
   * の組み合わせのみ許可し、円弧が絡む円/円弧同士は同心のみを提示する)、
   * 原点+(線分端点または円)=原点一致のみ(追加項目)。それ以外の組み合わせ(点+点等)は選択肢無し。
   */
  function constraintOptionsFor(
    a: ConstraintPickTarget,
    b: ConstraintPickTarget,
  ): { label: string; kind: "perpendicular" | "concentric" | "tangent" | "coincidentOrigin" }[] {
    if (a.kind === "origin" || b.kind === "origin") {
      const other = a.kind === "origin" ? b : a;
      if (other.kind === "point" || other.kind === "circle") return [{ label: "原点一致", kind: "coincidentOrigin" }];
      return [];
    }
    if (a.kind === "segment" && b.kind === "segment") {
      const aArc = isArcSegmentId(a.segmentId);
      const bArc = isArcSegmentId(b.segmentId);
      if (!aArc && !bArc) return [{ label: "垂直", kind: "perpendicular" }];
      if (aArc && bArc) return [{ label: "同心", kind: "concentric" }]; // 円弧↔円弧
      return [{ label: "接線", kind: "tangent" }]; // 円弧↔直線
    }
    if (a.kind === "circle" && b.kind === "circle") {
      return [
        { label: "同心", kind: "concentric" },
        { label: "接線", kind: "tangent" },
      ];
    }
    if (a.kind === "segment" && b.kind === "circle") {
      if (isArcSegmentId(a.segmentId)) return [{ label: "同心", kind: "concentric" }]; // 円弧↔円
      return [{ label: "接線", kind: "tangent" }]; // 直線↔円
    }
    if (a.kind === "circle" && b.kind === "segment") {
      if (isArcSegmentId(b.segmentId)) return [{ label: "同心", kind: "concentric" }]; // 円弧↔円
      return [{ label: "接線", kind: "tangent" }]; // 直線↔円
    }
    return [];
  }

  /** 拘束選択ポップアップで種別が選ばれたときの拘束作成。矛盾したら自動的に取り消す(既存パターンに合わせる)。 */
  function handleApplyConstraintKind(kind: "perpendicular" | "concentric" | "tangent" | "coincidentOrigin") {
    if (!constraintPopup || !selectedFeature || selectedFeature.type !== "sketch") return;
    const sketchId = selectedFeature.id;
    const { a, b } = constraintPopup;

    updateDocumentWithConflictRollback(
      sketchId,
      (doc) => {
        const feature = doc.features.find((f) => f.id === sketchId);
        if (feature?.type !== "sketch") return doc;
        const constraints = feature.constraints ?? [];
        let next = constraints;
        if (kind === "perpendicular" && a.kind === "segment" && b.kind === "segment") {
          next = addPerpendicularConstraint(constraints, a.segmentId, b.segmentId);
        } else if (kind === "concentric") {
          // Phase 42b: circleエンティティ(EntityRef)・円弧セグメント(ArcRef)のどちらの組み合わせも
          // 同じヘルパーで扱える(curveRefFromPickTarget)。
          const refA = curveRefFromPickTarget(a);
          const refB = curveRefFromPickTarget(b);
          if (refA && refB) next = addConcentricConstraint(constraints, refA, refB);
        } else if (kind === "coincidentOrigin") {
          // 原点一致(追加項目): a/bのどちらかがoriginで、もう片方が線分端点(point)またはcircle。
          const target = a.kind === "origin" ? b : a;
          const originLocal = selectedSketchPlane ? worldOriginLocal(selectedSketchPlane) : undefined;
          if (target.kind === "point") {
            next = addCoincidentOriginConstraint(constraints, target.point, originLocal);
          } else if (target.kind === "circle") {
            next = addCoincidentOriginConstraint(constraints, { entityId: target.entityId }, originLocal);
          }
        } else if (kind === "tangent") {
          if (a.kind === "circle" && b.kind === "circle") {
            next = addTangentEntityConstraint(constraints, feature.entities, a.entityId, b.entityId);
          } else if (a.kind === "circle" && b.kind === "segment") {
            next = addTangentSegmentConstraint(constraints, a.entityId, b.segmentId, feature.entities, feature.segments ?? []);
          } else if (a.kind === "segment" && b.kind === "circle") {
            next = addTangentSegmentConstraint(constraints, b.entityId, a.segmentId, feature.entities, feature.segments ?? []);
          } else if (a.kind === "segment" && b.kind === "segment") {
            // 円弧(ArcRef)↔直線のtangent(constraintOptionsForがこの組み合わせを提示するのは
            // どちらか一方が円弧・もう片方が直線のときのみ)。
            const aArc = isArcSegmentId(a.segmentId);
            next = aArc
              ? addTangentArcLineConstraint(constraints, a.segmentId, b.segmentId)
              : addTangentArcLineConstraint(constraints, b.segmentId, a.segmentId);
          }
        }
        return setSketchConstraints(doc, sketchId, next);
      },
      (message) => showTransientMessage(message, "error"),
    );
    setConstraintPopup(null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "sans-serif" }}>
      <header className="ribbon">
        {/* 第1行: アプリ名+ファイル操作+Undo/Redo+トグル+状態(常時表示、Phase 38a CommandManagerリボン化)。 */}
        <div className="ribbon-topbar">
          <h1 className="ribbon-app-name">light-3dcad</h1>

          <div className="ribbon-cluster">
            <button
              type="button"
              className="ribbon-file-btn"
              data-testid="btn-new-project"
              onClick={handleNewProject}
              title="現在の作業内容を破棄して新規プロジェクトを開始します(自動保存も消去します)"
            >
              <ToolIcon name="new" /> 新規
            </button>
            <button
              type="button"
              className="ribbon-file-btn"
              data-testid="btn-save-project"
              onClick={handleSaveProject}
              title="現在のドキュメントを.l3dcadファイルとして保存します"
            >
              <ToolIcon name="save" /> 保存
            </button>
            <button
              type="button"
              className="ribbon-file-btn"
              data-testid="btn-open-project"
              onClick={handleOpenProjectClick}
              title=".l3dcadファイルを開いてドキュメントを差し替えます(アンドゥ履歴はクリアされます)"
            >
              <ToolIcon name="open" /> 開く
            </button>
            <input
              ref={openProjectInputRef}
              data-testid="input-open-project"
              type="file"
              accept=".l3dcad,application/json"
              style={{ display: "none" }}
              onChange={handleOpenProjectFile}
            />
            <button
              type="button"
              className="ribbon-file-btn"
              data-testid="btn-copy-share-link"
              onClick={handleCopyShareLink}
              disabled={!shareLinkSupported}
              title={
                shareLinkSupported
                  ? "現在のドキュメントをURLに埋め込んだ共有リンクをコピーします(サーバー不要)"
                  : "このブラウザは共有リンク機能(CompressionStream)に対応していません"
              }
            >
              <ToolIcon name="shareLink" /> 共有リンクをコピー
            </button>
            <button
              type="button"
              className="ribbon-file-btn"
              data-testid="btn-add-part-instance"
              onClick={handleAddPartClick}
              title=".l3dcadファイルを部品として原点に配置します(簡易アセンブリ)"
            >
              <ToolIcon name="addPart" /> 部品を配置
            </button>
            <input
              ref={openPartInputRef}
              data-testid="input-add-part"
              type="file"
              accept=".l3dcad,application/json"
              style={{ display: "none" }}
              onChange={handleAddPartFile}
            />
            <button
              type="button"
              className="ribbon-file-btn"
              data-testid="btn-ai-generate"
              onClick={handleOpenAiPanel}
              title="自然言語のプロンプト(またはJSON貼り付け)からモデルを生成します"
            >
              <ToolIcon name="aiGenerate" /> AI生成
            </button>
            <a
              className="ribbon-file-btn"
              data-testid="btn-open-gallery"
              href={`${import.meta.env.BASE_URL}gallery/`}
              target="_blank"
              rel="noopener noreferrer"
              title="コミュニティが投稿したモデルのギャラリーを新しいタブで開きます"
            >
              <ToolIcon name="gallery" /> ギャラリー
            </a>
            <button
              type="button"
              className="ribbon-file-btn"
              data-testid="btn-gallery-submit"
              onClick={() => setGallerySubmitOpen(true)}
              disabled={doc.features.length === 0 || !shareLinkSupported}
              title={
                doc.features.length === 0
                  ? "モデルが空です。フィーチャーを追加してから投稿してください"
                  : shareLinkSupported
                    ? "現在のモデルをコミュニティギャラリーに投稿します(GitHubアカウントが必要です)"
                    : "このブラウザは共有リンク機能(CompressionStream)に対応していないため投稿できません"
              }
            >
              <ToolIcon name="gallerySubmit" /> ギャラリーに投稿
            </button>
            <button
              type="button"
              className="ribbon-file-btn"
              data-testid="btn-download-stl"
              onClick={handleDownloadStl}
              disabled={busy || exporting}
              title="現在のモデルをSTLファイルとしてダウンロードします"
            >
              <ToolIcon name="exportStl" /> {exporting ? "出力中…" : "STL"}
            </button>
            <button
              type="button"
              className="ribbon-file-btn"
              data-testid="btn-download-step"
              onClick={handleDownloadStep}
              disabled={busy || exporting || !hasBody}
              title="現在のモデルをSTEPファイルとしてダウンロードします"
            >
              <ToolIcon name="exportStep" /> {exporting ? "出力中…" : "STEP"}
            </button>
          </div>

          <div className="ribbon-cluster" style={{ marginLeft: "auto" }}>
            <button
              type="button"
              className="ribbon-icon-btn"
              data-testid="btn-undo"
              onClick={undo}
              disabled={!canUndo}
              title="元に戻す (Ctrl+Z)"
            >
              <ToolIcon name="undo" />
            </button>
            <button
              type="button"
              className="ribbon-icon-btn"
              data-testid="btn-redo"
              onClick={redo}
              disabled={!canRedo}
              title="やり直す (Ctrl+Shift+Z)"
            >
              <ToolIcon name="redo" />
            </button>
          </div>

          <div className="ribbon-cluster">
            <label
              className="ribbon-toggle"
              title="頂点・中心・中点・原点・グリッドへのスナップ、水平/垂直の軸ロックをまとめてON/OFFします(1mmグリッド)"
            >
              <input
                type="checkbox"
                data-testid="toggle-snap"
                checked={gridSnap}
                onChange={(e) => handleGridSnapChange(e.target.checked)}
              />
              スナップ
            </label>
            <label className="ribbon-toggle">
              <input
                type="checkbox"
                data-testid="toggle-sketch-visibility"
                checked={showSketches}
                onChange={(e) => setSketchVisibilityOverride(e.target.checked)}
              />
              スケッチ表示
            </label>
            <label className="ribbon-toggle">
              <input
                type="checkbox"
                data-testid="toggle-grid-visibility"
                checked={showGrid}
                onChange={(e) => setShowGrid(e.target.checked)}
              />
              グリッド表示
            </label>
          </div>

          <span data-testid="status-text" className="ribbon-status">
            状態: {status}
            {status === "initializing" && " (WASM初期化中…)"}
            {status === "evaluating" && " (形状計算中…)"}
          </span>
        </div>

        {/* 第2行: タブストリップ(スケッチ/フィーチャー/アセンブリ/表示)。
            ビュー操作(フィット・正対・標準ビュー)は本家SolidWorksのHeads-Up Viewツールバーと同様
            キャンバス上に浮かせたフローティングツールバー(下記<main>内、Phase 38bでリボンから
            ビューポートへ移設)としてタブに関わらず常時表示する。表示タブ自体は下のツール行にも
            同じ操作をラベル付きボタンとして並べる(タブの内容として一覧できるように)。 */}
        <div className="ribbon-tabstrip-row">
          <div className="ribbon-tabs" role="tablist">
            {RIBBON_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={ribbonTab === tab.id}
                className={`ribbon-tab${ribbonTab === tab.id ? " is-active" : ""}`}
                data-testid={`ribbon-tab-${tab.id}`}
                onClick={() => setRibbonTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* 第3行: アクティブタブのツール群。 */}
        <div className="ribbon-toolrow">
          {ribbonTab === "sketch" && (
            <>
              <div className="ribbon-group">
                <button
                  type="button"
                  className={`ribbon-tool${activeTool === "segment" ? " is-active" : ""}`}
                  data-testid="btn-draw-segment"
                  onClick={activeTool === "segment" ? handleCancelDrawing : handleStartSegmentDrawing}
                  disabled={isToolDisabled("segment")}
                  title="クリックで頂点を連結して線分・円弧のチェーンを描きます(Enter/ダブルクリックで確定、始点付近クリックで閉チェーン、Escでキャンセル)"
                >
                  <ToolIcon name="line" />
                  <span className="ribbon-tool-label">{activeTool === "segment" ? "線分キャンセル(Esc)" : "線分"}</span>
                </button>
                {activeTool === "segment" && (
                  <button
                    type="button"
                    className={`ribbon-tool-mini${arcModeActive ? " is-active" : ""}`}
                    data-testid="btn-toggle-arc-mode"
                    onClick={handleToggleArcMode}
                    title="次に描く要素を円弧(3点円弧)にします(Aキーでも切替)"
                  >
                    <ToolIcon name="arc" size={16} /> {arcModeActive ? "円弧モード中(A)" : "円弧(A)"}
                  </button>
                )}
                <button
                  type="button"
                  className={`ribbon-tool${activeTool === "rect" ? " is-active" : ""}`}
                  data-testid="btn-draw-rect"
                  onClick={activeTool === "rect" ? handleCancelDrawing : handleStartRectDrawing}
                  disabled={isToolDisabled("rect")}
                  title="2クリックで矩形を描きます(1点目=コーナー、2点目=対角コーナー。Escでキャンセル)"
                >
                  <ToolIcon name="rect" />
                  <span className="ribbon-tool-label">{activeTool === "rect" ? "矩形キャンセル(Esc)" : "矩形"}</span>
                </button>
                <button
                  type="button"
                  className={`ribbon-tool${activeTool === "circle" ? " is-active" : ""}`}
                  data-testid="btn-draw-circle"
                  onClick={activeTool === "circle" ? handleCancelDrawing : handleStartCircleDrawing}
                  disabled={isToolDisabled("circle")}
                  title="2クリックで円を描きます(1点目=中心、2点目=円周上の点。Escでキャンセル)"
                >
                  <ToolIcon name="circle" />
                  <span className="ribbon-tool-label">{activeTool === "circle" ? "円キャンセル(Esc)" : "円"}</span>
                </button>
                <button
                  type="button"
                  className={`ribbon-tool${activeTool === "point" ? " is-active" : ""}`}
                  data-testid="btn-draw-point"
                  onClick={activeTool === "point" ? handleCancelDrawing : handleStartPointDrawing}
                  disabled={isToolDisabled("point")}
                  title="クリックで点を1つ置きます(位置決め専用のマーカー。Escでキャンセル)"
                >
                  <ToolIcon name="point" />
                  <span className="ribbon-tool-label">{activeTool === "point" ? "点キャンセル(Esc)" : "点"}</span>
                </button>
                <button
                  type="button"
                  className={`ribbon-tool${activeTool === "slot" ? " is-active" : ""}`}
                  data-testid="btn-draw-slot"
                  onClick={activeTool === "slot" ? handleCancelDrawing : handleStartSlotDrawing}
                  disabled={isToolDisabled("slot")}
                  title="3クリックでスロット(長円)を描きます(始点→終点→幅。Escでキャンセル)"
                >
                  <ToolIcon name="slot" />
                  <span className="ribbon-tool-label">{activeTool === "slot" ? "スロットキャンセル(Esc)" : "スロット"}</span>
                </button>
                <button
                  type="button"
                  className={`ribbon-tool${activeTool === "regularPolygon" ? " is-active" : ""}`}
                  data-testid="btn-draw-polygon"
                  onClick={activeTool === "regularPolygon" ? handleCancelDrawing : handleStartRegularPolygonDrawing}
                  disabled={isToolDisabled("regularPolygon")}
                  title="2クリックで正多角形を描きます(中心→頂点。辺数は右のセレクタ。Escでキャンセル)"
                >
                  <ToolIcon name="polygon" />
                  <span className="ribbon-tool-label">{activeTool === "regularPolygon" ? "多角形キャンセル(Esc)" : "多角形"}</span>
                </button>
                <select
                  data-testid="polygon-sides-select"
                  className="ribbon-plane-select"
                  value={polygonSides}
                  disabled={activeTool === "regularPolygon"}
                  onChange={(e) => setPolygonSides(Number(e.target.value))}
                  title="多角形の辺数"
                >
                  {[3, 4, 5, 6, 8].map((n) => (
                    <option key={n} value={n}>
                      {n}辺
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={`ribbon-tool${extendTool ? " is-active" : ""}`}
                  data-testid="btn-extend"
                  onClick={extendTool ? handleCancelExtendTool : handleStartExtendTool}
                  disabled={isExtendToolDisabled()}
                  title="線分の近い側の端点をホバーし、最初に交わる相手まで延長します(緑色プレビューが延長区間、Escで終了)"
                >
                  <ToolIcon name="extend" />
                  <span className="ribbon-tool-label">{extendTool ? "延長キャンセル(Esc)" : "延長"}</span>
                </button>
              </div>

              <div className="ribbon-group">
                <button
                  type="button"
                  className={`ribbon-tool${cornerTool === "fillet" ? " is-active" : ""}`}
                  data-testid="btn-corner-fillet"
                  onClick={cornerTool === "fillet" ? handleCancelCornerTool : () => handleStartCornerTool("fillet")}
                  disabled={isCornerToolDisabled("fillet")}
                  title="頂点付近をクリックしてフィレット(丸め)を適用します(適用済みをクリックで解除、Escで終了)"
                >
                  <ToolIcon name="fillet" />
                  <span className="ribbon-tool-label">{cornerTool === "fillet" ? "フィレットキャンセル(Esc)" : "フィレット"}</span>
                </button>
                <button
                  type="button"
                  className={`ribbon-tool${cornerTool === "chamfer" ? " is-active" : ""}`}
                  data-testid="btn-corner-chamfer"
                  onClick={cornerTool === "chamfer" ? handleCancelCornerTool : () => handleStartCornerTool("chamfer")}
                  disabled={isCornerToolDisabled("chamfer")}
                  title="頂点付近をクリックして面取りを適用します(適用済みをクリックで解除、Escで終了)"
                >
                  <ToolIcon name="chamfer" />
                  <span className="ribbon-tool-label">{cornerTool === "chamfer" ? "面取りキャンセル(Esc)" : "面取り"}</span>
                </button>
                {cornerTool && (
                  <label className="ribbon-mini-form" title="頂点クリックで適用するサイズ(mm)">
                    <input
                      type="number"
                      data-testid="corner-tool-size"
                      value={cornerSize}
                      min={0.1}
                      step="any"
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v) && v > 0) setCornerSize(v);
                      }}
                    />
                    mm
                  </label>
                )}
                <button
                  type="button"
                  className={`ribbon-tool${trimTool ? " is-active" : ""}`}
                  data-testid="btn-trim"
                  onClick={trimTool ? handleCancelTrimTool : handleStartTrimTool}
                  disabled={isTrimToolDisabled()}
                  title="スケッチ要素の区間をクリックして削除します(赤色プレビューが削除対象、Escで終了)"
                >
                  <ToolIcon name="trim" />
                  <span className="ribbon-tool-label">{trimTool ? "トリムキャンセル(Esc)" : "トリム"}</span>
                </button>
              </div>

              <div className="ribbon-group">
                <button
                  type="button"
                  className={`ribbon-tool${dimensionTool ? " is-active" : ""}`}
                  data-testid="btn-dimension"
                  onClick={dimensionTool ? handleCancelDimensionTool : handleStartDimensionTool}
                  disabled={isDimensionToolDisabled()}
                  title="クリックで長さ/半径/距離の拘束を作成・編集します(Escで終了)"
                >
                  <ToolIcon name="dimension" />
                  <span className="ribbon-tool-label">{dimensionTool ? "寸法キャンセル(Esc)" : "寸法"}</span>
                </button>
                <button
                  type="button"
                  className={`ribbon-tool${constraintTool ? " is-active" : ""}`}
                  data-testid="btn-constraint"
                  onClick={constraintTool ? handleCancelConstraintTool : handleStartConstraintTool}
                  disabled={isConstraintToolDisabled()}
                  title="線分/円弧/円を2つ順にクリックして垂直・同心・接線の拘束を作成します(Escで終了)"
                >
                  <ToolIcon name="constraint" />
                  <span className="ribbon-tool-label">{constraintTool ? "拘束キャンセル(Esc)" : "拘束"}</span>
                </button>
              </div>

              {/* スケッチ編集中でも押し出し・回転体を直接実行できるようにする(フィーチャータブと
                  同じボタン・ハンドラを再掲。SolidWorksの「スケッチ終了」に相当する、
                  スケッチ→フィーチャー化への自然な導線として右端に独立表示する)。 */}
              <div className="ribbon-group ribbon-group-push">
                <button
                  type="button"
                  className="ribbon-tool"
                  data-testid="btn-add-extrude"
                  onClick={handleAddExtrude}
                  disabled={sketches.length === 0}
                  title="選択中(なければ最後)のスケッチを押し出します"
                >
                  <ToolIcon name="extrude" />
                  <span className="ribbon-tool-label">押し出し</span>
                </button>
                <button
                  type="button"
                  className="ribbon-tool"
                  data-testid="btn-add-revolve"
                  onClick={handleAddRevolve}
                  disabled={sketches.length === 0}
                  title="選択中(なければ最後)のスケッチをスケッチ原点を通るX/Y軸周りに回転させます"
                >
                  <ToolIcon name="revolve" />
                  <span className="ribbon-tool-label">回転体</span>
                </button>
              </div>

              {/* スケッチ終了(ユーザー報告対応、Phase 38c): スケッチの選択を解除し、フィーチャーツリー
                  のみの状態へ明示的に戻るボタン。SketchEditorパネルヘッダの同名ボタンと同じ動作
                  (selectFeature(null))で、リボンは既存の自動タブ切替ロジックにより「フィーチャー」
                  タブへ自動的に戻る。 */}
              <div className="ribbon-group">
                <button
                  type="button"
                  className="ribbon-tool"
                  data-testid="btn-exit-sketch"
                  onClick={() => selectFeature(null)}
                  title="スケッチの選択を解除してフィーチャーツリーに戻ります"
                  style={{ color: "var(--cad-accent, #4a90d9)" }}
                >
                  <ToolIcon name="sketchExit" />
                  <span className="ribbon-tool-label">スケッチ終了</span>
                </button>
              </div>
            </>
          )}

          {ribbonTab === "feature" && (
            <>
              <div className="ribbon-group">
                <select
                  data-testid="new-sketch-plane-select"
                  className="ribbon-plane-select"
                  value={newSketchPlane}
                  onChange={(e) => setNewSketchPlane(e.target.value as "XY" | "XZ" | "YZ")}
                  title="新規スケッチを作成する基準平面(基準平面クリックと同等)"
                >
                  <option value="XY">XY</option>
                  <option value="XZ">XZ</option>
                  <option value="YZ">YZ</option>
                </select>
                <button type="button" className="ribbon-tool" data-testid="btn-add-sketch" onClick={() => addSketch(newSketchPlane)}>
                  <ToolIcon name="sketchStart" />
                  <span className="ribbon-tool-label">スケッチ</span>
                </button>
                <button
                  type="button"
                  className="ribbon-tool"
                  data-testid="btn-add-face-sketch"
                  onClick={addFaceSketch}
                  disabled={!selectedFace?.isPlanar}
                  title="選択中の平面上にスケッチを追加します"
                >
                  <ToolIcon name="faceSketch" />
                  <span className="ribbon-tool-label">面にスケッチ</span>
                </button>
                <button
                  type="button"
                  className="ribbon-tool"
                  data-testid="btn-add-extrude"
                  onClick={handleAddExtrude}
                  disabled={sketches.length === 0}
                  title="選択中(なければ最後)のスケッチを押し出します"
                >
                  <ToolIcon name="extrude" />
                  <span className="ribbon-tool-label">押し出し</span>
                </button>
                <button
                  type="button"
                  className="ribbon-tool"
                  data-testid="btn-add-revolve"
                  onClick={handleAddRevolve}
                  disabled={sketches.length === 0}
                  title="選択中(なければ最後)のスケッチをスケッチ原点を通るX/Y軸周りに回転させます"
                >
                  <ToolIcon name="revolve" />
                  <span className="ribbon-tool-label">回転体</span>
                </button>
              </div>

              <div className="ribbon-group">
                <button
                  type="button"
                  className={`ribbon-tool${edgeTool === "fillet" ? " is-active" : ""}`}
                  data-testid="btn-edge-fillet"
                  onClick={edgeTool === "fillet" ? handleCancelEdgeTool : () => handleStartEdgeTool("fillet")}
                  disabled={isEdgeToolDisabled("fillet")}
                  title="ボディのエッジをクリックして選択し、3Dフィレット(丸め)を適用します(Escで終了)"
                >
                  <ToolIcon name="fillet3d" />
                  <span className="ribbon-tool-label">{edgeTool === "fillet" ? "3Dフィレットキャンセル(Esc)" : "3Dフィレット"}</span>
                </button>
                <button
                  type="button"
                  className={`ribbon-tool${edgeTool === "chamfer" ? " is-active" : ""}`}
                  data-testid="btn-edge-chamfer"
                  onClick={edgeTool === "chamfer" ? handleCancelEdgeTool : () => handleStartEdgeTool("chamfer")}
                  disabled={isEdgeToolDisabled("chamfer")}
                  title="ボディのエッジをクリックして選択し、3D面取りを適用します(Escで終了)"
                >
                  <ToolIcon name="chamfer3d" />
                  <span className="ribbon-tool-label">{edgeTool === "chamfer" ? "3D面取りキャンセル(Esc)" : "3D面取り"}</span>
                </button>
                {edgeTool && (
                  <>
                    <label className="ribbon-mini-form" title="適用するサイズ(mm)">
                      <input
                        type="number"
                        data-testid="edge-tool-size"
                        value={edgeToolSize}
                        min={0.1}
                        step="any"
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v) && v > 0) setEdgeToolSize(v);
                        }}
                      />
                      mm
                    </label>
                    <button
                      type="button"
                      data-testid="btn-edge-tool-apply"
                      onClick={handleApplyEdgeTool}
                      disabled={edgeSelection.length === 0}
                      title="選択したエッジにフィレット/面取りを適用してフィーチャーを追加します"
                    >
                      適用({edgeSelection.length})
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className={`ribbon-tool${shellTool ? " is-active" : ""}`}
                  data-testid="btn-shell"
                  onClick={shellTool ? handleCancelShellTool : handleStartShellTool}
                  disabled={isShellToolDisabled()}
                  title="ボディの面をクリックして選択し(複数可)、シェル(中抜き)を適用します(Escで終了)"
                >
                  <ToolIcon name="shell" />
                  <span className="ribbon-tool-label">{shellTool ? "シェルキャンセル(Esc)" : "シェル"}</span>
                </button>
                {shellTool && (
                  <>
                    <label className="ribbon-mini-form" title="適用する肉厚(mm)">
                      <input
                        type="number"
                        data-testid="shell-tool-thickness"
                        value={shellToolThickness}
                        min={0.1}
                        step="any"
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v) && v > 0) setShellToolThickness(v);
                        }}
                      />
                      mm
                    </label>
                    <button
                      type="button"
                      data-testid="btn-shell-tool-apply"
                      onClick={handleApplyShellTool}
                      disabled={shellSelection.length === 0}
                      title="選択した面を開口してシェルフィーチャーを追加します"
                    >
                      適用({shellSelection.length})
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className={`ribbon-tool${threadTool ? " is-active" : ""}`}
                  data-testid="btn-thread"
                  onClick={threadTool ? handleCancelThreadTool : handleStartThreadTool}
                  disabled={isThreadToolDisabled()}
                  title="プリセット・雄/雌・長さを選び、平面をクリックしてねじフィーチャーを配置します(Escで終了)"
                >
                  <ToolIcon name="thread" />
                  <span className="ribbon-tool-label">{threadTool ? "ねじキャンセル(Esc)" : "ねじ"}</span>
                </button>
                {threadTool && (
                  <>
                    <select
                      data-testid="thread-tool-preset"
                      className="ribbon-plane-select"
                      value={threadPreset}
                      onChange={(e) => setThreadPreset(e.target.value as ThreadPreset)}
                      title="呼び径"
                    >
                      {THREAD_PRESET_LIST.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                    <label className="ribbon-mini-form">
                      <input
                        type="radio"
                        name="thread-tool-hand"
                        data-testid="thread-tool-hand-male"
                        checked={threadHand === "male"}
                        onChange={() => setThreadHand("male")}
                      />
                      雄
                    </label>
                    <label className="ribbon-mini-form">
                      <input
                        type="radio"
                        name="thread-tool-hand"
                        data-testid="thread-tool-hand-female"
                        checked={threadHand === "female"}
                        onChange={() => setThreadHand("female")}
                      />
                      雌
                    </label>
                    <label className="ribbon-mini-form" title="長さ(mm)">
                      <input
                        type="number"
                        data-testid="thread-tool-length"
                        value={threadLength}
                        min={0.1}
                        step="any"
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (!Number.isFinite(v) || v <= 0) return;
                          setThreadLength(v);
                        }}
                      />
                      mm
                    </label>
                    <span style={{ fontSize: 11, color: "var(--cad-text-muted)" }}>平面をクリックして配置</span>
                  </>
                )}
              </div>
            </>
          )}

          {ribbonTab === "assembly" && (
            <div className="ribbon-group">
              <button
                type="button"
                className="ribbon-tool"
                data-testid="ribbon-assembly-add-part"
                onClick={handleAddPartClick}
                title=".l3dcadファイルを部品として原点に配置します(簡易アセンブリ)"
              >
                <ToolIcon name="addPart" />
                <span className="ribbon-tool-label">部品を配置</span>
              </button>
              <button
                type="button"
                className={`ribbon-tool${partDragTool ? " is-active" : ""}`}
                data-testid="btn-part-drag"
                onClick={partDragTool ? handleCancelPartDragTool : handleStartPartDragTool}
                disabled={isPartDragToolDisabled()}
                title="部品のボディをドラッグして位置を動かします(Shift+ドラッグで上下、Escで終了)"
              >
                <ToolIcon name="partDrag" />
                <span className="ribbon-tool-label">{partDragTool ? "部品移動キャンセル(Esc)" : "部品移動"}</span>
              </button>
              <button
                type="button"
                className={`ribbon-tool${mateTool ? " is-active" : ""}`}
                data-testid="btn-mate"
                onClick={mateTool ? handleCancelMateTool : handleStartMateTool}
                disabled={isMateToolDisabled()}
                title="面(平面/円筒面)を2つ順にクリックして合致(一致/距離/同軸)を作成します(Escで終了)"
              >
                <ToolIcon name="mate" />
                <span className="ribbon-tool-label">{mateTool ? "合致キャンセル(Esc)" : "合致"}</span>
              </button>
              <button
                type="button"
                className="ribbon-tool"
                data-testid="btn-check-interference"
                onClick={handleCheckInterference}
                disabled={isInterferenceCheckDisabled() || interferenceChecking}
                title="全ボディ(部品配置を含む)をペアごとに交差判定し、干渉(重なり)があれば一覧と赤ハイライトで表示します"
              >
                <ToolIcon name="interference" />
                <span className="ribbon-tool-label">{interferenceChecking ? "干渉チェック中…" : "干渉チェック"}</span>
              </button>
              {interferenceResult && (
                <button
                  type="button"
                  data-testid="btn-clear-interference"
                  onClick={clearInterference}
                  title="干渉チェックの結果(赤ハイライト・一覧)を消去します"
                >
                  クリア
                </button>
              )}
            </div>
          )}

          {ribbonTab === "view" && (
            <div className="ribbon-group">
              <button
                type="button"
                className="ribbon-tool"
                data-testid="ribbon-view-fit"
                onClick={() => viewerRef.current?.fitToView()}
                title="モデル全体が画面に収まるようにカメラを調整します"
              >
                <ToolIcon name="fit" />
                <span className="ribbon-tool-label">フィット</span>
              </button>
              <button
                type="button"
                className="ribbon-tool"
                data-testid="ribbon-view-normal-to"
                onClick={handleAlignToPlane}
                disabled={!selectedSketchPlane}
                title="選択中スケッチの平面に正対する視点へカメラを移動します"
              >
                <ToolIcon name="normalTo" />
                <span className="ribbon-tool-label">正対</span>
              </button>
              {STANDARD_VIEW_BUTTONS.map(({ view, label, title, icon }) => (
                <button
                  key={view}
                  type="button"
                  className="ribbon-tool"
                  data-testid={`ribbon-view-${view}`}
                  onClick={() => viewerRef.current?.setStandardView(view)}
                  title={title}
                >
                  <ToolIcon name={icon} />
                  <span className="ribbon-tool-label">{label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 第4行: ツール実行中のヒント(既存仕様を維持)。 */}
        <div className="ribbon-hintrow">
          {activeTool && (
            <span data-testid="drawing-shift-hint" style={{ opacity: 0.75 }}>
              Shift押下中はスナップ・軸ロックを一時無効化
            </span>
          )}
          {cornerTool && (
            <span data-testid="corner-tool-hint" style={{ opacity: 0.75 }}>
              頂点付近をクリックして適用/解除
            </span>
          )}
          {trimTool && (
            <span data-testid="trim-tool-hint" style={{ opacity: 0.75 }}>
              削除したい区間をクリック
            </span>
          )}
          {extendTool && (
            <span data-testid="extend-tool-hint" style={{ opacity: 0.75 }}>
              延長したい線分の端点付近をクリック(緑色プレビューが延長区間)
            </span>
          )}
          {dimensionTool && (
            <span data-testid="dimension-tool-hint" style={{ opacity: 0.75 }}>
              クリックで長さ/半径/距離を指定
            </span>
          )}
          {dimensionTool && dimensionPendingLabel && (
            <span data-testid="dimension-pending-status" style={{ fontWeight: "bold", color: "var(--cad-warning)" }}>
              {dimensionPendingLabel}
            </span>
          )}
          {constraintTool && (
            <span data-testid="constraint-tool-hint" style={{ opacity: 0.75 }}>
              線分/円弧/円をクリックして垂直・同心・接線を指定
            </span>
          )}
          {constraintTool && constraintPendingLabel && (
            <span data-testid="constraint-pending-status" style={{ fontWeight: "bold", color: "var(--cad-warning)" }}>
              {constraintPendingLabel}
            </span>
          )}
          {edgeTool && (
            <span data-testid="edge-tool-hint" style={{ opacity: 0.75 }}>
              エッジをクリックして選択(複数可)、サイズを入力して「適用」
            </span>
          )}
          {mateTool && (
            <span data-testid="mate-tool-hint" style={{ opacity: 0.75 }}>
              面(平面/円筒面)をクリックして一致・距離・同軸を指定
            </span>
          )}
          {mateTool && matePendingLabel && (
            <span data-testid="mate-pending-status" style={{ fontWeight: "bold", color: "var(--cad-warning)" }}>
              {matePendingLabel}
            </span>
          )}
        </div>
      </header>

      {kernelCrashed && (
        <div
          data-testid="kernel-crashed-banner"
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 12px",
            background: "rgba(255,107,107,0.15)",
            borderBottom: "1px solid #ff6b6b",
            fontSize: 13,
          }}
        >
          <strong style={{ color: "#ff6b6b" }}>CADカーネルが応答しません</strong>
          <span style={{ opacity: 0.8 }}>
            形状計算のバックグラウンド処理が停止しました。ドキュメントの編集(削除・アンドゥ等)は
            引き続き行えますが、再評価にはカーネルの再起動が必要です。
          </span>
          <button type="button" data-testid="btn-restart-kernel" onClick={restartKernel} style={{ marginLeft: "auto" }}>
            カーネル再起動
          </button>
        </div>
      )}
      {autosaveRestoreSkipped && (
        <div
          data-testid="autosave-restore-skipped-banner"
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 12px",
            background: "rgba(255,183,77,0.15)",
            borderBottom: "1px solid #ffb74d",
            fontSize: 13,
          }}
        >
          <span>前回の自動保存の読み込みに失敗したため初期状態で起動しました(自動保存は保持されています)。</span>
          <button
            type="button"
            data-testid="btn-retry-autosave-restore"
            onClick={handleRetryAutosaveRestore}
            style={{ marginLeft: "auto" }}
          >
            再試行
          </button>
        </div>
      )}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <aside
          style={{
            width: 320,
            padding: 16,
            borderRight: "1px solid var(--cad-border)",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            overflowY: "auto",
          }}
        >
          <FeatureTree
            doc={doc}
            selectedFeatureId={selectedFeatureId}
            errorFeatureId={errorFeatureId}
            onSelect={selectFeature}
            onDelete={handleDelete}
            onSetRollback={setRollbackIndex}
            onRename={(featureId, name) => updateDocument((d) => renameFeature(d, featureId, name))}
          />

          {selectedFace && (
            <div
              data-testid="selected-face-panel"
              style={{
                borderTop: "1px solid var(--cad-border)",
                paddingTop: 12,
                fontSize: 12,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <strong>選択中の面</strong>
              <span data-testid="selected-face-center">
                中心: {selectedFace.center.map((v) => v.toFixed(2)).join(", ")}
              </span>
              <span data-testid="selected-face-normal">
                法線: {selectedFace.normal.map((v) => v.toFixed(2)).join(", ")}
              </span>
              {!selectedFace.isPlanar && (
                <span style={{ color: "#ff6b6b" }}>
                  この面は平面ではないため、スケッチ平面にできません。
                </span>
              )}
            </div>
          )}

          {interferenceResult && interferenceResult.pairs.length > 0 && (
            <div
              data-testid="interference-panel"
              style={{
                borderTop: "1px solid var(--cad-border)",
                paddingTop: 12,
                fontSize: 12,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <strong style={{ color: "#ff6b6b" }}>干渉あり({interferenceResult.pairs.length}件)</strong>
              <ul style={{ margin: 0, paddingLeft: 16, display: "flex", flexDirection: "column", gap: 2 }}>
                {interferenceResult.pairs.map((pair, i) => (
                  <li key={`${pair.aFeatureId}-${pair.bFeatureId}-${i}`} data-testid="interference-pair">
                    {pair.aName} ↔ {pair.bName}: {pair.volume.toFixed(1)}mm³
                  </li>
                ))}
              </ul>
            </div>
          )}
          {interferenceError && (
            <p
              data-testid="interference-error"
              role="alert"
              style={{ color: "#ff6b6b", fontSize: 12, whiteSpace: "pre-wrap", margin: 0 }}
            >
              干渉チェックエラー: {interferenceError}
            </p>
          )}

          {errorMessage && !kernelCrashed && (
            <p
              data-testid="eval-error"
              role="alert"
              style={{ color: "#ff6b6b", fontSize: 12, whiteSpace: "pre-wrap", margin: 0 }}
            >
              評価エラー: {errorMessage}
            </p>
          )}
          {exportError && (
            <p
              data-testid="export-error"
              role="alert"
              style={{ color: "#ff6b6b", fontSize: 12, whiteSpace: "pre-wrap", margin: 0 }}
            >
              出力エラー: {exportError}
            </p>
          )}
          {openProjectError && (
            <p
              data-testid="open-project-error"
              role="alert"
              style={{ color: "#ff6b6b", fontSize: 12, whiteSpace: "pre-wrap", margin: 0 }}
            >
              プロジェクトを開けませんでした: {openProjectError}
            </p>
          )}
          {openPartError && (
            <p
              data-testid="open-part-error"
              role="alert"
              style={{ color: "#ff6b6b", fontSize: 12, whiteSpace: "pre-wrap", margin: 0 }}
            >
              部品を配置できませんでした: {openPartError}
            </p>
          )}

          {selectedFeature && (
            <div style={{ borderTop: "1px solid var(--cad-border)", paddingTop: 12 }}>
              {selectedFeature.type === "sketch" && (
                <SketchEditor
                  sketch={selectedFeature}
                  onNotice={showTransientMessage}
                  diagnostics={selectedSketchDiagnostics}
                  onExitSketch={() => selectFeature(null)}
                />
              )}
              {selectedFeature.type === "extrude" && <ExtrudeEditor extrude={selectedFeature} doc={doc} />}
              {selectedFeature.type === "fillet3d" && (
                <Fillet3DEditor
                  fillet={selectedFeature}
                  hasError={errorFeatureId === selectedFeature.id}
                  isReselecting={edgeReselectTargetId === selectedFeature.id}
                  reselectCount={edgeSelection.length}
                  onStartReselect={() => handleStartEdgeReselect(selectedFeature)}
                  onApplyReselect={handleApplyEdgeReselect}
                  onCancelReselect={handleCancelEdgeReselect}
                />
              )}
              {selectedFeature.type === "shell" && (
                <ShellEditor
                  shell={selectedFeature}
                  hasError={errorFeatureId === selectedFeature.id}
                  isReselecting={shellReselectTargetId === selectedFeature.id}
                  reselectCount={shellSelection.length}
                  onStartReselect={() => handleStartShellReselect(selectedFeature)}
                  onApplyReselect={handleApplyShellReselect}
                  onCancelReselect={handleCancelShellReselect}
                />
              )}
              {selectedFeature.type === "revolve" && <RevolveEditor revolve={selectedFeature} doc={doc} />}
              {selectedFeature.type === "thread" && (
                <ThreadEditor
                  thread={selectedFeature}
                  doc={doc}
                  hasError={errorFeatureId === selectedFeature.id}
                  isReselecting={threadReselectTargetId === selectedFeature.id}
                  onStartReselect={() => handleStartThreadReselect(selectedFeature)}
                  onCancelReselect={handleCancelThreadReselect}
                  onEditPlacementSketch={() => handleEditThreadPlacementSketch(selectedFeature)}
                />
              )}
              {selectedFeature.type === "partInstance" && <PartInstanceEditor instance={selectedFeature} />}
              {selectedFeature.type === "mate" && (
                <MateEditor
                  mate={selectedFeature}
                  doc={doc}
                  hasError={errorFeatureId === selectedFeature.id}
                  isReselecting={mateReselectTargetId === selectedFeature.id}
                  reselectPendingLabel={mateReselectTargetId === selectedFeature.id ? matePendingLabel : null}
                  onStartReselect={() => handleStartMateReselect(selectedFeature)}
                  onCancelReselect={handleCancelMateReselect}
                />
              )}
            </div>
          )}

          <p style={{ fontSize: 11, opacity: 0.6, marginTop: "auto" }}>
            フィーチャーをクリックすると編集パネルが表示されます。値を変更すると自動的に再評価されます。
          </p>
        </aside>

        <main style={{ flex: 1, position: "relative" }}>
          <div ref={viewerContainerRef} data-testid="viewer-container" style={{ width: "100%", height: "100%" }} />
          {/* ヘッズアップビュークラスタ(Phase 38b): SolidWorks同様、キャンバス上部中央に浮かべる
              半透明ツールバー。ボタン・testid・ハンドラは旧リボン第2行のものをそのまま移設した
              (バーの外側はpointer-eventsを持たずスケッチクリックの邪魔をしない)。
              Phase 43: 標準ビューボタンを横一列から、SolidWorks風の十字(ビューパッド)配置に変更。
              正面を中心に上下左右、等角(右上)・背面(左上)を角に置く3x3グリッド
              (viewport-headsup-pad、CSSのgrid-template-areasでview種別ごとに配置)。
              フィット・正対はパッドの左に縦並びの小さな列として添える(viewport-headsup-side)。
              data-testid・onClick・disabled等の挙動は変更していない(レイアウト/CSSのみの変更)。 */}
          <div className="viewport-headsup">
            <div className="viewport-headsup-side">
              <button
                type="button"
                className="ribbon-icon-btn"
                data-testid="btn-fit-view"
                onClick={() => viewerRef.current?.fitToView()}
                title="フィット: モデル全体が画面に収まるようにカメラを調整します"
              >
                <ToolIcon name="fit" size={17} />
              </button>
              <button
                type="button"
                className="ribbon-icon-btn"
                data-testid="btn-align-to-plane"
                onClick={handleAlignToPlane}
                disabled={!selectedSketchPlane}
                title="正対: 選択中スケッチの平面に正対する視点へカメラを移動します"
              >
                <ToolIcon name="normalTo" size={17} />
              </button>
            </div>
            <div className="viewport-headsup-pad">
              {STANDARD_VIEW_BUTTONS.map(({ view, label, title, icon }) => (
                <button
                  key={view}
                  type="button"
                  className={`ribbon-icon-btn viewport-pad-btn viewport-pad-btn-${view}`}
                  data-testid={`btn-view-${view}`}
                  onClick={() => viewerRef.current?.setStandardView(view)}
                  title={`${label}: ${title}`}
                >
                  <ToolIcon name={icon} size={17} />
                </button>
              ))}
            </div>
          </div>
          {selectedFeature?.type === "sketch" && selectedSketchPlane && (
            <DimensionOverlay
              sketch={selectedFeature}
              basis={selectedSketchPlane}
              viewerRef={viewerRef}
              // 寸法ツール中(dimensionTool)は既存の寸法線・ラベルを隠さない(むしろ見えているべき、
              // UI改善対応)。線分/矩形/円等の作図ツール・フィレット/面取り・トリム・延長の間は従来通り隠す。
              visible={showSketches && !activeTool && !cornerTool && !trimTool && !extendTool && !constraintTool && !edgeTool}
              onConflictRollback={(message) => showTransientMessage(message, "error")}
            />
          )}
          {dimensionPopup && (
            <DimensionToolPopup
              key={JSON.stringify(dimensionPopup.target)}
              titleLabel={dimensionPopup.titleLabel}
              initialValue={dimensionPopup.initialValue}
              screen={dimensionPopup.screen}
              hintLabel={dimensionPopup.hintLabel}
              axisOptions={dimensionPopup.axisOptions}
              allowZero={dimensionPopup.allowZero}
              quantityOptions={dimensionPopup.quantityOptions}
              onCancel={() => setDimensionPopup(null)}
              onApply={handleApplyDimensionTarget}
            />
          )}
          {constraintPopup && (
            <div
              data-testid="constraint-tool-popup"
              style={{
                position: "absolute",
                left: constraintPopup.screen.x,
                top: constraintPopup.screen.y,
                transform: "translate(-50%, 10px)",
                pointerEvents: "auto",
                background: "#2a2f3a",
                border: "1px solid #555",
                borderRadius: 6,
                padding: 8,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                fontSize: 12,
                zIndex: 20,
                boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
                minWidth: 140,
              }}
            >
              <p style={{ margin: 0, fontSize: 10, color: "#9aa5b1" }}>適用する拘束を選択</p>
              {constraintOptionsFor(constraintPopup.a, constraintPopup.b).map((opt) => (
                <button
                  key={opt.kind}
                  type="button"
                  data-testid={`constraint-tool-popup-${opt.kind}`}
                  onClick={() => handleApplyConstraintKind(opt.kind)}
                  style={{ fontSize: 12 }}
                >
                  {opt.label}
                </button>
              ))}
              <button
                type="button"
                data-testid="constraint-tool-popup-cancel"
                onClick={() => setConstraintPopup(null)}
                style={{ fontSize: 11 }}
              >
                キャンセル
              </button>
            </div>
          )}
          {matePopup && (
            <div
              data-testid="mate-tool-popup"
              style={{
                position: "absolute",
                left: matePopup.screen.x,
                top: matePopup.screen.y,
                transform: "translate(-50%, 10px)",
                pointerEvents: "auto",
                background: "#2a2f3a",
                border: "1px solid #555",
                borderRadius: 6,
                padding: 8,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                fontSize: 12,
                zIndex: 20,
                boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
                minWidth: 160,
              }}
            >
              <p style={{ margin: 0, fontSize: 10, color: "#9aa5b1" }}>適用する合致を選択</p>
              {mateOptionsFor(matePopup.a, matePopup.b).length === 0 && (
                <p data-testid="mate-tool-popup-incompatible" style={{ margin: 0, fontSize: 11, color: "#ff6b6b" }}>
                  この組み合わせの面には合致を適用できません(平面同士または円筒面同士を選んでください)
                </p>
              )}
              {mateOptionsFor(matePopup.a, matePopup.b).map((opt) =>
                opt.kind === "distance" ? (
                  <div key={opt.kind} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <input
                      type="number"
                      data-testid="mate-tool-popup-distance-value"
                      value={mateDistanceValue}
                      min={0.001}
                      step="any"
                      style={{ width: 56 }}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v) && v > 0) setMateDistanceValue(v);
                      }}
                    />
                    <button
                      type="button"
                      data-testid="mate-tool-popup-distance"
                      onClick={() => handleApplyMateKind(opt.kind)}
                      style={{ fontSize: 12 }}
                    >
                      {opt.label}
                    </button>
                  </div>
                ) : (
                  <button
                    key={opt.kind}
                    type="button"
                    data-testid={`mate-tool-popup-${opt.kind}`}
                    onClick={() => handleApplyMateKind(opt.kind)}
                    style={{ fontSize: 12 }}
                  >
                    {opt.label}
                  </button>
                ),
              )}
              <button
                type="button"
                data-testid="mate-tool-popup-cancel"
                onClick={() => setMatePopup(null)}
                style={{ fontSize: 11 }}
              >
                キャンセル
              </button>
            </div>
          )}
          {transientMessage && (
            <div
              data-testid="constraint-conflict-toast"
              role="status"
              style={{
                position: "absolute",
                top: 12,
                left: "50%",
                transform: "translateX(-50%)",
                padding: "6px 14px",
                borderRadius: 4,
                background:
                  transientMessage.variant === "success"
                    ? "rgba(26, 127, 55, 0.92)"
                    : transientMessage.variant === "error"
                      ? "rgba(211, 47, 47, 0.92)"
                      : "rgba(38, 42, 51, 0.92)",
                color: "#fff",
                fontSize: 12,
                pointerEvents: "none",
                zIndex: 30,
              }}
            >
              {transientMessage.text}
            </div>
          )}
          {showInitOverlay && (
            <div
              data-testid="init-overlay"
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                background: "rgba(34, 38, 48, 0.85)",
                color: "#fff",
                fontSize: 14,
                pointerEvents: "none",
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  border: "3px solid rgba(255,255,255,0.25)",
                  borderTopColor: "#5b8def",
                  animation: "cad-spin 0.8s linear infinite",
                }}
              />
              <span>CADカーネルを初期化中…(初回は数秒〜数十秒かかります)</span>
            </div>
          )}
          {!showInitOverlay && status === "evaluating" && (
            <div
              data-testid="evaluating-overlay"
              style={{
                position: "absolute",
                top: 12,
                right: 12,
                padding: "6px 12px",
                borderRadius: 4,
                background: "rgba(91, 141, 239, 0.9)",
                color: "#fff",
                fontSize: 12,
                pointerEvents: "none",
              }}
            >
              形状を再計算中…
            </div>
          )}
        </main>
      </div>
      {aiPanelOpen && (
        <Suspense fallback={null}>
          <AiGeneratePanel onClose={() => setAiPanelOpen(false)} onLoad={handleLoadAiGeneratedDocument} />
        </Suspense>
      )}
      {gallerySubmitOpen && (
        <Suspense fallback={null}>
          <GallerySubmitDialog
            doc={doc}
            onClose={() => setGallerySubmitOpen(false)}
            onNotice={(message) => showTransientMessage(message, "error")}
            pendingMeta={pendingGalleryMeta}
          />
        </Suspense>
      )}
    </div>
  );
}
