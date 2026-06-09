"""
튜터 규정집(.md) → 조/항 단위 청킹 → 임베딩 → Supabase regulation_chunks 적재.

선행 조건: supabase/regulations.sql 을 Supabase SQL Editor에서 1회 실행해 둘 것.
실행:    python scripts/ingest_regulations.py ["규정집.md 경로"]
모델:    text-embedding-3-small (1536d) — kakao_messages와 동일
키 출처: ../.env.local (OPENAI_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
"""

import json, os, sys, time, urllib.request, urllib.error

HERE     = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(HERE, "..", ".env.local")
DEFAULT_MD = r"C:\Users\QANDA_CX\Desktop\콴다과외_튜터_규정집.md"
TITLE    = "콴다과외 튜터 규정집"
BOM      = chr(0xFEFF)


def load_env(path):
    """.env.local 파싱 — 파일/값 BOM 모두 제거."""
    env = {}
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip().lstrip(BOM).strip()
    return env


def parse_chunks(md_text):
    """## 장 / ### 절 단위로 청킹. 제목·목차는 제외, 장 인트로/표는 절 없는 청크로."""
    chapter, section, buf, skip = "", "", [], False
    chunks = []

    def flush():
        nonlocal buf
        body = "\n".join(buf).strip()
        buf = []
        # chapter 없는 첫 ## 이전 내용(제목/메타)은 제외
        if body and not skip and chapter:
            chunks.append({"chapter": chapter, "section": section, "body": body})

    for line in md_text.splitlines():
        if line.startswith("## "):
            flush()
            chapter = line[3:].strip()
            section = ""
            skip = chapter == "목차"
        elif line.startswith("### "):
            flush()
            section = line[4:].strip()
        elif line.startswith("# "):          # 문서 제목 — 버림
            flush()
        else:
            buf.append(line)
    flush()
    return chunks


def main():
    md_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MD
    env = load_env(ENV_PATH)
    openai_key   = env["OPENAI_API_KEY"]
    supabase_url = env["NEXT_PUBLIC_SUPABASE_URL"]
    service_key  = env["SUPABASE_SERVICE_ROLE_KEY"]

    with open(md_path, encoding="utf-8-sig") as f:
        md_text = f.read()

    chunks = parse_chunks(md_text)
    print(f"청크 {len(chunks)}개 생성")
    for c in chunks[:3]:
        label = " > ".join(filter(None, [c["chapter"], c["section"]]))
        print(f"  - [{label}] ({len(c['body'])}자)")
    print("  ...")

    # 임베딩 대상 텍스트 = breadcrumb + 본문
    def to_content(c):
        crumb = " > ".join(filter(None, [TITLE, c["chapter"], c["section"]]))
        return f"[{crumb}]\n{c['body']}"

    contents = [to_content(c)[:6000] for c in chunks]

    from openai import OpenAI
    client = OpenAI(api_key=openai_key)
    print("임베딩 생성 중...")
    resp = client.embeddings.create(model="text-embedding-3-small", input=contents)
    embeddings = [d.embedding for d in resp.data]
    tokens = resp.usage.total_tokens
    print(f"임베딩 완료 — 토큰 {tokens} | 비용 ${tokens/1_000_000*0.02:.5f}")

    H = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }

    # 기존 규정 행만 비우기 (FAQ 등 다른 source는 보존, 재실행 멱등성)
    del_req = urllib.request.Request(
        f"{supabase_url}/rest/v1/regulation_chunks?chapter=neq.FAQ",
        headers={**H, "Prefer": "return=minimal"},
        method="DELETE",
    )
    try:
        urllib.request.urlopen(del_req, timeout=30)
        print("기존 regulation_chunks 비움")
    except urllib.error.HTTPError as e:
        print(f"기존 행 삭제 경고: {e.code} {e.read().decode('utf-8','replace')[:200]}")

    # 적재 (20행씩)
    rows = []
    for c, emb in zip(chunks, embeddings):
        rows.append({
            "chapter": c["chapter"],
            "section": c["section"],
            "content": to_content(c),
            "embedding": "[" + ",".join(f"{v:.8f}" for v in emb) + "]",
        })

    inserted = 0
    for i in range(0, len(rows), 20):
        batch = rows[i:i+20]
        body = json.dumps(batch).encode()
        req = urllib.request.Request(
            f"{supabase_url}/rest/v1/regulation_chunks",
            data=body,
            headers={**H, "Prefer": "return=minimal"},
            method="POST",
        )
        try:
            urllib.request.urlopen(req, timeout=30)
            inserted += len(batch)
            print(f"  적재 {inserted}/{len(rows)}")
        except urllib.error.HTTPError as e:
            print(f"  적재 오류: {e.code} {e.read().decode('utf-8','replace')[:300]}")
            sys.exit(1)
        time.sleep(0.05)

    print(f"\n완료: regulation_chunks {inserted}행 적재")


if __name__ == "__main__":
    main()
