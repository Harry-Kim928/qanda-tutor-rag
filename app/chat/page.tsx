'use client'

import { useEffect, useRef, useState } from 'react'

interface Message {
  role: 'user' | 'assistant'
  content: string
  sources?: Source[]
}

interface Source {
  chatId: string
  similarity: number
  tags: string[]
  date: string
}

export default function ChatPage() {
  const bottomRef = useRef<HTMLDivElement>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input,    setInput]    = useState('')
  const [loading,  setLoading]  = useState(false)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function send() {
    if (!input.trim() || loading) return
    const userMsg = input.trim()
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: userMsg }])
    setLoading(true)

    const history = messages.slice(-10).map((m) => ({
      role: m.role,
      content: m.content,
    }))

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg, history }),
      })
      if (!res.ok || !res.body) throw new Error('오류가 발생했습니다.')

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let assistantText = ''
      let sources: Source[] = []
      let firstChunk = true

      setMessages((prev) => [...prev, { role: 'assistant', content: '' }])

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value)

        if (firstChunk && chunk.startsWith('__SOURCES__')) {
          const nl = chunk.indexOf('\n')
          const meta = chunk.slice('__SOURCES__'.length, nl)
          sources = JSON.parse(meta)
          assistantText += chunk.slice(nl + 1)
          firstChunk = false
        } else {
          assistantText += chunk
          firstChunk = false
        }

        // 스트림 에러 마커 감지 즉시 중단
        if (assistantText.includes('\n__STREAM_ERROR__')) {
          const errIdx = assistantText.indexOf('\n__STREAM_ERROR__')
          assistantText = assistantText.slice(0, errIdx)
          throw new Error('AI 응답 중 오류가 발생했습니다.')
        }

        setMessages((prev) => {
          const updated = [...prev]
          updated[updated.length - 1] = {
            role: 'assistant',
            content: assistantText,
            sources,
          }
          return updated
        })
      }
    } catch (e: any) {
      console.error('[chat] send error:', e)
      setMessages((prev) => {
        const copy = [...prev]
        const last = copy[copy.length - 1]
        const errorMsg = { role: 'assistant' as const, content: '오류가 발생했습니다. 다시 시도해주세요.' }
        if (last?.role === 'assistant' && !last.content) {
          copy[copy.length - 1] = errorMsg
        } else {
          copy.push(errorMsg)
        }
        return copy
      })
    }
    setLoading(false)
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* 헤더 */}
      <header className="bg-white border-b px-4 py-3 flex items-center shadow-sm">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
            <span className="text-white font-bold text-sm">Q</span>
          </div>
          <div>
            <h1 className="font-semibold text-gray-900 text-sm">QANDA 튜터 지원 AI</h1>
            <p className="text-xs text-gray-500">카카오톡 상담 이력 기반</p>
          </div>
        </div>
      </header>

      {/* 메시지 목록 */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4 max-w-3xl mx-auto w-full">
        {messages.length === 0 && (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">💬</div>
            <p className="text-gray-600 font-medium">카카오톡 상담 이력을 기반으로 답변합니다</p>
            <p className="text-gray-400 text-sm mt-1">환불 처리, 수업 변경, 민원 대응 등을 물어보세요</p>
            <div className="mt-6 flex flex-wrap gap-2 justify-center">
              {['환불 요청 처리 방법', '튜터 변경 요청', '수업료 문의 대응', '불만 고객 응대'].map((q) => (
                <button
                  key={q}
                  onClick={() => { setInput(q); }}
                  className="text-sm bg-white border border-gray-200 text-gray-600 px-3 py-1.5 rounded-full hover:bg-blue-50 hover:border-blue-300 hover:text-blue-600 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] ${msg.role === 'user' ? 'order-1' : ''}`}>
              {msg.role === 'assistant' && (
                <div className="flex items-center gap-1.5 mb-1">
                  <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center">
                    <span className="text-white text-xs font-bold">Q</span>
                  </div>
                  <span className="text-xs text-gray-500">AI 어시스턴트</span>
                </div>
              )}
              <div
                className={`px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white rounded-tr-sm'
                    : 'bg-white border border-gray-100 text-gray-800 rounded-tl-sm shadow-sm'
                }`}
              >
                {msg.content}
                {msg.role === 'assistant' && loading && i === messages.length - 1 && (
                  <span className="inline-block w-1 h-4 bg-blue-500 animate-pulse ml-0.5 align-text-bottom" />
                )}
              </div>

              {/* 출처 카드 */}
              {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {msg.sources.map((src) => (
                    <div
                      key={src.chatId}
                      className="flex items-center gap-1.5 bg-gray-100 text-gray-500 text-xs px-2.5 py-1 rounded-full"
                    >
                      <span className="text-blue-500 font-medium">{src.similarity}% 유사</span>
                      {src.date && <span>{src.date}</span>}
                      {src.tags?.slice(0, 1).map((t) => (
                        <span key={t} className="bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded text-xs">
                          {t}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* 입력창 */}
      <div className="bg-white border-t px-4 py-3">
        <div className="max-w-3xl mx-auto flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()}
            placeholder="질문을 입력하세요 (예: 환불 요청이 들어왔을 때 어떻게 처리하나요?)"
            className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-gray-50"
            disabled={loading}
          />
          <button
            onClick={send}
            disabled={loading || !input.trim()}
            className="bg-blue-600 text-white px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            전송
          </button>
        </div>
      </div>
    </div>
  )
}
