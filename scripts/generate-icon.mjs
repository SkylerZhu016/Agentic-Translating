import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const root = process.cwd()
const source = path.join(root, 'app', 'icon.svg')
const outputDirectory = path.join(root, 'build')
const output = path.join(outputDirectory, 'icon.ico')
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
console.log(`Generated Windows icon: ${output}`)
