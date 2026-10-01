// 31 收口：跨页面未提交录音草稿的本地恢复（IndexedDB）。
// 为什么 IndexedDB：Blob 直接可存且不受 localStorage 5MB 限制；录音是用户仅有的表达证据，
// 页面刷新/切页不该丢。仅存本机浏览器，不上传；提交或删除后即清。
// 环境无 indexedDB（旧浏览器/测试环境）时全部静默降级为 no-op。

export interface OralDraft {
  blob: Blob
  transcript: string
  transcriptOrigin: 'asr' | 'user_typed'
  mime: string
  savedAt: number
}

const DB_NAME = 'englishforge-drafts'
const STORE = 'oral'

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch { resolve(null) }
  })
}

export function draftKey(accountId: string, taskId: string): string {
  return `${accountId}:${taskId}`
}

export async function saveDraft(key: string, draft: Omit<OralDraft, 'savedAt'>): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ ...draft, savedAt: Date.now() }, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch { /* 存不进就存不进：恢复是加分项，不是提交前提 */ }
}

export async function loadDraft(key: string): Promise<OralDraft | null> {
  const db = await openDb()
  if (!db) return null
  try {
    return await new Promise<OralDraft | null>((resolve) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => {
        const v = req.result as OralDraft | undefined
        resolve(v && v.blob instanceof Blob ? v : null)
      }
      req.onerror = () => resolve(null)
    })
  } catch { return null }
}

export async function clearDraft(key: string): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch { /* 同上 */ }
}
