/**
 * 探针结果与指纹缓存管理器
 * 带有 TTL 控制与最大条目数限制，避免内存泄漏并防止跨账号碰撞
 */

import crypto from "node:crypto"

const memoryCache = new Map()
const DEFAULT_TTL_MS = 5 * 60 * 1000 // 默认缓存 5 分钟
const MAX_ENTRIES = 256 // 最大缓存条目数

/**
 * 计算 Key 的 SHA-256 指纹，杜绝后缀碰撞
 */
export function fingerprint(value) {
  if (!value) return ""
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 32)
}

export function getCachedProbe(cacheKey) {
  if (!cacheKey) return null
  const entry = memoryCache.get(cacheKey)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(cacheKey)
    return null
  }
  return entry.value
}

export function setCachedProbe(cacheKey, value, ttlMs = DEFAULT_TTL_MS) {
  if (!cacheKey || !value) return

  // 如果达到上限且是新 key，剔除最早插入的条目 (FIFO)
  if (!memoryCache.has(cacheKey) && memoryCache.size >= MAX_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value
    if (oldestKey) memoryCache.delete(oldestKey)
  }

  memoryCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + ttlMs,
  })
}

export function clearCachedProbe(cacheKey) {
  if (cacheKey) {
    memoryCache.delete(cacheKey)
  } else {
    memoryCache.clear()
  }
}

export function getCacheSize() {
  return memoryCache.size
}
