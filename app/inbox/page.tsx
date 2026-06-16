'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'

interface InboxMessage {
  personType: string
  text: string
  createdAt: number
}
interface Inquiry {
  id: string
  state: string
  tags: string[]
  source: string
  userName: string
  openedAt: number
  waitingForReply: boolean
  messages: InboxMessage[]
}

function relativeTime(ms: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  const min = Math.floor(diff / 60000)
  if (min < 1) return '방금'
  if (min < 60) return `${min}분 전`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}시간 전`
  return `${Math.floor(hr / 24)}일 전`
}

const SOURCE_LABEL: Record<string, string> = {
  appKakao: '카카오톡',
}

export default function InboxPage() {
  const [inquiries, setInquiries] = useState<Inquiry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [fetchedAt, setFetchedAt] = useState<number>(0)

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch('/api/inbox', { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '문의를 불러오지 못했습니다.')
      setInquiries(data.inquiries ?? [])
      setFetchedAt(data.fetchedAt ?? Date.now())
    } catch (e: any) {
      setError(e.message || '오류가 발생했습니다.')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 30000) // 30초마다 자동 새로고침
    return () => clearInterval(t)
  }, [load])

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* 헤더 */}
      <header className="bg-white border-b px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
            <span className="text-white font-bold text-sm">Q</span>
          </div>
          <div>
            <h1 className="font-semibold text-gray-900 text-sm">실시간 문의함</h1>
            <p className="text-xs text-gray-500">
              채널톡 진행중 문의 {inquiries.length}건
              {fetchedAt ? ` · ${new Date(fetchedAt).toLocaleTimeString('ko-KR')} 기준` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setLoading(true); load() }}
            className="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-lg hover:bg-gray-200 transition-colors"
          >
            새로고침
          </button>
          <Link href="/chat" className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition-colors">
            AI 어시스턴트
          </Link>
        </div>
      </header>

      {/* 목록 */}
      <div className="flex-1 overflow-y-auto px-4 py-5 space-y-3 max-w-3xl mx-auto w-full">
        {loading && inquiries.length === 0 && (
          <p className="text-center text-gray-400 text-sm py-16">불러오는 중...</p>
        )}
        {error && (
          <p className="text-center text-red-500 text-sm py-16">{error}</p>
        )}
        {!loading && !error && inquiries.length === 0 && (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">📭</div>
            <p className="text-gray-600 font-medium">진행중인 문의가 없습니다</p>
          </div>
        )}

        {inquiries.map((q) => (
          <div key={q.id} className="bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden">
            {/* 카드 헤더 */}
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-50 flex-wrap">
              <span className="font-medium text-gray-800 text-sm">{q.userName}</span>
              {q.source && (
                <span className="bg-yellow-100 text-yellow-700 text-xs px-1.5 py-0.5 rounded">
                  {SOURCE_LABEL[q.source] || q.source}
                </span>
              )}
              {q.waitingForReply && (
                <span className="bg-red-100 text-red-600 text-xs px-1.5 py-0.5 rounded font-medium">
                  답변 대기
                </span>
              )}
              {q.tags?.slice(0, 2).map((t) => (
                <span key={t} className="bg-blue-50 text-blue-600 text-xs px-1.5 py-0.5 rounded">{t}</span>
              ))}
              <span className="ml-auto text-xs text-gray-400">{relativeTime(q.openedAt)}</span>
            </div>

            {/* 메시지 스레드 */}
            <div className="px-4 py-3 space-y-2">
              {q.messages.length === 0 && (
                <p className="text-xs text-gray-400">메시지 미리보기를 불러올 수 없습니다.</p>
              )}
              {q.messages.map((m, i) => {
                const isUser = m.personType === 'user'
                return (
                  <div key={i} className={`flex ${isUser ? 'justify-start' : 'justify-end'}`}>
                    <div className="max-w-[80%]">
                      <div className={`text-[10px] mb-0.5 ${isUser ? 'text-gray-400' : 'text-blue-400 text-right'}`}>
                        {isUser ? '고객' : '상담사'}
                      </div>
                      <div
                        className={`px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap leading-relaxed ${
                          isUser
                            ? 'bg-gray-100 text-gray-800 rounded-tl-sm'
                            : 'bg-blue-600 text-white rounded-tr-sm'
                        }`}
                      >
                        {m.text}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
