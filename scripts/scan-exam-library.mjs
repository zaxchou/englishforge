// 真题库全量扫描（59 号 S1 / 用户指令 2：把给我的所有真题扫描整理出来）。
// 产出 server/data/toefl/exam-library.json：套卷清单（文件级快照 + 状态），不把文件数当题数。
// 运行：node scripts/scan-exam-library.mjs
import { createHash } from 'node:crypto'
import { readdirSync, statSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const JUNENGLISH = resolve(HERE, '..', '..')
const ROOTS = ['819新托福真题持续更新', '新D方/新D方新托福全套']
const EXTS = ['.pdf', '.mp3', '.wav', '.mp4', '.m4a', '.doc', '.docx', '.png', '.jpg']

function walk(dir, depth = 0) {
  let files = []
  let dirs = 0
  for (const name of readdirSync(dir)) {
    if (name === '_gsdata_' || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) { dirs++; files = files.concat(walk(p, depth + 1)) }
    else if (EXTS.some((e) => name.toLowerCase().endsWith(e))) files.push(p)
  }
  return files
}

function classifyDir(rel) {
  if (/TPO/i.test(rel)) return 'tpo'
  if (/学生版|教师版|样题|体验日|付费新题|Essentials.*母题|官方模拟|官方样题/i.test(rel)) return 'official_style'
  if (/真题|持续更新/i.test(rel)) return 'recent_exam'
  if (/词汇|语法/i.test(rel)) return 'vocab'
  if (/评分标准|课程计划|综述|改革/i.test(rel)) return 'reference'
  return 'other'
}

const packs = []
for (const root of ROOTS) {
  const abs = join(JUNENGLISH, root)
  if (!existsSync(abs)) { console.warn('跳过（不存在）:', root); continue }
  // 顶层两层目录当"套卷组"
  const groups = new Map()
  for (const f of walk(abs)) {
    const rel = relative(JUNENGLISH, f).replaceAll('\\', '/')
    // 组 = 819 下的第二层目录；新D方下按老师科目目录
    const parts = rel.split('/')
    // 819 根（第1层）下取到第3层：如 托福18套/01.官方学生版样题2套；新D方下取 2 层（科目目录）
    const depth = root.includes('819') ? 3 : 2
    const groupKey = parts.slice(0, depth).join('/')
    if (!groups.has(groupKey)) groups.set(groupKey, [])
    groups.get(groupKey).push(rel)
  }
  for (const [group, files] of groups) {
    const pdfs = files.filter((f) => f.toLowerCase().endsWith('.pdf'))
    const audio = files.filter((f) => /\.(mp3|wav|m4a)$/i.test(f))
    packs.push({
      groupId: group,
      category: classifyDir(group),
      fileCount: files.length,
      pdfCount: pdfs.length,
      audioCount: audio.length,
      // 指纹只算前 200 个文件，避免全库哈希太慢；清单以路径为准
      fingerprint: createHash('sha256').update(files.slice(0, 200).join('\n')).digest('hex').slice(0, 12),
      status: 'registered_not_digitized',
      note: '文件快照入库；逐套录入需按 55 §11 流水线（抽取→原页校对→音频/答案配对→审核）后才能开考',
    })
  }
}

// 已数字化的套
const examsDir = resolve(HERE, '..', 'server', 'data', 'toefl', 'exams')
const digitized = existsSync(examsDir) ? readdirSync(examsDir).filter((f) => f.endsWith('.json')) : []

const library = {
  generatedAt: Date.now(),
  notice: '真题库清单（用户指令 2 的"扫描整理"）。packs=文件级快照（不等于题数）；digitizedExams=已完成电子化录入可开考的套。录入流水线见 55 §11：逐套需人工校对题面、官方答案键与音频配对。',
  roots: ROOTS,
  totalFiles: packs.reduce((n, p) => n + p.fileCount, 0),
  packs,
  digitizedExams: digitized.map((f) => JSON.parse(readFileSync(join(examsDir, f), 'utf8')).meta),
}
writeFileSync(resolve(HERE, '..', 'server', 'data', 'toefl', 'exam-library.json'), JSON.stringify(library, null, 1) + '\n')
console.log(`套卷组 ${packs.length} 个，文件 ${library.totalFiles} 个，已录入套 ${digitized.length} 套`)
for (const p of packs) console.log(' ', p.category.padEnd(14), p.groupId, `(${p.pdfCount} PDF / ${p.audioCount} 音频)`)
