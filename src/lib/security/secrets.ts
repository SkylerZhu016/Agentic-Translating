import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto'
import fs from 'fs'
import path from 'path'

const PREFIX = 'enc:v1:'
let cachedKey: Buffer | null = null

function keyMaterial(): string {
  if (process.env.AGENTIC_SECRET_KEY) return process.env.AGENTIC_SECRET_KEY
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'AGENTIC_SECRET_KEY is required in production to protect API keys.',
    )
  }
  const dataRoot = path.resolve(
    process.env.AGENTIC_DATA_DIR ?? path.join(process.cwd(), 'data'),
  )
  const keyFile = path.join(dataRoot, '.development-secret-key')
  fs.mkdirSync(dataRoot, { recursive: true })
  if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, 'utf8').trim()
  const generated = randomBytes(32).toString('hex')
  fs.writeFileSync(keyFile, generated, { encoding: 'utf8', mode: 0o600 })
  return generated
}

function key() {
  cachedKey ??= createHash('sha256').update(keyMaterial()).digest()
  return cachedKey
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext || plaintext.startsWith(PREFIX)) return plaintext
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), nonce)
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${Buffer.concat([nonce, tag, encrypted]).toString('base64')}`
}

export function decryptSecret(stored: string): string {
  if (!stored || !stored.startsWith(PREFIX)) return stored
  const packed = Buffer.from(stored.slice(PREFIX.length), 'base64')
  const nonce = packed.subarray(0, 12)
  const tag = packed.subarray(12, 28)
  const encrypted = packed.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key(), nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf8')
}
