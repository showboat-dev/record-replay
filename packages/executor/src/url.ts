/**
 * URL 重定基 —— 实现已上移到 `@rr/resolver`（iframe 的 urlPattern 也要用同一套逻辑）。
 * 这里保留 re-export，保证 executor 自己的公开 API 不变。
 */
export { describeRebase, matchesUrlPattern, NAME_KEEPALIVE_SOURCE, rebaseUrl } from '@rr/resolver'
