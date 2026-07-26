import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const root = process.cwd()
const source = path.join(root, 'app', 'icon.svg')
const outputDirectory = path.join(root, 'build')
const output = path.join(outputDirectory, 'icon.ico')
const splashOutput = path.join(outputDirectory, 'portable-splash.bmp')
const sizes = [16, 24, 32, 48, 64, 128, 256]

const images = await Promise.all(
  sizes.map((size) =>
    sharp(source)
      .resize(size, size)
      .png()
      .toBuffer(),
  ),
)

const directorySize = 6 + images.length * 16
const header = Buffer.alloc(directorySize)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)

let imageOffset = directorySize
for (let index = 0; index < images.length; index++) {
  const entryOffset = 6 + index * 16
  const size = sizes[index]
  const image = images[index]
  header.writeUInt8(size === 256 ? 0 : size, entryOffset)
  header.writeUInt8(size === 256 ? 0 : size, entryOffset + 1)
  header.writeUInt8(0, entryOffset + 2)
  header.writeUInt8(0, entryOffset + 3)
  header.writeUInt16LE(1, entryOffset + 4)
  header.writeUInt16LE(32, entryOffset + 6)
  header.writeUInt32LE(image.length, entryOffset + 8)
  header.writeUInt32LE(imageOffset, entryOffset + 12)
  imageOffset += image.length
}

mkdirSync(outputDirectory, { recursive: true })
writeFileSync(output, Buffer.concat([header, ...images]))
const splashWidth = 520
const splashHeight = 260
const splashRaw = await sharp(source)
  .resize(104, 104)
  .flatten({ background: '#f7f4ec' })
  .extend({
    top: 56,
    bottom: 100,
    left: 208,
    right: 208,
    background: '#f7f4ec',
  })
  .raw()
  .toBuffer()
const rowStride = Math.ceil((splashWidth * 3) / 4) * 4
const pixelBytes = rowStride * splashHeight
const bmpHeader = Buffer.alloc(54)
bmpHeader.write('BM', 0)
bmpHeader.writeUInt32LE(54 + pixelBytes, 2)
bmpHeader.writeUInt32LE(54, 10)
bmpHeader.writeUInt32LE(40, 14)
bmpHeader.writeInt32LE(splashWidth, 18)
bmpHeader.writeInt32LE(splashHeight, 22)
bmpHeader.writeUInt16LE(1, 26)
bmpHeader.writeUInt16LE(24, 28)
bmpHeader.writeUInt32LE(pixelBytes, 34)
const bmpPixels = Buffer.alloc(pixelBytes, 0xff)
for (let y = 0; y < splashHeight; y++) {
  const sourceY = splashHeight - 1 - y
  for (let x = 0; x < splashWidth; x++) {
    const sourceOffset = (sourceY * splashWidth + x) * 3
    const targetOffset = y * rowStride + x * 3
    bmpPixels[targetOffset] = splashRaw[sourceOffset + 2]
    bmpPixels[targetOffset + 1] = splashRaw[sourceOffset + 1]
    bmpPixels[targetOffset + 2] = splashRaw[sourceOffset]
  }
}
writeFileSync(splashOutput, Buffer.concat([bmpHeader, bmpPixels]))
console.log(`Generated Windows icon: ${output}`)
console.log(`Generated portable splash: ${splashOutput}`)
