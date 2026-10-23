// Draws build/icon.png (1024×1024), from which electron-builder makes the
// macOS .icns and Windows .ico. Run: node scripts/make-icon.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const SIZE = 1024
// macOS icon grid: an 824px rounded square centred on the canvas.
const BOX = 824
const RADIUS = 185
const TOP = [124, 134, 240] // accent, light
const BOTTOM = [63, 74, 192] // accent, strong
const SS = 4 // supersampling per axis

const inBox = (x, y) => {
  const half = BOX / 2
  const dx = Math.max(Math.abs(x - SIZE / 2) - (half - RADIUS), 0)
  const dy = Math.max(Math.abs(y - SIZE / 2) - (half - RADIUS), 0)
  return (
    Math.abs(x - SIZE / 2) <= half &&
    Math.abs(y - SIZE / 2) <= half &&
    dx * dx + dy * dy <= RADIUS * RADIUS
  )
}
// Four-point sparkle (astroid |u|^½ + |v|^½ ≤ 1), the same shape as the tray icon.
const inSparkle = (x, y, cx, cy, r) => {
  const u = Math.abs(x - cx) / r
  const v = Math.abs(y - cy) / r
  return Math.sqrt(u) + Math.sqrt(v) <= 1
}

const rgba = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++)
  for (let x = 0; x < SIZE; x++) {
    let box = 0
    let star = 0
    for (let sy = 0; sy < SS; sy++)
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS
        const py = y + (sy + 0.5) / SS
        if (!inBox(px, py)) continue
        box++
        if (inSparkle(px, py, 512, 512, 300) || inSparkle(px, py, 712, 300, 78)) star++
      }
    const i = (y * SIZE + x) * 4
    if (!box) continue
    const t = (y - (SIZE - BOX) / 2) / BOX
    const bg = TOP.map((c, k) => c + (BOTTOM[k] - c) * Math.min(Math.max(t, 0), 1))
    const w = star / box
    for (let k = 0; k < 3; k++) rgba[i + k] = Math.round(bg[k] * (1 - w) + 255 * w)
    rgba[i + 3] = Math.round((box / (SS * SS)) * 255)
  }

// Minimal PNG encoder: 8-bit RGBA, no filtering.
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8
ihdr[9] = 6
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y++)
  rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png')
writeFileSync(out, png)
console.log(`wrote ${out} (${png.length} bytes)`)
