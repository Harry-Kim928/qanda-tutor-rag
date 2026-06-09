"""카톡 첫 사용자 질문을 카테고리로 분류해 문의 유형 분포 산출."""
import os, json, urllib.request, collections

HERE = os.path.dirname(os.path.abspath(__file__))
env = {}
with open(os.path.join(HERE, "..", ".env.local"), encoding="utf-8-sig") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip().lstrip(chr(0xFEFF)).strip()

URL, KEY = env["NEXT_PUBLIC_SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}

CATS = [
    "매칭/배정", "온보딩·등록·계약", "채용·지원문의", "앱·로그인·기술오류",
    "레벨테스트", "교재(등록/확인)", "수업일정·변경·노쇼", "결제·환불·정산",
    "태블릿 대여", "수업진행·이용방법", "증명서·서류", "기타·노이즈",
]


def get_all(path):
    out, off = [], 0
    while True:
        req = urllib.request.Request(URL + "/rest/v1/" + path + f"&limit=1000&offset={off}", headers=H)
        with urllib.request.urlopen(req, timeout=60) as r:
            batch = json.loads(r.read())
        out += batch
        if len(batch) < 1000:
            break
        off += 1000
    return out


# 첫 사용자 메시지 per chat
msgs = get_all("kakao_messages?select=chat_id,text,created_at&person_type=eq.user&order=created_at.asc")
first = {}
for m in msgs:
    cid = m["chat_id"]
    if cid not in first and (m.get("text") or "").strip():
        first[cid] = m["text"].replace("\n", " ").strip()

# 노이즈 제거: 너무 짧거나 숫자/단일문자
def is_noise(t):
    s = t.strip()
    if len(s) < 6:
        return True
    if s.replace(" ", "").isdigit():
        return True
    return False

questions = [q for q in first.values() if not is_noise(q)]
noise_n = len(first) - len(questions)
print(f"전체 chat 첫질문: {len(first)} | 분석대상: {len(questions)} | 노이즈제외: {noise_n}")

from openai import OpenAI
client = OpenAI(api_key=env["OPENAI_API_KEY"])

cat_list = "\n".join(f"{i+1}. {c}" for i, c in enumerate(CATS))
counts = collections.Counter()
examples = collections.defaultdict(list)

B = 40
for i in range(0, len(questions), B):
    batch = questions[i:i+B]
    numbered = "\n".join(f"{j+1}. {q[:120]}" for j, q in enumerate(batch))
    prompt = (
        "다음은 QANDA 과외 튜터 고객센터에 들어온 문의 첫 메시지들이다.\n"
        f"각 문의를 아래 카테고리 중 하나의 번호로 분류하라.\n\n[카테고리]\n{cat_list}\n\n"
        f"[문의]\n{numbered}\n\n"
        '반드시 JSON만 출력: {"1": <카테고리번호>, "2": <번호>, ...} (문의 번호→카테고리 번호)'
    )
    resp = client.chat.completions.create(
        model="gpt-4o", temperature=0,
        response_format={"type": "json_object"},
        messages=[{"role": "user", "content": prompt}],
    )
    mapping = json.loads(resp.choices[0].message.content)
    for j, q in enumerate(batch):
        ci = mapping.get(str(j+1))
        try:
            cat = CATS[int(ci)-1]
        except (TypeError, ValueError, IndexError):
            cat = "기타·노이즈"
        counts[cat] += 1
        if len(examples[cat]) < 3:
            examples[cat].append(q[:70])
    print(f"  분류 {min(i+B,len(questions))}/{len(questions)}")

print("\n========== 문의 유형 분포 ==========")
total = sum(counts.values())
for cat in CATS:
    n = counts.get(cat, 0)
    if n == 0:
        continue
    bar = "█" * round(n / total * 40)
    print(f"{cat:<16} {n:>3}건 ({n/total*100:4.1f}%) {bar}")
    for ex in examples[cat]:
        print(f"      · {ex}")
