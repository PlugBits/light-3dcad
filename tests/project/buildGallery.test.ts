// scripts/build-gallery.mjs の単体テスト(Phase 40c)。
// Node標準モジュールのみのESMスクリプトのため、Vitestからそのままimportできる。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadModelEntries, renderGalleryHtml } from "../../scripts/build-gallery.mjs";

const REPO_MODELS_DIR = resolve(__dirname, "../../models");

describe("loadModelEntries / renderGalleryHtml (実際のmodels/)", () => {
  it("シードした3モデルのタイトルがすべてHTMLに含まれる", () => {
    const entries = loadModelEntries(REPO_MODELS_DIR);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    const html = renderGalleryHtml(entries);
    expect(html).toContain("穴あきプレート");
    expect(html).toContain("L字ブラケット");
    expect(html).toContain("リング");
    expect(html).toContain("モデルギャラリー | light-3dcad");
    // 「開く」リンクがslugを指していること。
    const plateEntry = entries.find((e) => e.slug === "plate-with-hole");
    expect(plateEntry).toBeDefined();
    expect(html).toContain("../?g=plate-with-hole");
  });
});

describe("loadModelEntries / renderGalleryHtml (一時ディレクトリ)", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  function makeModel(dir: string, slug: string, meta: Record<string, unknown>) {
    const modelDir = join(dir, slug);
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "meta.json"), JSON.stringify(meta), "utf-8");
  }

  it("meta.jsonのタイトルがslug昇順でHTMLに含まれる", () => {
    tempDir = mkdtempSync(join(tmpdir(), "l3dcad-gallery-"));
    makeModel(tempDir, "zzz-model", { title: "Zモデル", author: "PlugBits", description: "説明Z", tags: ["x"] });
    makeModel(tempDir, "aaa-model", { title: "Aモデル", author: "PlugBits", description: "説明A", tags: [] });

    const entries = loadModelEntries(tempDir);
    expect(entries.map((e) => e.slug)).toEqual(["aaa-model", "zzz-model"]);

    const html = renderGalleryHtml(entries);
    expect(html).toContain("Aモデル");
    expect(html).toContain("Zモデル");
    expect(html).toContain("説明A");
    expect(html).toContain("../?g=aaa-model");
  });

  it("meta.jsonが無いディレクトリはスキップする", () => {
    tempDir = mkdtempSync(join(tmpdir(), "l3dcad-gallery-"));
    mkdirSync(join(tempDir, "no-meta"), { recursive: true });
    makeModel(tempDir, "with-meta", { title: "あり", author: "PlugBits", description: "説明", tags: [] });

    const entries = loadModelEntries(tempDir);
    expect(entries.map((e) => e.slug)).toEqual(["with-meta"]);
  });

  it("モデルが0件でも壊れないHTMLを返す", () => {
    tempDir = mkdtempSync(join(tmpdir(), "l3dcad-gallery-"));
    const entries = loadModelEntries(tempDir);
    expect(entries).toEqual([]);
    const html = renderGalleryHtml(entries);
    expect(html).toContain("まだモデルが投稿されていません");
  });

  it("タイトル/説明文中のHTML特殊文字をエスケープする", () => {
    tempDir = mkdtempSync(join(tmpdir(), "l3dcad-gallery-"));
    makeModel(tempDir, "xss-model", {
      title: "<script>alert(1)</script>",
      author: "PlugBits",
      description: "説明 <b>太字</b> & \"引用符\"",
      tags: [],
    });
    const entries = loadModelEntries(tempDir);
    const html = renderGalleryHtml(entries);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
