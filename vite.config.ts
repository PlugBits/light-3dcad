import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pagesのプロジェクトサイト(https://<org>.github.io/light-3dcad/)ではアプリが
// リポジトリ名のサブパス配下で配信される。ローカルdev/previewでは従来どおり `/` のまま動かし、
// GITHUB_PAGES=true のときだけ `/light-3dcad/` を base にする。
// BASE_PATH を明示指定すればそれを優先する(将来的に別のサブパスへ配置する場合の逃げ道)。
const base = process.env.BASE_PATH ?? (process.env.GITHUB_PAGES === 'true' ? '/light-3dcad/' : '/')

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react()],
  optimizeDeps: {
    exclude: ['replicad-opencascadejs'],
  },
  worker: {
    format: 'es',
  },
})
