import { NextRequest } from 'next/server'
import OpenAI from 'openai'
import { embedQuery, retrieveContext, formatContext } from '@/lib/rag'
import { supabaseAdmin } from '@/lib/supabase-admin'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

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

  // 1) 임베딩 + 컨텍스트 검색
  const { embedding, tokens: embTokens } = await embedQuery(message)
  const contexts = await retrieveContext(embedding, 5)
  const context  = formatContext(contexts)

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
카카오톡 채널을 통해 접수된 실제 고객 상담 이력을 기반으로 답변합니다.

[관련 상담 사례]
${context}

답변 지침:
- 위 사례를 참고하여 구체적이고 실용적으로 답변하세요.
- 비슷한 과거 사례가 있다면 "과거에 유사한 사례로는..." 형식으로 언급하세요.
- 확실하지 않은 내용은 솔직히 말씀해주세요.
- 답변은 간결하고 실무에 바로 적용 가능하게 작성하세요.`

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

  // 3) 스트리밍 응답
  const contextMeta = JSON.stringify(
    contexts.map((c) => ({
      chatId:     c.chatId,
      similarity: Math.round(c.similarity * 100),
      tags:       c.chatMeta.tags,
      date:       c.chatMeta.openedAt
        ? new Date(c.chatMeta.openedAt).toLocaleDateString('ko-KR')
        : '',
    }))
  )

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(`__SOURCES__${contextMeta}\n`))

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
