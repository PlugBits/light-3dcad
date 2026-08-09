import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { extname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// GitHub Pagesのプロジェクトサイト(https://<org>.github.io/light-3dcad/)ではアプリが
// リポジトリ名のサブパス配下で配信される。ローカルdev/previewでは従来どおり `/` のまま動かし、
// GITHUB_PAGES=true のときだけ `/light-3dcad/` を base にする。
// BASE_PATH を明示指定すればそれを優先する(将来的に別のサブパスへ配置する場合の逃げ道)。
const base = process.env.BASE_PATH ?? (process.env.GITHUB_PAGES === 'true' ? '/light-3dcad/' : '/')

/**
 * モデルギャラリー(Phase 40c)。リポジトリルートの models/ (コントリビューションの起点=正本、
 * PRで models/<slug>/ が追加される場所)を、public/ 配下へ複製・移動せずに配信する小さなプラグイン。
 * - dev: `/models/**` へのリクエストを models/ から直接返す(BASE_URLは常に"/"のためパスは固定)。
 * - build: closeBundle() で models/ を dist/models へ丸ごとコピーする(ビルド成果物側にのみ複製が
 *   生まれ、リポジトリ上の正本は models/ のまま)。
 * アプリ側(src/project/galleryLoad.ts)は `${import.meta.env.BASE_URL}models/<slug>/model.l3dcad`
 * をfetchするため、GitHub Pagesのサブパスbase配下でもこの配置で一致する。
 */
function modelsGalleryAssetsPlugin(): Plugin {
  const modelsDir = resolvePath(__dirname, 'models')
  const mimeByExt: Record<string, string> = {
    '.json': 'application/json; charset=utf-8',
    '.l3dcad': 'application/json; charset=utf-8',
  }
  let outDir = 'dist'
  return {
    name: 'light3dcad-models-gallery-assets',
    configResolved(config) {
      outDir = config.build.outDir
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/models/')) {
          next()
          return
        }
        const relPath = decodeURIComponent(req.url.slice('/models/'.length).split(/[?#]/)[0])
        const filePath = join(modelsDir, relPath)
        if (!filePath.startsWith(modelsDir) || !existsSync(filePath)) {
          next()
          return
        }
        res.setHeader('Content-Type', mimeByExt[extname(filePath)] ?? 'application/octet-stream')
        res.end(readFileSync(filePath))
      })
    },
    closeBundle() {
      if (!existsSync(modelsDir)) return
      const dest = resolvePath(__dirname, outDir, 'models')
      mkdirSync(dest, { recursive: true })
      cpSync(modelsDir, dest, { recursive: true })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react(), modelsGalleryAssetsPlugin()],
  optimizeDeps: {
    exclude: ['replicad-opencascadejs'],
  },
  worker: {
    format: 'es',
  },
})
