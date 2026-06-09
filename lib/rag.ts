import OpenAI from 'openai'
import { supabaseAdmin } from './supabase-admin'
import { cleanEnv } from './env'

const openai = new OpenAI({ apiKey: cleanEnv(process.env.OPENAI_API_KEY) })

export interface MatchedContext {
  chatId: string
  similarity: number
  messages: { personType: string; text: string; createdAt: string }[]
  chatMeta: { state: string; tags: string[]; openedAt: string; closedAt: string }
}

export interface RegulationContext {
  chapter: string
  section: string
  content: string
  similarity: number
}

// 1) 질문 임베딩 생성 (토큰 수 함께 반환)
export async function embedQuery(text: string): Promise<{ embedding: number[]; tokens: number }> {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 6000),
  })
  return { embedding: res.data[0].embedding, tokens: res.usage.total_tokens }
}

// 1-b) 규정집 청크 검색 (정답 근거 — 사례보다 우선)
export async function retrieveRegulations(
  queryEmbedding: number[],
  matchCount = 4
): Promise<RegulationContext[]> {
  const { data, error } = await supabaseAdmin.rpc('match_regulations', {
    query_embedding: queryEmbedding,
    match_count: matchCount,
    match_threshold: 0.3,
  })
  if (error || !data?.length) return []
  return (data as any[]).map((r) => ({
    chapter: r.chapter ?? '',
    section: r.section ?? '',
    content: r.content ?? '',
    similarity: (r.similarity as number) ?? 0,
  }))
}

// 2) 유사 메시지 검색 후 전체 대화 컨텍스트 반환
export async function retrieveContext(
  queryEmbedding: number[],
  matchCount = 5
): Promise<MatchedContext[]> {
  const { data: matches, error } = await supabaseAdmin.rpc('match_messages', {
    query_embedding: queryEmbedding,
    match_count: matchCount,
    match_threshold: 0.3,
  })
  if (error || !matches?.length) return []

  // 중복 chatId 제거
  const chatIds: string[] = [...new Set<string>(matches.map((m: any) => String(m.chat_id)))]

  // 각 대화의 전체 메시지 + 메타데이터 조회
  const contexts: MatchedContext[] = []
  for (const chatId of chatIds.slice(0, 4) as string[]) {
    const [{ data: msgs }, { data: chatArr }] = await Promise.all([
      supabaseAdmin
        .from('kakao_messages')
        .select('person_type, text, created_at')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: true })
        .limit(30),
      supabaseAdmin
        .from('kakao_chats')
        .select('state, tags, opened_at, closed_at')
        .eq('id', chatId)
        .limit(1),
    ])
    if (!msgs?.length) continue
    const chat = chatArr?.[0]
    const matchSimilarity = (matches.find((m: any) => m.chat_id === chatId)?.similarity as number) ?? 0
    contexts.push({
      chatId,
      similarity: matchSimilarity,
      messages: msgs.map((m) => ({
        personType: m.person_type,
        text: m.text || '',
        createdAt: m.created_at,
      })),
      chatMeta: {
        state: chat?.state ?? '',
        tags: chat?.tags ?? [],
        openedAt: chat?.opened_at ?? '',
        closedAt: chat?.closed_at ?? '',
      },
    })
  }
  return contexts
}

// 3-b) 규정 컨텍스트 문자열 포맷 (조항 제목 + 본문)
export function formatRegulations(regs: RegulationContext[]): string {
  if (!regs.length) return '관련 규정 없음'
  return regs
    .map((r) => {
      // content에는 이미 [제목 breadcrumb]\n본문 형태가 들어 있음
      return r.content?.trim() || `${r.chapter} ${r.section}`.trim()
    })
    .join('\n\n---\n\n')
}

// 3) Claude 프롬프트용 컨텍스트 문자열 포맷
export function formatContext(contexts: MatchedContext[]): string {
  if (!contexts.length) return '관련 상담 이력 없음'
  return contexts
    .map((ctx, i) => {
      const date = ctx.chatMeta.openedAt
        ? new Date(ctx.chatMeta.openedAt).toLocaleDateString('ko-KR')
        : ''
      const tags = ctx.chatMeta.tags?.length ? `태그: ${ctx.chatMeta.tags.join(', ')}` : ''
      const header = [`[사례 ${i + 1}]`, date, tags].filter(Boolean).join(' | ')
      const convo = ctx.messages
        .filter((m) => m.text?.trim())
        .map((m) => `${m.personType === 'user' ? '고객' : '상담사'}: ${m.text}`)
        .join('\n')
      return `${header}\n${convo}`
    })
    .join('\n\n---\n\n')
}
