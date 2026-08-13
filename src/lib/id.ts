/**
 * Globally-unique id generation.
 *
 * Sale ids become the client_uuid the backend dedups offline syncs on
 * (src/lib/sync.ts). A collision between two phones would make one phone's
 * sale silently dropped as a "duplicate" — and the client treats 'duplicate'
 * as success, so the sale would be lost forever with no error anywhere.
 *
 * That makes ids a money-integrity concern: they must be cryptographically
 * random, never just Date.now() + Math.random(). 64 bits of entropy keeps the
 * collision probability negligible even across every phone in the shop.
 */

export function newSaleId(): string {
  const words = new Uint32Array(2)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    // Works in secure contexts (localhost / HTTPS) and plain http alike.
    crypto.getRandomValues(words)
  } else {
    // Fallback for engines without Web Crypto — virtually never hit.
    words[0] = (Math.random() * 0xffffffff) >>> 0
    words[1] = (Math.random() * 0xffffffff) >>> 0
  }
  const hex = words[0].toString(16).padStart(8, '0') + words[1].toString(16).padStart(8, '0')
  return `S${hex.toUpperCase()}`
}
