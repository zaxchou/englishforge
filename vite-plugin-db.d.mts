// vite-plugin-db.mjs 是纯 JS（Node 里直接跑，不经 TS 编译），这里补一份最小类型。
import type { Plugin } from 'vite'

declare function progressDb(): Plugin
export default progressDb
