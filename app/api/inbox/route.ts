import { cleanEnv } from '@/lib/env'

// 채널톡 Open API — 들어오는(진행중) 문의를 실시간으로 가져온다.
const BASE = 'https://api.channel.io/open/v5'

function authHeaders() {
  return {
    'x-access-key':    cleanEnv(process.env.CHANNELTALK_ACCESS_KEY),
    'x-access-secret': cleanEnv(process.env.CHANNELTALK_ACCESS_SECRET),
  }
}

// 채널톡 메시지 blocks → 평문
function textOfBlocks(blocks: any[]): string {
  if (!blocks) return ''
  const parts: string[] = []
  for (const b of blocks) {
    if (b?.type === 'text') parts.push(b.value ?? '')
    else if (b?.type === 'bullets')
      for (const it of b.blocks ?? []) parts.push('• ' + textOfBlocks(it.blocks ?? []))
  }
  return parts.filter(Boolean).join(' ')
}

export async function GET() {
  try {
    const headers = authHeaders()
    if (!headers['x-access-key'] || !headers['x-access-secret']) {
      return Response.json({ error: '채널톡 API 키가 설정되지 않았습니다.' }, { status: 500 })
    }

    // 1) 진행중(opened) 문의 목록 — 최신순
    const listRes = await fetch(
      `${BASE}/user-chats?state=opened&sortOrder=desc&limit=20`,
      { headers, cache: 'no-store' }
    )
    if (!listRes.ok) {
      const t = await listRes.text()
      return Response.json(
        { error: `채널톡 user-chats 오류: ${listRes.status} ${t.slice(0, 200)}` },
        { status: 502 }
      )
    }
    const data = await listRes.json()
    const chats: any[] = data.userChats ?? []
    const userMap: Record<string, any> = {}
    for (const u of data.users ?? []) userMap[u.id] = u

    // 2) 각 문의의 최근 메시지(병렬)
    const inquiries = await Promise.all(
      chats.map(async (c: any) => {
        let messages: { personType: string; text: string; createdAt: number }[] = []
        try {
          const mr = await fetch(
            `${BASE}/user-chats/${c.id}/messages?sortOrder=desc&limit=8`,
            { headers, cache: 'no-store' }
          )
          if (mr.ok) {
            const md = await mr.json()
            messages = (md.messages ?? [])
              .map((m: any) => ({
                personType: m.personType ?? '',
                text: m.plainText?.trim() ? m.plainText : textOfBlocks(m.blocks),
                createdAt: m.createdAt ?? 0,
              }))
              .filter((m: any) => m.text?.trim())
              .reverse() // 시간순(오래된→최신)
          }
        } catch {
          /* 메시지 조회 실패는 무시하고 문의 메타만 표시 */
        }
        const u = userMap[c.userId]
        const last = messages[messages.length - 1]
        return {
          id:       c.id,
          state:    c.state ?? '',
          tags:     c.tags ?? [],
          source:   c.source?.appMessenger?.mediumType ?? c.source?.type ?? '',
          userName: u?.name ?? u?.profile?.name ?? '익명',
          openedAt: c.openedAt ?? c.createdAt ?? 0,
          // 마지막 발화가 고객이면 답변 대기
          waitingForReply: last?.personType === 'user',
          messages,
        }
      })
    )

    return Response.json({ inquiries, fetchedAt: Date.now() })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[/api/inbox] error:', msg)
    return Response.json({ error: `서버 오류: ${msg}` }, { status: 500 })
  }
}
