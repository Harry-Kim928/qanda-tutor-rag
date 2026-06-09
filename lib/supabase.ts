import { createClient } from '@supabase/supabase-js'

const url  = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// 브라우저용 (Auth 포함) — NEXT_PUBLIC_ 키만 사용
export const supabase = createClient(url, anon)
