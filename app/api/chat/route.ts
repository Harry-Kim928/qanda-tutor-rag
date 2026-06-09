import { NextRequest } from 'next/server'
import OpenAI from 'openai'
import {
  embedQuery,
  retrieveContext,
  formatContext,
  retrieveRegulations,
  formatRegulations,
} from '@/lib/rag'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cleanEnv } from '@/lib/env'

const openai = new OpenAI({ apiKey: cleanEnv(process.env.OPENAI_API_KEY) })

// 비용 한도 (USD) — 임베딩 + 채팅 합산
const LIMITS = { openai: 5.00 }

// 단가 (USD per token)
const PRICE = {
  embed:  0.02  / 1_000_000,   // text-embedding-3-small
  input:  2.50  / 1_000_000,   // gpt-4o input
  output: 10.00 / 1_000_000,   // gpt-4o output
}

async function getUsage(): Promise<Record<string, number>> {
  const { data } = await supabaseAdmin
    .from('api_usage')
    .select('provider, total_cost_usd')
  return Object.fromEntries((data ?? []).map((r: any) => [r.provider, Number(r.total_cost_usd)]))
}

async function trackUsage(provider: string, tokens: number, cost: number) {
  await supabaseAdmin.rpc('increment_usage', {
    p_provider: provider,
    p_tokens:   tokens,
    p_cost:     cost,
  })
}

export async function POST(req: NextRequest) {
  try {
  const { message, history = [] } = await req.json()
  if (!message?.trim()) {
    return new Response('메시지를 입력해주세요.', { status: 400 })
  }

  // 한도 체크
  const usage = await getUsage()
  if ((usage.openai ?? 0) >= LIMITS.openai) {
    return new Response(
      `OpenAI 사용량 한도 초과 (현재 $${(usage.openai ?? 0).toFixed(4)} / 한도 $${LIMITS.openai})`,
      { status: 429 }
    )
  }

  // 1) 임베딩 1회 → 규정·사례 병렬 검색
  const { embedding, tokens: embTokens } = await embedQuery(message)
  const [regulations, contexts] = await Promise.all([
    retrieveRegulations(embedding, 6),
    retrieveContext(embedding, 5),
  ])
  const regulationText = formatRegulations(regulations)
  const context        = formatContext(contexts)

  // 임베딩 사용량 기록 (비동기)
  trackUsage('openai', embTokens, embTokens * PRICE.embed)

  // 히스토리 정제: 빈 메시지·연속 동일 role 제거
  type MsgParam = { role: 'user' | 'assistant'; content: string }
  const cleanHistory = (history as MsgParam[])
    .filter((m) => m.content?.trim())
    .reduce<MsgParam[]>((acc, m) => {
      if (acc.length > 0 && acc[acc.length - 1].role === m.role) {
        acc[acc.length - 1] = m
      } else {
        acc.push(m)
      }
      return acc
    }, [])

  const systemPrompt = `당신은 QANDA 튜터를 지원하는 AI 어시스턴트입니다.
답변은 공식 규정·FAQ(정답의 근거, 최우선)와 과거 상담 사례(톤·예시용 보조)에 근거합니다.

[공식 규정·FAQ — 정답의 근거 (최우선)]
${regulationText}

[참고 상담 사례 — 톤·예시용 (보조)]
${context}

답변 지침:
1. 규정·FAQ에 명시된 내용은 반드시 그것을 근거로 답하고, 해당 장·조항이나 FAQ 항목을 함께 인용하세요. (예: "페널티 규정 제9조에 따르면…", "「9.3 학생 노쇼 규정」상…", "「FAQ: 수업료는 언제 정산되나요?」")
2. 규정·FAQ와 사례가 충돌하면 항상 공식 규정·FAQ를 따르세요. 사례는 보완하는 예시로만 활용합니다.
3. 규정·FAQ에 근거가 없는 내용은 추측하지 말고, "공식 규정·FAQ에서 확인되지 않는 내용입니다. 운영팀 확인이 필요합니다."라고 답하세요.
4. 사례를 인용할 때는 "과거 유사 사례로는…" 형식으로 참고임을 명확히 하세요.
5. 답변은 간결하고 실무에 바로 적용 가능하게 작성하세요.
6. QANDA 튜터 업무(규정·수업·매칭·정산·앱·온보딩 등)와 무관한 일반 질문(잡담, 일반상식, 메뉴 추천 등 개인적 질문)에는 내용을 답하지 말고, "죄송하지만 QANDA 튜터 업무와 관련된 질문에만 답변드릴 수 있어요."라고만 답하세요.`

  // 2) GPT-4o 스트리밍
  const stream = openai.chat.completions.stream({
    model: 'gpt-4o',
    max_tokens: 1024,
    stream_options: { include_usage: true },
    messages: [
      { role: 'system', content: systemPrompt },
      ...cleanHistory.slice(-10),
      { role: 'user', content: message },
    ],
  })

  // 3) 스트리밍 응답 — 규정 출처를 먼저, 사례 출처를 뒤에
  const sourcesMeta = JSON.stringify([
    ...regulations.map((r) => ({
      type:       (r.chapter === 'FAQ' ? 'faq' : 'regulation') as 'faq' | 'regulation',
      label:      r.section || r.chapter || '규정',
      similarity: Math.round(r.similarity * 100),
    })),
    ...contexts.map((c) => ({
      type:       'case' as const,
      chatId:     c.chatId,
      similarity: Math.round(c.similarity * 100),
      tags:       c.chatMeta.tags,
      date:       c.chatMeta.openedAt
        ? new Date(c.chatMeta.openedAt).toLocaleDateString('ko-KR')
        : '',
    })),
  ])

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(`__SOURCES__${sourcesMeta}\n`))

        let inputTokens  = 0
        let outputTokens = 0

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content
          if (delta) controller.enqueue(encoder.encode(delta))
          // 마지막 청크에 usage 포함 (stream_options.include_usage: true)
          if (chunk.usage) {
            inputTokens  = chunk.usage.prompt_tokens
            outputTokens = chunk.usage.completion_tokens
          }
        }

        controller.close()

        if (inputTokens > 0 || outputTokens > 0) {
          const cost = inputTokens * PRICE.input + outputTokens * PRICE.output
          trackUsage('openai', inputTokens + outputTokens, cost)
        }
      } catch (err) {
        console.error('[/api/chat] stream error:', err)
        const errMsg = err instanceof Error ? err.message : String(err)
        try {
          controller.enqueue(encoder.encode(`\n__STREAM_ERROR__${errMsg}`))
          controller.close()
        } catch { /* controller already closed */ }
      }
    },
  })

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[/api/chat] handler error:', msg)
    return new Response(`서버 오류: ${msg}`, { status: 500 })
  }
}
