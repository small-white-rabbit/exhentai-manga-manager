import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import monacoEditorPluginPkg from 'vite-plugin-monaco-editor'

const monacoEditorPlugin =
  monacoEditorPluginPkg.default ?? monacoEditorPluginPkg

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    monacoEditorPlugin({
      languageWorkers: ['editorWorkerService'],
      publicPath: 'monacoeditorwork'
    })
  ],
  base: './',
  server: {
    port: 5374
  }
})
