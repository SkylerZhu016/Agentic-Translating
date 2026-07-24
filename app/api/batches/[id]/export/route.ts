export const runtime = 'nodejs'

import JSZip from 'jszip'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const db = getDb()
  migrate(db)
  const batch = db.prepare('SELECT * FROM batch_jobs WHERE id=?').get(id) as {
    name: string
  } | undefined
  if (!batch) return Response.json({ error: 'not_found' }, { status: 404 })
  const items = db.prepare(`
    SELECT bi.*, fv.text AS final_text, fv.version_no
    FROM batch_items bi
    LEFT JOIN final_versions fv ON fv.id = (
      SELECT id FROM final_versions
      WHERE session_id=bi.session_id ORDER BY version_no DESC LIMIT 1
    )
    WHERE bi.batch_id=? AND bi.status='completed'
    ORDER BY bi.relative_path
  `).all(id) as Array<{
    relative_path: string
    final_text: string
    original_line_ending: 'lf' | 'crlf'
    had_bom: number
    session_id: string
    source_hash: string
    version_no: number
  }>
  const audit = new URL(request.url).searchParams.get('audit') === '1'
  const zip = new JSZip()
  for (const item of items) {
    let text = item.final_text
    if (item.original_line_ending === 'crlf') {
      text = text.replace(/\r?\n/g, '\r\n')
    } else {
      text = text.replace(/\r\n/g, '\n')
    }
    if (item.had_bom) text = `\uFEFF${text}`
    zip.file(item.relative_path, text)
    if (audit) {
      zip.file(`${item.relative_path}.audit.json`, JSON.stringify({
        sessionId: item.session_id,
        sourceHash: item.source_hash,
        finalVersionNo: item.version_no,
      }, null, 2))
    }
  }
  const archive = await zip.generateAsync({ type: 'uint8array' })
  return new Response(archive as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="batch-${id}.zip"`,
    },
  })
}
