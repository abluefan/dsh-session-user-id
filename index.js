// dsh-session-user-id —— 每條 session 一個獨立、持久、隨機嘅 DeepSeek API user_id
//
// 背景：DeepSeek API 支援 request body 嘅 `user_id`（[a-zA-Z0-9\-_]+，最長 512），
// 用嚟做內容安全隔離、KVCache 隔離、調度隔離。
// 官方明確要求：**不要在 user_id 中包含用戶隱私信息** ⇒ 呢度只會用隨機 UUID v4。
//
// DSH 本身只有一個全局匿名 user id（getOrCreateAnonymousUserId），冇 session 概念。
// 但 `deepseekLlmApiExtensions` 擴展點嘅 request 帶 `sessionId`，而且 provider
// 回傳嘅 value 會 merge 成 request body 嘅 top-level field —— 正好用嚟注入 user_id。
//
// 映射檔：$DSH_HOME\session-user-ids.json
//   { "version": 1, "sessions": { "<sessionId>": "<uuid>" } }
//
// 行為：
//   · 第一次見到某 sessionId → 生成 UUID v4、寫入檔案、之後永久不變
//   · 冇 sessionId 嘅請求（例如某些內部呼叫）→ 唔加 user_id，保持默認
//   · compaction / session-title 子請求沿用同一個 sessionId ⇒ 同一個 user_id

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 插件名，必須與 package.json 的 name 一致。 */
export const name = 'dsh-session-user-id'

/** 唯一硬依賴：extension registry。 */
export const inject = ['deepseekLlmApiExtensions']

/** 映射檔名（放喺 $DSH_HOME 根）。 */
const FILE_NAME = 'session-user-ids.json'

/**
 * 解析映射檔路徑。
 * @returns {string} 絕對路徑
 */
function resolveFile() {
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return join(home, FILE_NAME)
  return join(homedir(), '.dsh', FILE_NAME)
}

/** 記憶體快取（null = 未載入）。 */
let cache = null

/** 已警告過寫入失敗，避免每次請求都刷 log。 */
let warnedWrite = false

/**
 * 載入映射（只讀一次）。
 * @param {string} file - 映射檔路徑
 * @returns {Record<string, string>} sessionId → userId
 */
function load(file) {
  if (cache !== null) return cache
  const sessions = {}
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const table = parsed !== null && typeof parsed === 'object' ? parsed.sessions : undefined
      if (table !== null && typeof table === 'object' && !Array.isArray(table)) {
        for (const [key, value] of Object.entries(table)) {
          if (typeof key === 'string' && typeof value === 'string' && value !== '') sessions[key] = value
        }
      }
    }
  } catch (ignored) {
    // 檔案壞咗或者讀唔到 → 當空開始（唔好阻住 DSH 啟動）
  }
  cache = sessions
  return cache
}

/**
 * 原子寫入映射檔（tmp + rename）。
 * @param {string} file - 映射檔路徑
 * @returns {void}
 */
function save(file) {
  const payload = JSON.stringify({ version: 1, sessions: cache }, null, 2) + '\n'
  const tmp = file + '.' + process.pid + '.tmp'
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(tmp, payload, 'utf8')
  renameSync(tmp, file)
}

/**
 * 取得（或建立）某 session 嘅 user_id。
 * @param {string} file - 映射檔路徑
 * @param {string} sessionId - session 身份
 * @param {(error: unknown) => void} onWriteError - 寫入失敗回報
 * @returns {string} UUID v4
 */
function userIdFor(file, sessionId, onWriteError) {
  const sessions = load(file)
  const existing = sessions[sessionId]
  if (typeof existing === 'string' && existing !== '') return existing
  const created = randomUUID()
  sessions[sessionId] = created
  try {
    save(file)
  } catch (error) {
    onWriteError(error)
  }
  return created
}

/**
 * 插件入口。
 * @param ctx - host cordis context
 * @returns {void}
 */
export function apply(ctx) {
  const file = resolveFile()
  load(file)

  const onWriteError = (error) => {
    if (warnedWrite) return
    warnedWrite = true
    ctx.logger.warn('dsh-session-user-id: 寫入映射檔失敗（之後同類錯誤唔再記錄）：%o', error)
  }

  ctx.effect(() => ctx.deepseekLlmApiExtensions.register('user_id', {
    prepare(request) {
      const sessionId = request.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      return { value: userIdFor(file, sessionId, onWriteError) }
    },
  }), 'dsh-session-user-id: register user_id field')

  ctx.logger.info(`dsh-session-user-id: ready（映射檔：${file}）`)
}
