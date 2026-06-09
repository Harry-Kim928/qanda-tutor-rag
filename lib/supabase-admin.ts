import { createClient } from '@supabase/supabase-js'

// 서버 전용 — API route에서만 import할 것 (브라우저 노출 금지)
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)
