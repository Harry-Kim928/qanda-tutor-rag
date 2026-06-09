import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'QANDA 튜터 지원 AI',
  description: '카카오톡 상담 이력 기반 튜터 전용 AI',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  )
}
