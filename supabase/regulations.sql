-- ============================================================
-- 튜터 규정집 벡터 검색용 테이블 + 검색 함수
-- 실행: Supabase Dashboard > SQL Editor > 전체 붙여넣기 후 Run
-- (pgvector 확장은 kakao_messages에서 이미 사용 중이라 별도 설치 불필요)
-- ============================================================

-- ① 규정 청크 테이블 (조/항 단위)
DROP TABLE IF EXISTS regulation_chunks CASCADE;

CREATE TABLE regulation_chunks (
    id          BIGSERIAL PRIMARY KEY,
    chapter     TEXT,                 -- 예: "9. 지각 및 노쇼 규정"
    section     TEXT,                 -- 예: "9.3 학생 노쇼 규정" (장 인트로/표는 빈 문자열)
    content     TEXT NOT NULL,        -- 임베딩 대상 본문 (제목 breadcrumb 포함)
    embedding   vector(1536),         -- text-embedding-3-small
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ② 규정 유사도 검색 함수
CREATE OR REPLACE FUNCTION match_regulations(
  query_embedding vector(1536),
  match_count     int   DEFAULT 5,
  match_threshold float DEFAULT 0.3
)
RETURNS TABLE (
  id         bigint,
  chapter    text,
  section    text,
  content    text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    id,
    chapter,
    section,
    content,
    1 - (embedding <=> query_embedding) AS similarity
  FROM regulation_chunks
  WHERE embedding IS NOT NULL
    AND 1 - (embedding <=> query_embedding) > match_threshold
  ORDER BY embedding <=> query_embedding ASC
  LIMIT match_count;
$$;
