"""구글 시트(Apps Script 웹 앱)와 통신하는 부분.

- ApiClient: 실제 시트에 연결 (웹 앱 URL + 토큰)
- DemoClient: 연결 없이 샘플 데이터로 동작 (포트폴리오 시연용)
두 클래스는 call(action, params) 하나로 같은 모양의 결과를 돌려줌.
"""
import copy
import datetime as dt
import random
import time

import requests

# 수집 실행은 Apps Script 6분 제한까지 걸릴 수 있어 넉넉히 기다림
LONG_ACTIONS = {"run_weekly", "run_keywords", "apply_reviews"}
LONG_TIMEOUT = 420
SHORT_TIMEOUT = 60


class ApiError(Exception):
    pass


class ApiClient:
    def __init__(self, url: str, token: str):
        self.url = url.strip()
        self.token = token.strip()

    def call(self, action: str, params: dict | None = None):
        if not self.url or not self.token:
            raise ApiError("설정 탭에서 웹 앱 URL과 토큰을 먼저 입력하세요")
        timeout = LONG_TIMEOUT if action in LONG_ACTIONS else SHORT_TIMEOUT
        try:
            # Apps Script 웹 앱은 302로 결과 주소를 돌려줌 → requests가 자동으로 따라감
            res = requests.post(
                self.url,
                json={"token": self.token, "action": action, "params": params or {}},
                timeout=timeout,
            )
        except requests.Timeout:
            raise ApiError("응답 시간이 초과됐습니다. 시트의 할 일 탭에서 결과를 확인하세요")
        except requests.RequestException as e:
            raise ApiError(f"연결 실패: {e}")
        try:
            body = res.json()
        except ValueError:
            hint = ""
            if "accounts.google.com" in res.url or "<html" in res.text[:200].lower():
                hint = " (웹 앱 액세스 권한이 '모든 사용자'인지, URL이 /exec로 끝나는지 확인)"
            raise ApiError(f"응답이 JSON이 아닙니다 (HTTP {res.status_code}){hint}")
        if not body.get("ok"):
            raise ApiError(body.get("error") or "알 수 없는 오류")
        return body.get("data")


# ---------------- 데모 모드 ----------------

HR_FUNCS = ["채용", "교육·육성", "평가·보상", "조직문화", "HR 운영", "정책·규제"]


def _now(days_ago=0, hour=8):
    d = dt.datetime.now() - dt.timedelta(days=days_ago)
    return d.replace(hour=hour, minute=0).strftime("%Y-%m-%d %H:%M")


def _demo_cases():
    # 시연용 가상 기업 (실제 기업·기사 아님)
    base = [
        ("가람전자", "국내", "제조", "채용", "생성형 AI", "자기소개서 1차 검토에 생성형 AI 보조 도입", "지원자 급증으로 서류 검토 기간이 길어짐", "검토 기간 40% 단축", "AI는 보조, 최종 판단은 사람이라는 원칙을 공지한 점이 참고됨"),
        ("누리금융", "국내", "금융", "교육·육성", "챗봇", "신입 온보딩 질문에 답하는 사내 챗봇 운영", "반복 문의로 HR 담당자 업무 과중", "월 문의 처리 1,200건", "FAQ 정비가 챗봇 품질을 좌우함"),
        ("Brightwell Co.", "해외", "IT", "평가·보상", "예측·분석", "성과 데이터 기반 보상 시뮬레이션 도구 시범 도입", "보상 형평성 이슈 제기", "기사에 언급 없음", "설명 가능한 기준 공개가 신뢰의 전제임"),
        ("다온유통", "국내", "유통", "HR 운영", "자동화", "근태·휴가 신청 처리 자동화", "매장 인력 수작업 집계 부담", "처리 시간 월 30시간 절감", "현장 인력 친화적인 UI가 정착 요인"),
        ("고용노동 정책", "국내", "공공", "정책·규제", "생성형 AI", "채용 AI 활용 시 고지 의무 가이드라인 발표", "AI 면접 공정성 논란", "기사에 언급 없음", "AI 채용 도구 도입 전 고지 문구 준비 필요"),
        ("라온바이오", "국내", "바이오", "조직문화", "예측·분석", "익명 설문 텍스트 분석으로 조직 진단", "이직률 상승", "기사에 언급 없음", "분석 결과 공유 방식이 참여율에 영향"),
        ("Northpeak", "해외", "제조", "채용", "챗봇", "현장직 채용 지원 과정을 메신저 챗봇으로 전환", "모바일 지원 비중 증가", "지원 완료율 25% 상승", "지원 과정 단순화가 핵심"),
        ("마루건설", "국내", "건설", "교육·육성", "생성형 AI", "안전교육 자료를 생성형 AI로 다국어 변환", "외국인 근로자 비중 증가", "교육 자료 6개 언어 제공", "번역 검수 절차를 함께 설계해야 함"),
    ]
    rows = []
    for i, b in enumerate(base):
        rows.append({
            "수집일": _now(days_ago=i * 3), "기업기관명": b[0], "국가": b[1], "업종": b[2],
            "HR기능": b[3], "AI유형": b[4], "한줄요약": b[5], "도입배경": b[6],
            "결과수치": b[7], "시사점초안": b[8], "기사제목": f"[데모] {b[0]}, {b[5]}",
            "출처URL": "https://example.com/demo", "포스팅여부": "대기" if i < 3 else "게시완료",
        })
    return rows


