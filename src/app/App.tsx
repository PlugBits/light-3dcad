import { useEffect, useMemo, useRef, useState } from "react";

import { DimensionOverlay } from "../components/DimensionOverlay";
import { DimensionToolPopup } from "../components/DimensionToolPopup";
import { ExtrudeEditor } from "../components/ExtrudeEditor";
import { FeatureTree } from "../components/FeatureTree";
import { SketchEditor } from "../components/SketchEditor";
import { downloadStl } from "../export/downloadStl";
import {
  addSketchEntity,
  addSketchSegments,
  findFeature,
  getDependentFeatureIds,
  setPolygonVertexCorner,
  setSketchConstraints,
  setSketchSegments,
  updateSketchEntity,
} from "../model/document";
import { buildAutoConstraintsForChain } from "../sketch/autoConstraints";
import {
  createArcSegment,
  createCircleEntity,
  createLineSegment,
  createPolygonEntity,
  createRectangleEntity,
  createSlotEntity,
} from "../model/entity";
import type { PolygonCorner } from "../model/types";
import {
  distanceBetweenRefs,
  segmentLength,
  segmentRadius,
  upsertDistanceConstraint,
  upsertDistanceEntityEntityConstraint,
  upsertDistanceEntityLineConstraint,
  upsertDistanceEntityOriginConstraint,
  upsertLengthConstraint,
  upsertRadiusConstraint,
} from "../sketch/constraintDimensions";
import { distanceBetweenPoints, distancePointToLine } from "../sketch/positionDimensions";
import { rectangleFromCorners, regularPolygonVertices } from "../sketch/shapeFromPoints";
import { trimSegmentAtPoint } from "../sketch/trim";
import { updateDocumentWithConflictRollback } from "../state/constraintUpdate";
import { useCadStore } from "../state/store";
import { CadViewer, type DimensionToolTarget, type SketchOverlayEntry } from "../viewer/CadViewer";
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
type DrawingTool = "rect" | "circle" | "slot" | "regularPolygon" | "segment" | null;

/**
 * ツールバーの標準ビューボタン(正面/背面/左/右/上/下/等角、Phase 16)。
 * UI改善(ツールバー整理)で主要3つ(正面/上/等角)だけをボタンで常設し、残り4つ(背面/左/右/下)は
 * コンパクトなセレクトにまとめる。
 */
const STANDARD_VIEW_BUTTONS: { view: StandardView; label: string; title: string }[] = [
  { view: "front", label: "正面", title: "正面(-Y側)から見る" },
  { view: "back", label: "背面", title: "背面(+Y側)から見る" },
  { view: "left", label: "左", title: "左側面(-X側)から見る" },
  { view: "right", label: "右", title: "右側面(+X側)から見る" },
  { view: "top", label: "上", title: "上面(+Z側)から見る" },
  { view: "bottom", label: "下", title: "下面(-Z側)から見る" },
  { view: "iso", label: "等角", title: "等角(アイソメトリック)ビュー" },
];
const PRIMARY_STANDARD_VIEWS: StandardView[] = ["front", "top", "iso"];
const MORE_STANDARD_VIEWS = STANDARD_VIEW_BUTTONS.filter((b) => !PRIMARY_STANDARD_VIEWS.includes(b.view));

