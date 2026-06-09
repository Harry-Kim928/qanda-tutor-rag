"""
Notion 공개 FAQ 데이터베이스 → 질문/답변 텍스트 → 임베딩 → regulation_chunks(chapter='FAQ') 적재.

각 FAQ 행: 제목=질문, 키워드=태그, 본문 child blocks=답변(텍스트).
실행: python scripts/ingest_faq.py   (UTF-8: python -X utf8 ...)
규정과 같은 테이블을 공유하되 chapter='FAQ'로 구분 → 검색 시 함께 노출.
"""
import json, os, sys, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(HERE, "..", ".env.local")
RAW = "ab1178caa2a882289181817924128214"
PAGE = f"{RAW[0:8]}-{RAW[8:12]}-{RAW[12:16]}-{RAW[16:20]}-{RAW[20:32]}"
BOM = chr(0xFEFF)
UA = {"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}


def load_env(path):
    env = {}
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip().lstrip(BOM).strip()
    return env


def notion_post(endpoint, payload):
    req = urllib.request.Request("https://www.notion.so/api/v3/" + endpoint,
                                 data=json.dumps(payload).encode(), headers=UA, method="POST")
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read())


def real(bid, store):
    e = store.get(bid, {})
    v = e.get("value", {})
    return v.get("value", v) if isinstance(v, dict) else {}


def text_of(props, key="title"):
    if not props or key not in props:
        return ""
    return "".join(s[0] for s in props[key] if s and isinstance(s[0], str))


# 블록 타입별 답변 텍스트 재구성
PREFIX = {
    "bulleted_list": "- ", "numbered_list": "- ", "to_do": "- ",
    "toggle": "", "quote": "> ", "callout": "", "header": "",
    "sub_header": "", "sub_sub_header": "", "text": "",
}

def render(bid, store, depth=0, out=None):
    if out is None:
        out = []
    v = real(bid, store)
    t = v.get("type", "")
    txt = text_of(v.get("properties"))
    if t in PREFIX and txt.strip():
        out.append("  " * depth + PREFIX[t] + txt.strip())
    elif t == "image":
        cap = text_of(v.get("properties"), "caption")
        out.append("  " * depth + (f"[이미지: {cap}]" if cap else "[이미지]"))
    for cid in v.get("content", []):
        render(cid, store, depth + (1 if t == "toggle" else 0), out)
    return out


def main():
    env = load_env(ENV_PATH)
    url, key = env["NEXT_PUBLIC_SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]

    # 1) 페이지 로드 → collection/view/space id
    page = notion_post("loadPageChunk", {"pageId": PAGE, "limit": 200,
                                          "cursor": {"stack": []}, "chunkNumber": 0, "verticalColumns": False})
    pblocks = page["recordMap"]["block"]
    space_id = real(PAGE, pblocks).get("space_id", "")
    cv_id = next(b for b in pblocks if real(b, pblocks).get("type") == "collection_view")
    cv = real(cv_id, pblocks)
    coll_id = cv.get("collection_id") or cv.get("format", {}).get("collection_pointer", {}).get("id")
    view_id = (cv.get("view_ids") or [None])[0]
    coll = real(coll_id, page["recordMap"]["collection"])
    kw_col = next((cid for cid, c in coll["schema"].items() if c["name"] == "키워드"), None)

    # 2) 행 목록
    qres = notion_post("queryCollection?src=initial_load", {
        "source": {"type": "collection", "id": coll_id, "spaceId": space_id},
        "collectionView": {"id": view_id, "spaceId": space_id},
        "loader": {"reducers": {"collection_group_results": {"type": "results", "limit": 200}},
                   "searchQuery": "", "userTimeZone": "Asia/Seoul", "type": "reducer"},
    })
    rblocks = qres["recordMap"]["block"]
    rids = []
    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                walk(v) if k != "blockIds" else rids.extend(v)
        elif isinstance(o, list):
            for x in o:
                walk(x)
    walk(qres.get("result", {}))
    print(f"FAQ 행 {len(rids)}개")

    # 3) 각 행의 질문 + 키워드 + 답변(본문 child) 가져오기
    faqs = []
    for rid in rids:
        rv = real(rid, rblocks)
        title = text_of(rv.get("properties"), "title")
        kw = text_of(rv.get("properties"), kw_col) if kw_col else ""
        # 행 페이지 본문 로드
        rowpage = notion_post("loadPageChunk", {"pageId": rid, "limit": 200,
                                                "cursor": {"stack": []}, "chunkNumber": 0, "verticalColumns": False})
        rpb = rowpage["recordMap"]["block"]
        answer_lines = []
        for cid in real(rid, rpb).get("content", []):
            render(cid, rpb, 0, answer_lines)
        answer = "\n".join(answer_lines).strip()
        faqs.append({"title": title, "kw": kw, "answer": answer})
        print(f"  - {title[:50]} (답변 {len(answer)}자)")
        time.sleep(0.1)

    # 4) 임베딩 텍스트 구성
    def to_content(f):
        head = f"[자주 묻는 질문(FAQ) > {f['title']}]"
        if f["kw"]:
            head += f"\n(키워드: {f['kw']})"
        return f"{head}\n{f['answer']}"[:6000]

    contents = [to_content(f) for f in faqs]
    from openai import OpenAI
    client = OpenAI(api_key=env["OPENAI_API_KEY"])
    print("임베딩 생성 중...")
    resp = client.embeddings.create(model="text-embedding-3-small", input=contents)
    embs = [d.embedding for d in resp.data]
    print(f"임베딩 완료 — 토큰 {resp.usage.total_tokens} | 비용 ${resp.usage.total_tokens/1_000_000*0.02:.5f}")

    H = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    # 기존 FAQ 행만 비우기
    try:
        urllib.request.urlopen(urllib.request.Request(
            f"{url}/rest/v1/regulation_chunks?chapter=eq.FAQ",
            headers={**H, "Prefer": "return=minimal"}, method="DELETE"), timeout=30)
        print("기존 FAQ 행 비움")
    except urllib.error.HTTPError as e:
        print("삭제 경고:", e.code, e.read().decode("utf-8", "replace")[:150])

    rows = [{"chapter": "FAQ", "section": f["title"], "content": to_content(f),
             "embedding": "[" + ",".join(f"{v:.8f}" for v in emb) + "]"}
            for f, emb in zip(faqs, embs)]
    body = json.dumps(rows).encode()
    try:
        urllib.request.urlopen(urllib.request.Request(
            f"{url}/rest/v1/regulation_chunks", data=body,
            headers={**H, "Prefer": "return=minimal"}, method="POST"), timeout=40)
        print(f"\n완료: FAQ {len(rows)}행 적재")
    except urllib.error.HTTPError as e:
        print("적재 오류:", e.code, e.read().decode("utf-8", "replace")[:300])
        sys.exit(1)


if __name__ == "__main__":
    main()
