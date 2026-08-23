export const runtime = 'nodejs'

import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createRepositories } from '@/src/lib/db/repositories'
import { createProjectRepositories } from '@/src/lib/db/project-repositories'
import { createTranslationToolRepository } from '@/src/lib/db/translation-tool-repository'
import { redactSecrets } from '@/src/lib/security/public-dto'
import {
  publicPersistedExecutionError,
  type ExecutionDiagnosticErrorDto,
} from '@/src/lib/security/diagnostic-error'
import { parseSemanticAgentOutput } from '@/src/lib/protocol/semantic-output'
import { redactCredentialValueForDb } from '@/src/lib/security/credential-redaction'

function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80)
}

function markdownExecutionError(
  diagnostic: ExecutionDiagnosticErrorDto | null,
): string {
  if (!diagnostic) return ''
  return [
    diagnostic.message,
    '',
    `- 错误代码：${diagnostic.error}`,
    `- diagnosticId：${diagnostic.diagnosticId}`,
  ].join('\n')
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const db = getDb()
  migrate(db)
  const repos = createRepositories(db)
  const projectRepos = createProjectRepositories(db)
  const toolRepos = createTranslationToolRepository(db)
  const session = repos.sessions.getById(id)
  if (!session) return Response.json({ error: 'session_not_found' }, { status: 404 })
  const results = repos.translationResults.listBySession(id)
  const stages = repos.stageOutputs.listBySession(id)
  const versions = repos.finalVersions.listBySession(id)
  const messages = repos.chatMessages.listBySession(id)
  const invocations = redactCredentialValueForDb(db, db.prepare(
    'SELECT * FROM agent_invocations WHERE session_id=? ORDER BY created_at, id',
  ).all(id) as Array<Record<string, unknown>>)
  const patches = db.prepare(
    'SELECT * FROM text_patches WHERE session_id=? ORDER BY created_at, id',
  ).all(id)
  const projectContext =
    projectRepos.sessionProjectContexts.getBySession(id) ?? null
  const toolCalls = redactCredentialValueForDb(
    db,
    toolRepos.listCalls({ sessionId: id }),
  )
  const reviewIssues = redactCredentialValueForDb(
    db,
    toolRepos.listIssues({ sessionId: id }),
  )
  const config = redactSecrets(JSON.parse(session.config_snapshot))
  const publicResults = results.map((result) => {
    const errorDiagnostic = publicPersistedExecutionError(
      result.error,
      'translation',
      `${result.session_id}:${result.id}`,
    )
    return {
      ...result,
      ...(errorDiagnostic
        ? { error: errorDiagnostic.message, errorDiagnostic }
        : {}),
      semantic: parseSemanticAgentOutput(result.output_text ?? ''),
    }
  })
  const publicStages = stages.map((stage) => {
    const errorDiagnostic = publicPersistedExecutionError(
      stage.error,
      'stage',
      `${stage.session_id}:${stage.id}`,
    )
    return {
      ...stage,
      ...(errorDiagnostic
        ? { error: errorDiagnostic.message, errorDiagnostic }
        : {}),
      semantic: parseSemanticAgentOutput(stage.raw_output ?? ''),
    }
  })
  const payload = redactSecrets(redactCredentialValueForDb(db, {
    session: { ...session, config_snapshot: undefined },
    config_snapshot: config,
    project_context: projectContext,
    legacy_results: publicResults,
    invocations,
    stages: publicStages,
    versions,
    patches,
    messages,
    tool_calls: toolCalls,
    review_issues: reviewIssues,
  }))
  const format = new URL(request.url).searchParams.get('format') ?? 'json'
  const base = safeFilename(`agentic-translation-${id}`)
  if (format === 'md') {
    const lines = [
      '# Agentic Translating 会话导出',
      '',
      `- 会话：${id}`,
      `- 方向：${session.direction ?? 'en_to_zh'}`,
      `- 状态：${session.state}`,
      `- 创建时间：${session.created_at}`,
      '',
      '## 任务要求',
      '',
      session.task_brief || '无',
      '',
      '## 本次冻结的项目档案',
      '',
      projectContext
        ? [
            `- 项目：${projectContext.projectId}`,
            `- 快照：${projectContext.projectSnapshotId}`,
            `- 资源 revision：${projectContext.resourceRevisionIds.length}`,
            `- 上下文 token 估算：${projectContext.tokenEstimate}`,
            '',
            '```json',
            JSON.stringify(projectContext.resources, null, 2),
            '```',
          ].join('\n')
        : '未绑定项目档案。',
      '',
      '## 原文',
      '',
      session.source_text,
      '',
      '## Agent 调用',
      '',
    ]
    for (const invocation of invocations) {
      lines.push(
        `### ${String(invocation.agent_variant_id)}`,
        '',
        String(invocation.raw_output ?? invocation.error ?? ''),
        '',
      )
    }
    lines.push('## 工具调用轨迹', '')
    for (const toolCall of toolCalls) {
      lines.push(
        `### ${toolCall.toolName} · ${toolCall.status}`,
        '',
        '```json',
        JSON.stringify(toolCall, null, 2),
        '```',
        '',
      )
    }
    lines.push('## 审校问题', '')
    for (const issue of reviewIssues) {
      lines.push(
        `### ${issue.title} · ${issue.status}`,
        '',
        issue.details,
        '',
        '```json',
        JSON.stringify(issue, null, 2),
        '```',
        '',
      )
    }
    lines.push('## 四阶段', '')
    for (const stage of publicStages) {
      lines.push(
        `### ${stage.stage}`,
        '',
        stage.raw_output ?? markdownExecutionError(stage.errorDiagnostic ?? null),
        '',
      )
    }
    lines.push('## 版本历史', '')
    for (const version of versions) {
      lines.push(`### v${version.version_no} · ${version.source}`, '', version.text, '')
    }
    const markdown = redactCredentialValueForDb(db, lines.join('\n'))
    return new Response(markdown, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${base}.md"`,
      },
    })
  }
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${base}.json"`,
    },
  })
}