export default function App() {
  const viewerContainerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<CadViewer | null>(null);

  const doc = useCadStore((s) => s.doc);
  const status = useCadStore((s) => s.status);
  const mesh = useCadStore((s) => s.mesh);
  const faceInfo = useCadStore((s) => s.faceInfo);
  const sketchPlanes = useCadStore((s) => s.sketchPlanes);
  const referenceEdges = useCadStore((s) => s.referenceEdges);
  const errorMessage = useCadStore((s) => s.errorMessage);
  const errorFeatureId = useCadStore((s) => s.errorFeatureId);
  const selectedFeatureId = useCadStore((s) => s.selectedFeatureId);
  const selectedFace = useCadStore((s) => s.selectedFace);
  const showSketches = useCadStore((s) => s.showSketches);
  const exporting = useCadStore((s) => s.exporting);
  const exportError = useCadStore((s) => s.exportError);
  const initialize = useCadStore((s) => s.initialize);
  const selectFeature = useCadStore((s) => s.selectFeature);
  const selectFace = useCadStore((s) => s.selectFace);
  const addSketch = useCadStore((s) => s.addSketch);
  const addExtrude = useCadStore((s) => s.addExtrude);
  const addFaceSketch = useCadStore((s) => s.addFaceSketch);
  const removeFeature = useCadStore((s) => s.removeFeature);
  const exportStl = useCadStore((s) => s.exportStl);
  const setShowSketches = useCadStore((s) => s.setShowSketches);
  const updateDocument = useCadStore((s) => s.updateDocument);
  const undo = useCadStore((s) => s.undo);
  const redo = useCadStore((s) => s.redo);
  const canUndo = useCadStore((s) => s.history.past.length > 0);
  const canRedo = useCadStore((s) => s.history.future.length > 0);

  // 現在アクティブな作図ツール(line/rect/circle、未選択はnull)。実体(頂点列・プレビュー)はCadViewerが持つ。
  const [activeTool, setActiveTool] = useState<DrawingTool>(null);
  // 描画モード開始時点で対象だったスケッチID。選択が他に移ったら自動キャンセルするために使う
  // (フィレット/面取りツールの開始時にも同じフィールドを使い回す)。
  const [drawingSketchId, setDrawingSketchId] = useState<string | null>(null);
  // 1mmグリッドスナップ(デフォルトON)。
  const [gridSnap, setGridSnap] = useState(true);
  // 「スケッチ追加」ボタンで使う平面選択(Phase 13)。基準平面クリックと同等の機能をUIからも操作できるようにする。
  const [newSketchPlane, setNewSketchPlane] = useState<"XY" | "XZ" | "YZ">("XY");
  // 現在アクティブなフィレット/面取りツール(未選択はnull、Phase 18)。
  const [cornerTool, setCornerTool] = useState<"fillet" | "chamfer" | null>(null);
  // トリムツール(未選択はfalse、Phase 19b)。
  const [trimTool, setTrimTool] = useState(false);
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
  } | null>(null);
  // 寸法ツールの1点目待ち状態のステータス表示(ツールバー付近に1行、UI改善対応)。未保留はnull。
  const [dimensionPendingLabel, setDimensionPendingLabel] = useState<string | null>(null);
  // 拘束の矛盾で自動巻き戻しが起きたときの一時メッセージ(Phase 20b)。数秒後に自動で消える。
  const [transientMessage, setTransientMessage] = useState<string | null>(null);
  const transientMessageTimer = useRef<number | null>(null);
  function showTransientMessage(message: string) {
    setTransientMessage(message);
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
    );
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
      viewerRef.current?.setMesh(mesh, faceInfo);
    }
  }, [mesh, faceInfo]);

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
        origin: plane.origin,
        xDir: plane.xDir,
        yDir: plane.yDir,
        normal: plane.normal,
      });
    }
    return overlays;
  }, [doc, sketchPlanes]);

  // オーバーレイ入力・選択スケッチ・表示トグルが変わるたびにビューアへ反映する。
  useEffect(() => {
    viewerRef.current?.setSketchOverlay(sketchOverlays, selectedFeatureId, showSketches);
  }, [sketchOverlays, selectedFeatureId, showSketches]);

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
    if (dimensionTool && selectedFeatureId !== drawingSketchId) {
      viewerRef.current?.cancelDimensionTool();
    }
  }, [activeTool, cornerTool, trimTool, dimensionTool, selectedFeatureId, drawingSketchId]);

  // フィレット/面取りツール中、対象スケッチのentitiesが変わった場合はヒット判定対象を更新する
  // (フィレット/面取りは頂点座標自体は変えないため必須ではないが、将来の変更に備えて同期しておく)。
  useEffect(() => {
    if (!cornerTool) return;
    const feature = selectedFeatureId ? findFeature(doc, selectedFeatureId) : undefined;
    if (feature?.type === "sketch") {
      viewerRef.current?.updateCornerToolEntities(feature.entities);
    }
  }, [cornerTool, doc, selectedFeatureId]);

  // トリムツール中、対象スケッチのsegmentsが変わった場合(トリム適用・アンドゥ等)はヒット判定対象を
  // 最新化する(Phase 19b)。
  useEffect(() => {
    if (!trimTool) return;
    const feature = selectedFeatureId ? findFeature(doc, selectedFeatureId) : undefined;
    if (feature?.type === "sketch") {
      viewerRef.current?.updateTrimSegments(feature.segments ?? []);
    }
  }, [trimTool, doc, selectedFeatureId]);

  // 寸法ツール中、対象スケッチのsegments/entitiesが変わった場合(拘束適用・entity直接更新・アンドゥ等)は
  // ヒット判定対象を最新化する(Phase 20b、Phase 21でentitiesも対象に追加)。
  useEffect(() => {
    if (!dimensionTool) return;
    const feature = selectedFeatureId ? findFeature(doc, selectedFeatureId) : undefined;
    if (feature?.type === "sketch") {
      viewerRef.current?.updateDimensionToolTargets(feature.segments ?? [], feature.entities);
    }
  }, [dimensionTool, doc, selectedFeatureId]);

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
  // テキスト入力欄にフォーカスがある間はブラウザ標準のテキスト編集アンドゥを優先し、何もしない。
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isEditable =
        !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (isEditable) return;
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

  const sketches = doc.features.filter((f) => f.type === "sketch");
  const selectedFeature = selectedFeatureId ? findFeature(doc, selectedFeatureId) : undefined;
  // 選択中フィーチャーがスケッチで、かつWorkerが平面基底を解決済みの場合のみ取得できる。
  // (未評価・面解決失敗中はundefinedになり、線描画・平面正対ボタンが無効化される)
  const selectedSketchPlane =
    selectedFeature?.type === "sketch"
      ? sketchPlanes.find((p) => p.sketchId === selectedFeature.id)
      : undefined;

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

  async function handleDownloadStl() {
    try {
      const blob = await exportStl();
      downloadStl(blob, "model.stl");
    } catch {
      // エラーはストアのexportErrorに反映済み。
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

  function handleCancelDrawing() {
    viewerRef.current?.cancelPolygonDrawing();
  }

  function handleGridSnapChange(checked: boolean) {
    setGridSnap(checked);
    viewerRef.current?.setPolygonDrawingSnap(checked);
  }

  /** 指定ツールのボタンをdisabledにすべきか(他のツールが実行中、または対象スケッチ平面が未確定)。 */
  function isToolDisabled(tool: Exclude<DrawingTool, null>): boolean {
    if (cornerTool || trimTool || dimensionTool) return true;
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
    viewerRef.current.startCornerTool(selectedSketchPlane, selectedFeature.entities, {
      onVertexClick: (entityId, vertexIndex) => {
        const currentDoc = useCadStore.getState().doc;
        const feature = findFeature(currentDoc, sketchId);
        if (!feature || feature.type !== "sketch") return;
        const entity = feature.entities.find((e) => e.id === entityId);
        if (!entity || entity.kind !== "polygon") return;
        const current = entity.corners?.[vertexIndex] ?? null;
        // 既に同種のコーナーが設定済みならトグルで解除、それ以外は現在のサイズで新規/種別変更する。
        const next: PolygonCorner = current && current.kind === kind ? null : { kind, size: cornerSizeRef.current };
        useCadStore.getState().updateDocument((d) => setPolygonVertexCorner(d, sketchId, entityId, vertexIndex, next));
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
    if (activeTool || trimTool || dimensionTool) return true;
    if (cornerTool) return cornerTool !== kind;
    return !selectedSketchPlane;
  }

  /**
   * トリムツール(Phase 19b)を開始する。ビューア上でセグメントの区間をクリックすると
   * その区間を削除する(実際のtrimSegmentAtPoint()適用はここで行う。onTrimClickは
   * startTrimTool呼び出し時に一度だけ渡すコールバックのため、最新のドキュメントはgetState()から読む)。
   */
  function handleStartTrimTool() {
    if (!viewerRef.current || !selectedFeature || selectedFeature.type !== "sketch" || !selectedSketchPlane) return;
    const sketchId = selectedFeature.id;
    viewerRef.current.startTrimTool(selectedSketchPlane, selectedFeature.segments ?? [], {
      onTrimClick: (targetId, clickPoint) => {
        const currentDoc = useCadStore.getState().doc;
        const feature = findFeature(currentDoc, sketchId);
        if (!feature || feature.type !== "sketch") return;
        const nextSegments = trimSegmentAtPoint(feature.segments ?? [], targetId, clickPoint);
        useCadStore.getState().updateDocument((d) => setSketchSegments(d, sketchId, nextSegments));
      },
      onCancel: () => {
        setTrimTool(false);
        setDrawingSketchId(null);
      },
    });
    setDrawingSketchId(sketchId);
    setTrimTool(true);
  }

  function handleCancelTrimTool() {
    viewerRef.current?.cancelTrimTool();
  }

  /** トリムボタンをdisabledにすべきか(他のツール実行中、または対象スケッチ平面が未確定)。 */
  function isTrimToolDisabled(): boolean {
    if (activeTool || cornerTool || dimensionTool) return true;
    if (trimTool) return false;
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
    viewerRef.current.startDimensionTool(selectedSketchPlane, selectedFeature.segments ?? [], selectedFeature.entities, {
      onTargetPicked: (target, screenX, screenY) => {
        const currentDoc = useCadStore.getState().doc;
        const feature = findFeature(currentDoc, sketchId);
        const segments = feature?.type === "sketch" ? (feature.segments ?? []) : [];
        const entities = feature?.type === "sketch" ? feature.entities : [];
        let titleLabel = "距離 (mm)";
        let initialValue = 0;
        let hintLabel: string | undefined;
        let axisOptions = false;
        if (target.kind === "length") {
          titleLabel = "長さ (mm)";
          const seg = segments.find((s) => s.id === target.segmentId);
          initialValue = seg ? segmentLength(seg) : 0;
        } else if (target.kind === "radius") {
          titleLabel = "半径 (mm)";
          const seg = segments.find((s) => s.id === target.segmentId);
          initialValue = (seg && segmentRadius(seg)) ?? 0;
        } else if (target.kind === "distance") {
          initialValue = distanceBetweenRefs(segments, target.a, target.b) ?? 0;
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
          titleLabel = "中心↔原点の距離 (mm)";
          const entity = entities.find((e) => e.id === target.entityId);
          initialValue = entity?.kind === "circle" ? distanceBetweenPoints(entity.center, [0, 0]) : 0;
        } else if (target.kind === "circle-distance-circle") {
          titleLabel = "中心間の距離 (mm)";
          const from = entities.find((e) => e.id === target.fromEntityId);
          const to = entities.find((e) => e.id === target.toEntityId);
          initialValue =
            from?.kind === "circle" && to?.kind === "circle" ? distanceBetweenPoints(from.center, to.center) : 0;
          hintLabel = "後にクリックした円(この円)が移動します";
          axisOptions = true;
        } else if (target.kind === "circle-distance-edge" || target.kind === "circle-distance-refedge") {
          titleLabel = target.kind === "circle-distance-refedge" ? "中心↔参照エッジの距離 (mm)" : "中心↔辺の距離 (mm)";
          const entity = entities.find((e) => e.id === target.entityId);
          initialValue = entity?.kind === "circle" ? distancePointToLine(entity.center, target.edgeA, target.edgeB) : 0;
          hintLabel = "辺は動かず、円の中心だけが移動します";
        }
        setDimensionPopup({ target, titleLabel, initialValue, screen: { x: screenX, y: screenY }, hintLabel, axisOptions });
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
        } else {
          setDimensionPendingLabel("1つ目: 端点 → 2つ目の端点を選択(距離)");
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
    if (activeTool || cornerTool || trimTool) return true;
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
  function handleApplyDimensionTarget(value: number, axis?: "direct" | "x" | "y") {
    if (!dimensionPopup || !selectedFeature || selectedFeature.type !== "sketch") return;
    const sketchId = selectedFeature.id;
    const target = dimensionPopup.target;

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
                ? upsertDistanceConstraint(constraints, target.a, target.b, value)
                : target.kind === "circle-distance-origin"
                  ? upsertDistanceEntityOriginConstraint(constraints, target.entityId, value)
                  : target.kind === "circle-distance-circle"
                    ? upsertDistanceEntityEntityConstraint(constraints, target.fromEntityId, target.toEntityId, value, axis)
                    : upsertDistanceEntityLineConstraint(constraints, target.entityId, target.line, value);
        return setSketchConstraints(doc, sketchId, next);
      },
      showTransientMessage,
    );
    setDimensionPopup(null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "sans-serif" }}>
      <header
        style={{
          display: "flex",
          flexDirection: "column",
          borderBottom: "1px solid #444",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            rowGap: 6,
            padding: "6px 12px",
          }}
        >
          <h1 style={{ fontSize: 14, margin: "0 12px 0 0" }}>light-3dcad</h1>

          <div className="toolbar-group">
            <span className="toolbar-group-label">ファイル</span>
            <select
              data-testid="new-sketch-plane-select"
              value={newSketchPlane}
              onChange={(e) => setNewSketchPlane(e.target.value as "XY" | "XZ" | "YZ")}
              title="新規スケッチを作成する基準平面(基準平面クリックと同等)"
            >
              <option value="XY">XY</option>
              <option value="XZ">XZ</option>
              <option value="YZ">YZ</option>
            </select>
            <button type="button" data-testid="btn-add-sketch" onClick={() => addSketch(newSketchPlane)}>
              スケッチ
            </button>
            <button
              type="button"
              data-testid="btn-add-extrude"
              onClick={handleAddExtrude}
              disabled={sketches.length === 0}
              title="選択中(なければ最後)のスケッチを押し出します"
            >
              押し出し
            </button>
            <button
              type="button"
              data-testid="btn-add-face-sketch"
              onClick={addFaceSketch}
              disabled={!selectedFace?.isPlanar}
              title="選択中の平面上にスケッチを追加します"
            >
              面にスケッチ
            </button>
            <button
              type="button"
              data-testid="btn-download-stl"
              onClick={handleDownloadStl}
              disabled={busy || exporting}
              title="現在のモデルをSTLファイルとしてダウンロードします"
            >
              {exporting ? "出力中…" : "STL"}
            </button>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-group-label">ビュー</span>
            <button
              type="button"
              data-testid="btn-fit-view"
              onClick={() => viewerRef.current?.fitToView()}
              title="モデル全体が画面に収まるようにカメラを調整します"
            >
              フィット
            </button>
            <button
              type="button"
              data-testid="btn-align-to-plane"
              onClick={handleAlignToPlane}
              disabled={!selectedSketchPlane}
              title="選択中スケッチの平面に正対する視点へカメラを移動します"
            >
              正対
            </button>
            {STANDARD_VIEW_BUTTONS.filter((b) => PRIMARY_STANDARD_VIEWS.includes(b.view)).map(({ view, label, title }) => (
              <button
                key={view}
                type="button"
                data-testid={`btn-view-${view}`}
                onClick={() => viewerRef.current?.setStandardView(view)}
                title={title}
                style={{ fontSize: 11, padding: "2px 6px" }}
              >
                {label}
              </button>
            ))}
            <select
              data-testid="view-more-select"
              value=""
              onChange={(e) => {
                if (e.target.value) viewerRef.current?.setStandardView(e.target.value as StandardView);
                e.target.value = "";
              }}
              title="その他の標準ビュー(背面/左/右/下)"
              style={{ fontSize: 11 }}
            >
              <option value="">他のビュー…</option>
              {MORE_STANDARD_VIEWS.map(({ view, label }) => (
                <option key={view} value={view}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-group-label">作図</span>
            <button
              type="button"
              data-testid="btn-draw-segment"
              className={activeTool === "segment" ? "toolbar-btn-active" : undefined}
              onClick={activeTool === "segment" ? handleCancelDrawing : handleStartSegmentDrawing}
              disabled={isToolDisabled("segment")}
              title="クリックで頂点を連結して線分・円弧のチェーンを描きます(Enter/ダブルクリックで確定、始点付近クリックで閉チェーン、Escでキャンセル)"
            >
              {activeTool === "segment" ? "線分キャンセル(Esc)" : "線分"}
            </button>
            {activeTool === "segment" && (
              <button
                type="button"
                data-testid="btn-toggle-arc-mode"
                className={arcModeActive ? "toolbar-btn-active" : undefined}
                onClick={handleToggleArcMode}
                title="次のセグメントを円弧(3点円弧)にします(Aキーでも切替)"
              >
                {arcModeActive ? "円弧セグメント中(A)" : "円弧(A)"}
              </button>
            )}
            <button
              type="button"
              data-testid="btn-draw-rect"
              className={activeTool === "rect" ? "toolbar-btn-active" : undefined}
              onClick={activeTool === "rect" ? handleCancelDrawing : handleStartRectDrawing}
              disabled={isToolDisabled("rect")}
              title="2クリックで矩形を描きます(1点目=コーナー、2点目=対角コーナー。Escでキャンセル)"
            >
              {activeTool === "rect" ? "矩形キャンセル(Esc)" : "矩形"}
            </button>
            <button
              type="button"
              data-testid="btn-draw-circle"
              className={activeTool === "circle" ? "toolbar-btn-active" : undefined}
              onClick={activeTool === "circle" ? handleCancelDrawing : handleStartCircleDrawing}
              disabled={isToolDisabled("circle")}
              title="2クリックで円を描きます(1点目=中心、2点目=円周上の点。Escでキャンセル)"
            >
              {activeTool === "circle" ? "円キャンセル(Esc)" : "円"}
            </button>
            <button
              type="button"
              data-testid="btn-draw-slot"
              className={activeTool === "slot" ? "toolbar-btn-active" : undefined}
              onClick={activeTool === "slot" ? handleCancelDrawing : handleStartSlotDrawing}
              disabled={isToolDisabled("slot")}
              title="3クリックでスロット(長円)を描きます(始点→終点→幅。Escでキャンセル)"
            >
              {activeTool === "slot" ? "スロットキャンセル(Esc)" : "スロット"}
            </button>
            <button
              type="button"
              data-testid="btn-draw-polygon"
              className={activeTool === "regularPolygon" ? "toolbar-btn-active" : undefined}
              onClick={activeTool === "regularPolygon" ? handleCancelDrawing : handleStartRegularPolygonDrawing}
              disabled={isToolDisabled("regularPolygon")}
              title="2クリックで正多角形を描きます(中心→頂点。辺数は右のセレクタ。Escでキャンセル)"
            >
              {activeTool === "regularPolygon" ? "多角形キャンセル(Esc)" : "多角形"}
            </button>
            <select
              data-testid="polygon-sides-select"
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
          </div>

          <div className="toolbar-group">
            <span className="toolbar-group-label">編集</span>
            <button
              type="button"
              data-testid="btn-corner-fillet"
              className={cornerTool === "fillet" ? "toolbar-btn-active" : undefined}
              onClick={cornerTool === "fillet" ? handleCancelCornerTool : () => handleStartCornerTool("fillet")}
              disabled={isCornerToolDisabled("fillet")}
              title="頂点付近をクリックしてフィレット(丸め)を適用します(適用済みをクリックで解除、Escで終了)"
            >
              {cornerTool === "fillet" ? "フィレットキャンセル(Esc)" : "フィレット"}
            </button>
            <button
              type="button"
              data-testid="btn-corner-chamfer"
              className={cornerTool === "chamfer" ? "toolbar-btn-active" : undefined}
              onClick={cornerTool === "chamfer" ? handleCancelCornerTool : () => handleStartCornerTool("chamfer")}
              disabled={isCornerToolDisabled("chamfer")}
              title="頂点付近をクリックして面取りを適用します(適用済みをクリックで解除、Escで終了)"
            >
              {cornerTool === "chamfer" ? "面取りキャンセル(Esc)" : "面取り"}
            </button>
            {cornerTool && (
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }} title="頂点クリックで適用するサイズ(mm)">
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
                  style={{ width: 50 }}
                />
                mm
              </label>
            )}
            <button
              type="button"
              data-testid="btn-trim"
              className={trimTool ? "toolbar-btn-active" : undefined}
              onClick={trimTool ? handleCancelTrimTool : handleStartTrimTool}
              disabled={isTrimToolDisabled()}
              title="セグメントの区間をクリックして削除します(赤色プレビューが削除対象、Escで終了)"
            >
              {trimTool ? "トリムキャンセル(Esc)" : "トリム"}
            </button>
            <button
              type="button"
              data-testid="btn-dimension"
              className={dimensionTool ? "toolbar-btn-active" : undefined}
              onClick={dimensionTool ? handleCancelDimensionTool : handleStartDimensionTool}
              disabled={isDimensionToolDisabled()}
              title="クリックで長さ/半径/距離の拘束を作成・編集します(Escで終了)"
            >
              {dimensionTool ? "寸法キャンセル(Esc)" : "寸法"}
            </button>
          </div>

          <div className="toolbar-group" style={{ marginLeft: "auto" }}>
            <button type="button" data-testid="btn-undo" onClick={undo} disabled={!canUndo} title="元に戻す (Ctrl+Z)">
              ↶
            </button>
            <button type="button" data-testid="btn-redo" onClick={redo} disabled={!canRedo} title="やり直す (Ctrl+Shift+Z)">
              ↷
            </button>
            <label
              style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}
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
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
              <input
                type="checkbox"
                data-testid="toggle-sketch-visibility"
                checked={showSketches}
                onChange={(e) => setShowSketches(e.target.checked)}
              />
              スケッチ表示
            </label>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "2px 12px 6px",
            minHeight: 16,
          }}
        >
          {activeTool && (
            <span data-testid="drawing-shift-hint" style={{ fontSize: 11, opacity: 0.7 }}>
              Shift押下中はスナップ・軸ロックを一時無効化
            </span>
          )}
          {cornerTool && (
            <span data-testid="corner-tool-hint" style={{ fontSize: 11, opacity: 0.7 }}>
              頂点付近をクリックして適用/解除
            </span>
          )}
          {trimTool && (
            <span data-testid="trim-tool-hint" style={{ fontSize: 11, opacity: 0.7 }}>
              削除したい区間をクリック
            </span>
          )}
          {dimensionTool && (
            <span data-testid="dimension-tool-hint" style={{ fontSize: 11, opacity: 0.7 }}>
              クリックで長さ/半径/距離を指定
            </span>
          )}
          {dimensionTool && dimensionPendingLabel && (
            <span
              data-testid="dimension-pending-status"
              style={{ fontSize: 11, fontWeight: "bold", color: "#ffb74d" }}
            >
              {dimensionPendingLabel}
            </span>
          )}
          <span data-testid="status-text" style={{ fontSize: 12, opacity: 0.8, marginLeft: "auto" }}>
            状態: {status}
            {status === "initializing" && " (WASM初期化中…)"}
            {status === "evaluating" && " (形状計算中…)"}
          </span>
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <aside
          style={{
            width: 320,
            padding: 16,
            borderRight: "1px solid #444",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            overflowY: "auto",
          }}
        >
          <div>
            <h2 style={{ fontSize: 13, margin: "0 0 8px", opacity: 0.8 }}>フィーチャーツリー</h2>
            <FeatureTree
              doc={doc}
              selectedFeatureId={selectedFeatureId}
              errorFeatureId={errorFeatureId}
              onSelect={selectFeature}
              onDelete={handleDelete}
            />
          </div>

          {selectedFace && (
            <div
              data-testid="selected-face-panel"
              style={{
                borderTop: "1px solid #444",
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

          {errorMessage && (
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
              STL出力エラー: {exportError}
            </p>
          )}

          {selectedFeature && (
            <div style={{ borderTop: "1px solid #444", paddingTop: 12 }}>
              {selectedFeature.type === "sketch" && <SketchEditor sketch={selectedFeature} />}
              {selectedFeature.type === "extrude" && <ExtrudeEditor extrude={selectedFeature} doc={doc} />}
            </div>
          )}

          <p style={{ fontSize: 11, opacity: 0.6, marginTop: "auto" }}>
            フィーチャーをクリックすると編集パネルが表示されます。値を変更すると自動的に再評価されます。
          </p>
        </aside>

        <main style={{ flex: 1, position: "relative" }}>
          <div ref={viewerContainerRef} data-testid="viewer-container" style={{ width: "100%", height: "100%" }} />
          {selectedFeature?.type === "sketch" && selectedSketchPlane && (
            <DimensionOverlay
              sketch={selectedFeature}
              basis={selectedSketchPlane}
              viewerRef={viewerRef}
              // 寸法ツール中(dimensionTool)は既存の寸法線・ラベルを隠さない(むしろ見えているべき、
              // UI改善対応)。線分/矩形/円等の作図ツール・フィレット/面取り・トリムの間は従来通り隠す。
              visible={showSketches && !activeTool && !cornerTool && !trimTool}
              onConflictRollback={showTransientMessage}
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
              onCancel={() => setDimensionPopup(null)}
              onApply={handleApplyDimensionTarget}
            />
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
                background: "rgba(211, 47, 47, 0.92)",
                color: "#fff",
                fontSize: 12,
                pointerEvents: "none",
                zIndex: 30,
              }}
            >
              {transientMessage}
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
    </div>
  );
}