DEMO_DRAFT = """[11월 3주차] HR×AI 사례 브리핑: 가람전자, 서류 검토에 생성형 AI 보조 도입

이번 주에는 채용 과정의 반복 업무를 AI로 덜어내려는 사례가 많았습니다. 공통적으로 'AI는 보조, 판단은 사람'이라는 원칙을 함께 내세웠습니다.

채용
[가람전자] 자기소개서 1차 검토에 생성형 AI 보조 도입
- HR 기능 / 활용 AI: 채용 / 생성형 AI
- 도입 배경: 지원자 급증으로 서류 검토 기간이 길어짐
- 결과: 검토 기간 40% 단축
- 시사점: AI 활용 원칙을 지원자에게 먼저 공지한 점이 참고됩니다
- 출처: https://example.com/demo

이번 주 한 줄 정리: 채용 AI는 '속도'보다 '투명성'이 먼저입니다.

※ AI로 수집·요약 후 직접 검수한 글입니다. (데모 데이터)"""


class DemoClient:
    """연결 없이 화면을 시연하기 위한 가짜 서버. 데이터는 프로그램을 끄면 초기화됨."""

    def __init__(self):
        self.cases = _demo_cases()
        self.keywords = []
        for i, (k, lang, st, src, tot, rec, reason) in enumerate([
            ("AI 채용 도입", "ko", "사용", "기본", 6, 2, ""),
            ("AI 면접", "ko", "사용", "기본", 4, 1, ""),
            ("사내 AI 교육", "ko", "사용", "기본", 3, 1, ""),
            ("AI 인사관리", "ko", "사용", "기본", 2, 0, ""),
            ("AI in recruiting", "en", "사용", "기본", 3, 1, ""),
            ("채용 챗봇", "ko", "중지", "기본", 0, 0, ""),
            ("AI 보상 설계", "ko", "제안", "AI 제안", 0, 0, "평가·보상 사례가 적어 보강"),
            ("조직진단 AI", "ko", "제안", "AI 제안", 0, 0, "조직문화 사례 보강"),
        ]):
            self.keywords.append({"row": i + 2, "keyword": k, "lang": lang, "status": st, "source": src,
                                  "total": tot, "recent": rec, "reason": reason, "added": _now(10)})
        self.pending = [
            {"row": 40 + i, "date": _now(1), "keyword": kw, "score": sc, "reason": rs,
             "title": f"[데모] {t}", "url": "https://example.com/demo"}
            for i, (kw, sc, rs, t) in enumerate([
                ("AI 면접", 55, "[2차] 특정 기업 언급은 있으나 도입 여부 불명확", "바다물산, AI 면접 도입 검토"),
                ("AI 인사관리", 48, "[2차] 솔루션 홍보 성격이 섞여 있음", "HR SaaS 업체, 인사 AI 신기능 출시"),
                ("AI in recruiting", 62, "[2차] 설문 결과 위주, 개별 사례 부족", "Survey: 60% of HR leaders pilot AI"),
            ])
        ]
        self.last_run = _now(0)
        self.last_result = "채택 3건 · 보류 대기 3건 · 키워드 제안 2개 · 판별 38건 · AI 호출 9회 · 142초"

    # 실제 서버처럼 결과를 복사해서 돌려줌
    def call(self, action: str, params: dict | None = None):
        p = params or {}
        fn = getattr(self, "_" + action, None)
        if fn is None:
            raise ApiError(f"알 수 없는 요청: {action}")
        time.sleep(0.3)
        return copy.deepcopy(fn(p))

    def _ping(self, p):
        return {"version": "api-v1 (데모)", "sheet": "데모 데이터", "time": _now()}

    def _status(self, p):
        return {"lastRun": self.last_run, "lastResult": self.last_result, "cases": len(self.cases),
                "pending": len(self.pending),
                "suggested": sum(k["status"] == "제안" for k in self.keywords),
                "keywordsInUse": sum(k["status"] == "사용" for k in self.keywords)}

    def _keywords(self, p):
        return self.keywords

    def _keyword_add(self, p):
        k = str(p.get("keyword", "")).strip()
        if not k:
            raise ApiError("키워드가 비어 있습니다")
        if any(x["keyword"].lower() == k.lower() for x in self.keywords):
            raise ApiError(f"이미 있는 키워드입니다: {k}")
        self.keywords.append({"row": len(self.keywords) + 2, "keyword": k, "lang": p.get("lang", "ko"),
                              "status": "사용", "source": "직접 추가", "total": 0, "recent": 0,
                              "reason": "", "added": _now()})
        return self.keywords

    def _keyword_status(self, p):
        rows = {it["row"] for it in p.get("items", [])}
        for k in self.keywords:
            if k["row"] in rows:
                k["status"] = p["status"]
        return self.keywords

    def _simulate_run(self, label):
        time.sleep(2)
        n = random.randint(1, 3)
        self.last_run = _now()
        self.last_result = f"{label}: 채택 {n}건 · 판별 {random.randint(20, 40)}건 · 데모 실행"
        return n

    def _run_weekly(self, p):
        self._simulate_run("주간 수집")
        return self._status(p)

    def _run_keywords(self, p):
        names = p.get("names", [])
        if not names:
            raise ApiError("키워드를 하나 이상 고르세요")
        self._simulate_run(f"선택 실행({len(names)}개 키워드)")
        text = "\n".join(f"- {n}: 새 기사 {random.randint(2, 8)}건 → 채택 {random.randint(0, 2)} · 제외 {random.randint(1, 5)}"
                         for n in names)
        return {"text": text, "status": self._status(p)}

    def _pending(self, p):
        return self.pending

    def _review_set(self, p):
        rows = {it["row"] for it in p.get("items", [])}
        for x in self.pending:
            if x["row"] in rows:
                x["decision"] = p["decision"]
        return [x for x in self.pending if "decision" not in x] + [x for x in self.pending if "decision" in x]

    def _apply_reviews(self, p):
        done = [x for x in self.pending if "decision" in x]
        self.pending = [x for x in self.pending if "decision" not in x]
        return {"done": len(done), "status": self._status(p)}

    def _cases(self, p):
        return self.cases[: int(p.get("limit", 100))]

    def _draft(self, p):
        return {"latest": {"date": _now(), "text": DEMO_DRAFT},
                "history": [{"date": _now(), "text": DEMO_DRAFT}]}

    def _dashboard(self, p):
        by_func = {f: 0 for f in HR_FUNCS}
        by_type, by_country, by_week = {}, {}, {}
        for c in self.cases:
            by_func[c["HR기능"]] = by_func.get(c["HR기능"], 0) + 1
            by_type[c["AI유형"]] = by_type.get(c["AI유형"], 0) + 1
            by_country[c["국가"]] = by_country.get(c["국가"], 0) + 1
            d = dt.datetime.strptime(c["수집일"][:10], "%Y-%m-%d")
            wk = (d - dt.timedelta(days=d.weekday())).strftime("%Y-%m-%d")
            by_week[wk] = by_week.get(wk, 0) + 1
        return {"total": len(self.cases), "byFunc": by_func, "byType": by_type,
                "byCountry": by_country, "byWeek": by_week}
