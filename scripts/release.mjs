#!/usr/bin/env node
// 打包版本化发布：releases/<git短哈希>/（方法论移植自 MyInfobase/docs/deploy-handoff.md）
//
// 用法：node scripts/release.mjs [--skip-checks]
//   · tag = git 短哈希（也是镜像 tag、.env 的 ENGLISHFORGE_TAG、VERSION 文件内容）
//   · 发布包自带**现场构建**的 dist：镜像不再编译（NAS 上不跑 tsc/vite）
//   · 发布包内 package.json/package-lock.json 的 version 归一成 0.0.0 并**断言命中次数** ——
//     第一层 COPY 每次发版逐字节恒定，npm ci 层缓存才能永久命中（部署从分钟级到一分钟级的关键）
//   · 真实版本写进 VERSION 文件，程序自报（/api/health → version），部署脚本用它做上线断言
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const skipChecks = process.argv.includes('--skip-checks')
const git = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim()
const fail = (msg) => { console.error(msg); process.exit(1) }

// ---- 1) tag：一个 tag 必须唯一对应一份代码（工作区脏就不发）----
const tag = git('git rev-parse --short HEAD')
const dirty = git('git status --porcelain')
if (dirty) {
  if (skipChecks) console.warn(`警告：工作区不干净，仍以 HEAD=${tag} 打包（未提交的改动不会进包）：\n${dirty}`)
  else fail(`工作区不干净，先提交（或明确用 --skip-checks）：\n${dirty}`)
}

// ---- 2) 预检：类型 + 测试 + **现场构建 dist**（镜像不再编译，旧产物会发错版）----
if (!skipChecks) {
  console.log('== 预检：tsc -b（真检查，不是 --noEmit 空转）==')
  execSync('npx tsc -b --pretty false', { cwd: ROOT, stdio: 'inherit' })
  console.log('== 预检：测试 ==')
  execSync('npx vitest run', { cwd: ROOT, stdio: 'inherit' })
  console.log('== 构建 dist ==')
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' })
}

// ---- 3) 产物守卫：没有程序的包不是发布 ----
if (!existsSync(join(ROOT, 'dist', 'index.html'))) fail('dist/index.html 缺失 —— 先跑 npm run build')
if (!existsSync(join(ROOT, 'dist', 'assets'))) fail('dist/assets 缺失 —— 构建不完整')

// ---- 4) 组装发布包（只放镜像真正要用的东西；上下文越小、daemon 传得越快）----
const relDir = join(ROOT, 'releases', tag)
if (existsSync(relDir)) rmSync(relDir, { recursive: true, force: true })
mkdirSync(relDir, { recursive: true })

for (const f of ['package.json', 'package-lock.json', 'vite.config.ts', 'vite-plugin-db.mjs', 'vite-plugin-db.d.mts', 'index.html']) {
  cpSync(join(ROOT, f), join(relDir, f))
}
cpSync(join(ROOT, 'dist'), join(relDir, 'dist'), { recursive: true })
cpSync(join(ROOT, 'server'), join(relDir, 'server'), { recursive: true })
cpSync(join(ROOT, 'deploy', 'Dockerfile'), join(relDir, 'Dockerfile'))

// ---- 5) 版本归一 + 命中断言（npm 的 version 出现在多处；盲替换会毁掉 lockfile）----
const normalize = (rel, expectedHits) => {
  const p = join(relDir, rel)
  const text = readFileSync(p, 'utf8')
  const cur = JSON.parse(text).version
  if (cur === '0.0.0') return 0   // 已经是常量
  const needle = `"version": "${cur}"`
  const hits = text.split(needle).length - 1
  if (hits !== expectedHits) {
    fail(`${rel} 里 "${needle}" 出现 ${hits} 次，预期 ${expectedHits} 次 —— npm 结构变了，中止（防止盲目替换毁掉 lockfile）`)
  }
  writeFileSync(p, text.split(needle).join('"version": "0.0.0"'))
  return hits
}
const normPkg = normalize('package.json', 1)
const normLock = normalize('package-lock.json', 2)
if (normPkg || normLock) console.log(`版本已归一：package.json ×${normPkg}、lock ×${normLock}`)

// ---- 6) VERSION（真实版本，程序自报用）----
writeFileSync(join(relDir, 'VERSION'), `${tag}\n`)

// ---- 7) .dockerignore（node 写文件无 BOM —— PS5.1 的 BOM 坑在这里天然不存在）----
writeFileSync(join(relDir, '.dockerignore'), '.env*\nmanifest.json\n')

// ---- 8) manifest.json：每个文件的 sha256 + size（"到底发了什么"的审计账）----
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const files = {}
const walkFs = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkFs(p)
    else {
      const rel = relative(relDir, p).split('\\').join('/')
      files[rel] = { sha256: sha256(p), bytes: statSync(p).size }
    }
  }
}
walkFs(relDir)
const manifest = {
  version: tag,
  builtAt: new Date().toISOString(),
  machine: `${os.hostname()} (${os.type()} ${os.arch()})`,
  normalizedVersion: { packageJson: normPkg, packageLock: normLock },
  fileCount: Object.keys(files).length,
  files,
}
writeFileSync(join(relDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

// ---- 9) 汇总 ----
const totalBytes = Object.values(files).reduce((n, f) => n + f.bytes, 0)
console.log(`\n发布包就绪：releases/${tag}`)
console.log(`  文件 ${manifest.fileCount} 个 · 共 ${(totalBytes / 1024 / 1024).toFixed(1)} MB · dist 现场构建 ✓`)
console.log(`下一步（NAS 上，需要 root）：`)
console.log(`  sudo sh deploy/nas-update.sh ${tag}`)
