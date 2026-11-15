"""HR×AI 관리 도구 (데스크탑)

구글 시트 'HR+AI issue'의 자동화(Apps Script v4.6)를 데스크탑 창에서 조작함.
- 홈: 마지막 실행 결과, 주요 숫자, 수집 실행
- 키워드: 상태 변경, 추가, 고른 키워드로 수집
- 보류 검토: 사람판정 입력 후 반영
- 사례 / 초안 / 대시보드: 조회, 복사, CSV 저장
- 설정: 웹 앱 URL·토큰, 데모 모드
"""
import csv
import queue
import sys
import threading
import tkinter as tk
import traceback
import webbrowser
from tkinter import filedialog, messagebox, ttk
from tkinter import font as tkfont

import config
from api import ApiClient, ApiError, DemoClient

APP_TITLE = "HR×AI 관리 도구"
APP_VERSION = "1.0.0"

COLORS = {
    "bg": "#f6f7f9", "card": "#ffffff", "line": "#e3e6eb", "text": "#1f2328", "sub": "#656d76",
    "accent": "#2f6feb", "accent_dark": "#1f4fbf", "ok": "#1a7f37", "warn": "#bf8700", "bad": "#cf222e",
}
BAR_COLORS = ["#2f6feb", "#3fb68b", "#e8a33d", "#d65c8a", "#7b61d9", "#4aa3c8"]


def pick_font():
    if sys.platform.startswith("win"):
        return "Malgun Gothic"
    return "Noto Sans CJK KR"


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(f"{APP_TITLE} v{APP_VERSION}")
        self.geometry("1180x760")
        self.minsize(980, 640)
        self.configure(bg=COLORS["bg"])

        self.cfg = config.load()
        self.client = None
        self.busy = False
        self.jobs = queue.Queue()
        self.keywords = []
        self.pending = []
        self.cases = []
        self.drafts = []

        self._style()
        self._build()
        self._make_client()
        self.after(100, self._poll_jobs)
        self.after(200, self.refresh_all)

    # ---------- 공통 ----------

    def _style(self):
        f = pick_font()
        self.font = f
        for name in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont"):
            try:
                tkfont.nametofont(name).configure(family=f, size=10)
            except tk.TclError:
                pass
        s = ttk.Style(self)
        try:
            s.theme_use("clam")
        except tk.TclError:
            pass
        s.configure(".", font=(f, 10), background=COLORS["bg"], foreground=COLORS["text"])
        s.configure("TFrame", background=COLORS["bg"])
        s.configure("Card.TFrame", background=COLORS["card"], relief="solid", borderwidth=1)
        s.configure("TLabel", background=COLORS["bg"])
        s.configure("Card.TLabel", background=COLORS["card"])
        s.configure("Sub.TLabel", foreground=COLORS["sub"])
        s.configure("CardSub.TLabel", background=COLORS["card"], foreground=COLORS["sub"])
        s.configure("Big.TLabel", background=COLORS["card"], font=(f, 24, "bold"))
        s.configure("H1.TLabel", font=(f, 15, "bold"))
        s.configure("H2.TLabel", font=(f, 11, "bold"))
        s.configure("TButton", padding=(12, 6))
        s.configure("Accent.TButton", background=COLORS["accent"], foreground="#ffffff", padding=(14, 7))
        s.map("Accent.TButton", background=[("active", COLORS["accent_dark"]), ("disabled", "#9db7ef")])
        s.configure("TNotebook", background=COLORS["bg"], borderwidth=0)
        s.configure("TNotebook.Tab", padding=(16, 7), font=(f, 10))
        s.map("TNotebook.Tab", background=[("selected", COLORS["card"])])
        s.configure("Treeview", rowheight=26, font=(f, 10), background=COLORS["card"], fieldbackground=COLORS["card"])
        s.configure("Treeview.Heading", font=(f, 10, "bold"))
        s.configure("TCheckbutton", background=COLORS["bg"])

    def _build(self):
        top = ttk.Frame(self, padding=(16, 12, 16, 4))
        top.pack(fill="x")
        ttk.Label(top, text=APP_TITLE, style="H1.TLabel").pack(side="left")
        self.mode_lbl = ttk.Label(top, text="", style="Sub.TLabel")
        self.mode_lbl.pack(side="left", padx=12)
        self.status_lbl = ttk.Label(top, text="", style="Sub.TLabel")
        self.status_lbl.pack(side="right")
        self.progress = ttk.Progressbar(top, mode="indeterminate", length=140)  # 실행 중에만 보임

        self.nb = ttk.Notebook(self)
        self.nb.pack(fill="both", expand=True, padx=12, pady=(4, 12))
        self.run_buttons = []  # 실행 중엔 막아 둘 버튼들
        self._tab_home()
        self._tab_keywords()
        self._tab_pending()
        self._tab_cases()
        self._tab_draft()
        self._tab_dash()
        self._tab_settings()

    def _make_client(self):
        if self.cfg.get("demo"):
            self.client = DemoClient()
            self.mode_lbl.config(text="● 데모 모드 (샘플 데이터)", foreground=COLORS["warn"])
        else:
            self.client = ApiClient(self.cfg.get("url", ""), self.cfg.get("token", ""))
            self.mode_lbl.config(text="● 시트 연결 모드", foreground=COLORS["ok"])

    def run_async(self, action, params=None, on_ok=None, busy_msg=None, long=False):
        """서버 요청을 백그라운드로 보내고, 끝나면 on_ok(data)를 화면 스레드에서 실행."""
        if long and self.busy:
            messagebox.showinfo(APP_TITLE, "이미 실행 중인 작업이 있습니다. 끝난 뒤 다시 시도하세요.")
            return
        if long:
            self._set_busy(True, busy_msg or "실행 중…")
        client = self.client

        def work():
            try:
                data = client.call(action, params)
                self.jobs.put((on_ok, data, None, long))
            except ApiError as e:
                self.jobs.put((None, None, str(e), long))
            except Exception as e:  # 예상 못 한 오류도 화면에 표시
                traceback.print_exc()
                self.jobs.put((None, None, f"{type(e).__name__}: {e}", long))

        threading.Thread(target=work, daemon=True).start()

    def _poll_jobs(self):
        try:
            while True:
                on_ok, data, err, long = self.jobs.get_nowait()
                if long:
                    self._set_busy(False)
                if err:
                    self.log(f"오류: {err}")
                    self.status_lbl.config(text="오류 발생", foreground=COLORS["bad"])
                    if long:
                        messagebox.showerror(APP_TITLE, err)
                elif on_ok:
                    try:
                        on_ok(data)
                    except Exception as e:  # 화면 갱신 오류가 나도 다음 작업은 계속 처리
                        traceback.print_exc()
                        self.log(f"화면 갱신 오류: {e}")
        except queue.Empty:
            pass
        self.after(100, self._poll_jobs)

    def _set_busy(self, on, msg=""):
        self.busy = on
        for b in self.run_buttons:
            b.state(["disabled"] if on else ["!disabled"])
        if on:
            self.progress.pack(side="right", padx=8, after=self.status_lbl)
            self.progress.start(12)
            self.status_lbl.config(text=msg, foreground=COLORS["accent"])
            self.log(msg)
        else:
            self.progress.stop()
            self.progress.pack_forget()
            self.status_lbl.config(text="대기 중", foreground=COLORS["sub"])

    def log(self, text):
        import datetime as dt
        self.log_txt.configure(state="normal")
        self.log_txt.insert("end", f"[{dt.datetime.now():%H:%M:%S}] {text}\n")
        self.log_txt.see("end")
        self.log_txt.configure(state="disabled")

    def refresh_all(self):
        self.refresh_status()
        self.refresh_keywords()
        self.refresh_pending()
        self.refresh_cases()
        self.refresh_draft()
        self.refresh_dash()

    @staticmethod
    def _tree(parent, columns, widths, height=12):
        frame = ttk.Frame(parent)
        tree = ttk.Treeview(frame, columns=columns, show="headings", height=height, selectmode="extended")
        for c, w in zip(columns, widths):
            tree.heading(c, text=c)
            tree.column(c, width=w, anchor="w", stretch=(w >= 200))
        sb = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=sb.set)
        tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        return frame, tree

    # ---------- 홈 ----------

    def _tab_home(self):
        tab = ttk.Frame(self.nb, padding=16)
        self.nb.add(tab, text="  홈  ")

        cards = ttk.Frame(tab)
        cards.pack(fill="x")
        self.stat = {}
        for i, (key, label) in enumerate([("cases", "누적 사례"), ("pending", "보류 대기"),
                                          ("suggested", "키워드 제안"), ("keywordsInUse", "사용 중 키워드")]):
            c = ttk.Frame(cards, style="Card.TFrame", padding=(18, 14))
            c.grid(row=0, column=i, sticky="nsew", padx=(0 if i == 0 else 10, 0))
            cards.columnconfigure(i, weight=1)
            ttk.Label(c, text=label, style="CardSub.TLabel").pack(anchor="w")
            v = ttk.Label(c, text="-", style="Big.TLabel")
            v.pack(anchor="w")
            self.stat[key] = v

        info = ttk.Frame(tab, style="Card.TFrame", padding=(18, 14))
        info.pack(fill="x", pady=14)
        ttk.Label(info, text="마지막 실행", style="CardSub.TLabel").grid(row=0, column=0, sticky="w")
        self.last_run_lbl = ttk.Label(info, text="-", style="Card.TLabel")
        self.last_run_lbl.grid(row=0, column=1, sticky="w", padx=12)
        ttk.Label(info, text="결과", style="CardSub.TLabel").grid(row=1, column=0, sticky="w", pady=(6, 0))
        self.last_result_lbl = ttk.Label(info, text="-", style="Card.TLabel", wraplength=900)
        self.last_result_lbl.grid(row=1, column=1, sticky="w", padx=12, pady=(6, 0))

        bar = ttk.Frame(tab)
        bar.pack(fill="x")
        b1 = ttk.Button(bar, text="▶  지금 수집 실행", style="Accent.TButton", command=self.do_run_weekly)
        b1.pack(side="left")
        b2 = ttk.Button(bar, text="재검토 반영", command=self.do_apply_reviews)
        b2.pack(side="left", padx=8)
        self.run_buttons += [b1, b2]
        ttk.Button(bar, text="새로고침", command=self.refresh_all).pack(side="left")
        ttk.Button(bar, text="구글 시트 열기", command=self.open_sheet).pack(side="left", padx=8)
        ttk.Label(bar, text="수집은 키워드 수에 따라 1~5분 걸림", style="Sub.TLabel").pack(side="right")

        ttk.Label(tab, text="실행 기록", style="H2.TLabel").pack(anchor="w", pady=(16, 4))
        self.log_txt = tk.Text(tab, height=10, relief="solid", bd=1, bg=COLORS["card"],
                               font=(self.font, 9), state="disabled", wrap="word")
        self.log_txt.pack(fill="both", expand=True)

    def refresh_status(self):
        def ok(d):
            for k, lbl in self.stat.items():
                lbl.config(text=str(d.get(k, "-")))
            self.stat["pending"].config(foreground=COLORS["warn"] if d.get("pending") else COLORS["text"])
            self.last_run_lbl.config(text=d.get("lastRun") or "-")
            self.last_result_lbl.config(text=d.get("lastResult") or "-")
            if not self.busy:
                self.status_lbl.config(text="대기 중", foreground=COLORS["sub"])
        self.run_async("status", on_ok=ok)

    def do_run_weekly(self):
        if not messagebox.askyesno(APP_TITLE, "사용 중인 키워드 전체로 수집을 실행합니다.\n"
                                              "AI 호출 비용이 발생합니다. 진행할까요?"):
            return

        def ok(d):
            self.log("수집 완료")
            self.refresh_all()
            messagebox.showinfo(APP_TITLE, f"수집 완료\n\n{d.get('lastResult', '')}")
        self.run_async("run_weekly", on_ok=ok, busy_msg="수집 실행 중… (최대 5분)", long=True)

    def do_apply_reviews(self):
        def ok(d):
            self.log(f"재검토 반영: {d.get('done', 0)}건")
            self.refresh_all()
            messagebox.showinfo(APP_TITLE, f"재검토 반영 완료: {d.get('done', 0)}건 처리")
        self.run_async("apply_reviews", on_ok=ok, busy_msg="재검토 반영 중…", long=True)

    def open_sheet(self):
        url = self.cfg.get("sheet_url", "").strip()
        if not url:
            messagebox.showinfo(APP_TITLE, "설정 탭에 구글 시트 주소를 넣으면 바로 열 수 있습니다.")
            return
        webbrowser.open(url)

    # ---------- 키워드 ----------

    def _tab_keywords(self):
        tab = ttk.Frame(self.nb, padding=16)
        self.nb.add(tab, text="  키워드  ")

        top = ttk.Frame(tab)
        top.pack(fill="x", pady=(0, 8))
        ttk.Label(top, text="상태").pack(side="left")
        self.kw_filter = ttk.Combobox(top, values=["전체", "사용", "제안", "중지", "거절"], width=8, state="readonly")
        self.kw_filter.set("전체")
        self.kw_filter.pack(side="left", padx=6)
        self.kw_filter.bind("<<ComboboxSelected>>", lambda e: self._fill_keywords())
        ttk.Label(top, text="Ctrl/Shift+클릭으로 여러 개 선택", style="Sub.TLabel").pack(side="left", padx=12)

        cols = ("키워드", "언어", "상태", "출처", "누적 채택", "최근 4주", "제안 이유", "추가일")
        frame, self.kw_tree = self._tree(tab, cols, (200, 50, 60, 80, 80, 80, 300, 130))
        frame.pack(fill="both", expand=True)
        self.kw_tree.tag_configure("제안", background="#fff8e1")
        self.kw_tree.tag_configure("중지", foreground=COLORS["sub"])
        self.kw_tree.tag_configure("거절", foreground="#9aa0a6")

        bar = ttk.Frame(tab)
        bar.pack(fill="x", pady=(10, 0))
        b = ttk.Button(bar, text="▶  선택한 키워드로 수집", style="Accent.TButton", command=self.do_run_keywords)
        b.pack(side="left")
        self.run_buttons.append(b)
        ttk.Label(bar, text="  상태 바꾸기:").pack(side="left", padx=(16, 4))
        for st in ("사용", "중지", "거절"):
            ttk.Button(bar, text=st, command=lambda s=st: self.do_kw_status(s)).pack(side="left", padx=2)

        add = ttk.Frame(tab)
        add.pack(fill="x", pady=(10, 0))
        ttk.Label(add, text="새 키워드").pack(side="left")
        self.kw_new = ttk.Entry(add, width=30)
        self.kw_new.pack(side="left", padx=6)
        self.kw_new.bind("<Return>", lambda e: self.do_kw_add())
        self.kw_lang = ttk.Combobox(add, values=["ko", "en"], width=5, state="readonly")
        self.kw_lang.set("ko")
        self.kw_lang.pack(side="left")
        ttk.Button(add, text="추가", command=self.do_kw_add).pack(side="left", padx=6)

    def refresh_keywords(self):
        def ok(d):
            self.keywords = d or []
            self._fill_keywords()
        self.run_async("keywords", on_ok=ok)

    def _fill_keywords(self):
        t = self.kw_tree
        t.delete(*t.get_children())
        f = self.kw_filter.get()
        for k in self.keywords:
            if f != "전체" and k["status"] != f:
                continue
            t.insert("", "end", iid=str(k["row"]), tags=(k["status"],),
                     values=(k["keyword"], k["lang"], k["status"], k["source"], k["total"],
                             k["recent"], k["reason"], str(k["added"])[:10]))

    def _selected_keywords(self):
        rows = {int(i) for i in self.kw_tree.selection()}
        return [k for k in self.keywords if k["row"] in rows]

    def do_run_keywords(self):
        sel = self._selected_keywords()
        if not sel:
            messagebox.showinfo(APP_TITLE, "목록에서 키워드를 먼저 선택하세요.")
            return
        names = [k["keyword"] for k in sel]
        if not messagebox.askyesno(APP_TITLE, f"{len(names)}개 키워드로 수집합니다.\n\n" + ", ".join(names)):
            return

        def ok(d):
            self.refresh_all()
            messagebox.showinfo(APP_TITLE, "선택 실행 결과\n\n" + d.get("text", ""))
        self.run_async("run_keywords", {"names": names}, on_ok=ok,
                       busy_msg=f"{len(names)}개 키워드 수집 중…", long=True)

    def do_kw_status(self, status):
        sel = self._selected_keywords()
        if not sel:
            messagebox.showinfo(APP_TITLE, "목록에서 키워드를 먼저 선택하세요.")
            return
        items = [{"row": k["row"], "keyword": k["keyword"]} for k in sel]

        def ok(d):
            self.keywords = d
            self._fill_keywords()
            self.refresh_status()
            self.log(f"키워드 {len(items)}개 → {status}")
        self.run_async("keyword_status", {"items": items, "status": status}, on_ok=ok)

    def do_kw_add(self):
        k = self.kw_new.get().strip()
        if not k:
            return

        def ok(d):
            self.keywords = d
            self.kw_new.delete(0, "end")
            self._fill_keywords()
            self.refresh_status()
            self.log(f"키워드 추가: {k}")
        self.run_async("keyword_add", {"keyword": k, "lang": self.kw_lang.get()}, on_ok=ok)

    # ---------- 보류 검토 ----------

    def _tab_pending(self):
        tab = ttk.Frame(self.nb, padding=16)
        self.nb.add(tab, text="  보류 검토  ")
        ttk.Label(tab, text="AI가 애매하다고 본 기사. 판정을 고른 뒤 '재검토 반영'을 누르면 사례 탭에 반영됨",
                  style="Sub.TLabel").pack(anchor="w", pady=(0, 8))

        cols = ("검사일", "키워드", "확신도", "기사제목", "내 판정")
        frame, self.pd_tree = self._tree(tab, cols, (130, 130, 60, 520, 100), height=10)
        frame.pack(fill="both", expand=True)
        self.pd_tree.bind("<<TreeviewSelect>>", lambda e: self._show_pending_detail())
        self.pd_tree.bind("<Double-1>", lambda e: self._open_selected(self.pd_tree, self.pending, "url"))
        self.pd_tree.tag_configure("set", foreground=COLORS["ok"])

        self.pd_detail = tk.Text(tab, height=5, relief="solid", bd=1, bg=COLORS["card"], wrap="word",
                                 font=(self.font, 10), padx=8, pady=6)
        self.pd_detail.pack(fill="x", pady=8)

        bar = ttk.Frame(tab)
        bar.pack(fill="x")
        ttk.Button(bar, text="✔ 사례로 추가", command=lambda: self.do_review("사례로 추가")).pack(side="left")
        ttk.Button(bar, text="✖ 제외 확정", command=lambda: self.do_review("제외 확정")).pack(side="left", padx=6)
        ttk.Button(bar, text="기사 열기",
                   command=lambda: self._open_selected(self.pd_tree, self.pending, "url")).pack(side="left")
        b = ttk.Button(bar, text="재검토 반영", style="Accent.TButton", command=self.do_apply_reviews)
        b.pack(side="right")
        self.run_buttons.append(b)

    def refresh_pending(self):
        def ok(d):
            self.pending = d or []
            t = self.pd_tree
            t.delete(*t.get_children())
            for p in self.pending:
                dec = p.get("decision", "")
                t.insert("", "end", iid=str(p["row"]), tags=("set",) if dec else (),
                         values=(p["date"], p["keyword"], p["score"], p["title"], dec))
            self.nb.tab(2, text=f"  보류 검토 ({sum(1 for p in self.pending if not p.get('decision'))})  ")
        self.run_async("pending", on_ok=ok)

    def _show_pending_detail(self):
        sel = self.pd_tree.selection()
        self.pd_detail.delete("1.0", "end")
        if not sel:
            return
        p = next((x for x in self.pending if str(x["row"]) == sel[0]), None)
        if p:
            self.pd_detail.insert("1.0", f"{p['title']}\n\n사유: {p['reason']}\n링크: {p['url']}")

    def do_review(self, decision):
        sel = self.pd_tree.selection()
        if not sel:
            messagebox.showinfo(APP_TITLE, "목록에서 기사를 먼저 선택하세요.")
            return
        items = [{"row": p["row"], "url": p["url"]} for p in self.pending if str(p["row"]) in sel]

        def ok(d):
            # 시트는 판정이 적힌 행을 보류 목록에서 빼므로, 화면에서는 판정 표시로 남겨 둠
            for p in self.pending:
                if str(p["row"]) in sel:
                    p["decision"] = decision
                    self.pd_tree.set(str(p["row"]), "내 판정", decision)
                    self.pd_tree.item(str(p["row"]), tags=("set",))
            self.log(f"{len(items)}건 → {decision} (재검토 반영을 눌러야 사례에 적용됨)")
        self.run_async("review_set", {"items": items, "decision": decision}, on_ok=ok)

    # ---------- 사례 ----------

    def _tab_cases(self):
        tab = ttk.Frame(self.nb, padding=16)
        self.nb.add(tab, text="  사례  ")
        top = ttk.Frame(tab)
        top.pack(fill="x", pady=(0, 8))
        ttk.Label(top, text="검색").pack(side="left")
        self.case_q = ttk.Entry(top, width=30)
        self.case_q.pack(side="left", padx=6)
        self.case_q.bind("<KeyRelease>", lambda e: self._fill_cases())
        self.case_func = ttk.Combobox(top, values=["전체 HR기능", "채용", "교육·육성", "평가·보상", "조직문화",
                                                   "HR 운영", "정책·규제"], width=12, state="readonly")
        self.case_func.set("전체 HR기능")
        self.case_func.pack(side="left", padx=6)
        self.case_func.bind("<<ComboboxSelected>>", lambda e: self._fill_cases())
        ttk.Button(top, text="CSV로 저장", command=self.export_cases).pack(side="right")
        self.case_count = ttk.Label(top, text="", style="Sub.TLabel")
        self.case_count.pack(side="right", padx=10)

        cols = ("수집일", "기업기관명", "국가", "HR기능", "AI유형", "한줄요약", "포스팅여부")
        frame, self.case_tree = self._tree(tab, cols, (110, 140, 50, 90, 90, 420, 80), height=12)
        frame.pack(fill="both", expand=True)
        self.case_tree.bind("<<TreeviewSelect>>", lambda e: self._show_case_detail())
        self.case_tree.bind("<Double-1>", lambda e: self._open_selected(self.case_tree, self._case_view, "출처URL"))
        self.case_detail = tk.Text(tab, height=8, relief="solid", bd=1, bg=COLORS["card"], wrap="word",
                                   font=(self.font, 10), padx=8, pady=6)
        self.case_detail.pack(fill="x", pady=(8, 0))
        self._case_view = []

    def refresh_cases(self):
        def ok(d):
            self.cases = d or []
            self._fill_cases()
        self.run_async("cases", {"limit": 300}, on_ok=ok)

    def _fill_cases(self):
        q = self.case_q.get().strip().lower()
        fn = self.case_func.get()
        view = []
        for c in self.cases:
            if fn != "전체 HR기능" and c.get("HR기능") != fn:
                continue
            if q and q not in " ".join(str(v) for v in c.values()).lower():
                continue
            view.append(c)
        self._case_view = view
        t = self.case_tree
        t.delete(*t.get_children())
        for i, c in enumerate(view):
            t.insert("", "end", iid=str(i), values=(str(c["수집일"])[:10], c["기업기관명"], c["국가"], c["HR기능"],
                                                    c["AI유형"], c["한줄요약"], c["포스팅여부"]))
        self.case_count.config(text=f"{len(view)}건 / 전체 {len(self.cases)}건")

    def _show_case_detail(self):
        sel = self.case_tree.selection()
        self.case_detail.delete("1.0", "end")
        if not sel:
            return
        c = self._case_view[int(sel[0])]
        keys = ["기업기관명", "업종", "한줄요약", "도입배경", "결과수치", "시사점초안", "기사제목", "출처URL"]
        self.case_detail.insert("1.0", "\n".join(f"{k}: {c.get(k, '')}" for k in keys))

    def export_cases(self):
        if not self._case_view:
            return
        path = filedialog.asksaveasfilename(defaultextension=".csv", initialfile="HRxAI_사례.csv",
                                            filetypes=[("CSV", "*.csv")])
        if not path:
            return
        with open(path, "w", newline="", encoding="utf-8-sig") as f:  # 엑셀에서 한글 안 깨지게
            w = csv.DictWriter(f, fieldnames=list(self._case_view[0].keys()))
            w.writeheader()
            w.writerows(self._case_view)
        self.log(f"CSV 저장: {path}")

    # ---------- 초안 ----------

    def _tab_draft(self):
        tab = ttk.Frame(self.nb, padding=16)
        self.nb.add(tab, text="  블로그 초안  ")
        top = ttk.Frame(tab)
        top.pack(fill="x", pady=(0, 8))
        ttk.Label(top, text="생성일").pack(side="left")
        self.draft_pick = ttk.Combobox(top, width=20, state="readonly")
        self.draft_pick.pack(side="left", padx=6)
        self.draft_pick.bind("<<ComboboxSelected>>", lambda e: self._show_draft(self.draft_pick.current()))
        ttk.Button(top, text="복사", command=self.copy_draft).pack(side="right")
        ttk.Button(top, text="txt로 저장", command=self.save_draft).pack(side="right", padx=6)
        self.draft_txt = tk.Text(tab, relief="solid", bd=1, bg=COLORS["card"], wrap="word",
                                 font=(self.font, 11), padx=12, pady=10)
        self.draft_txt.pack(fill="both", expand=True)

    def refresh_draft(self):
        def ok(d):
            self.drafts = (d or {}).get("history") or []
            self.draft_pick["values"] = [x["date"] for x in self.drafts]
            if self.drafts:
                self.draft_pick.current(0)
                self._show_draft(0)
            else:
                self.draft_txt.delete("1.0", "end")
                self.draft_txt.insert("1.0", "아직 초안이 없습니다. 수집에서 채택된 사례가 생기면 자동으로 만들어집니다.")
        self.run_async("draft", on_ok=ok)

    def _show_draft(self, i):
        self.draft_txt.delete("1.0", "end")
        if 0 <= i < len(self.drafts):
            self.draft_txt.insert("1.0", self.drafts[i]["text"])

    def copy_draft(self):
        self.clipboard_clear()
        self.clipboard_append(self.draft_txt.get("1.0", "end-1c"))
        self.log("초안을 클립보드에 복사함")

    def save_draft(self):
        path = filedialog.asksaveasfilename(defaultextension=".txt", initialfile="HRxAI_초안.txt",
                                            filetypes=[("텍스트", "*.txt")])
        if path:
            with open(path, "w", encoding="utf-8") as f:
                f.write(self.draft_txt.get("1.0", "end-1c"))
            self.log(f"초안 저장: {path}")

    # ---------- 대시보드 ----------

    def _tab_dash(self):
        tab = ttk.Frame(self.nb, padding=16)
        self.nb.add(tab, text="  대시보드  ")
        self.dash = tk.Canvas(tab, bg=COLORS["card"], highlightthickness=1, highlightbackground=COLORS["line"])
        self.dash.pack(fill="both", expand=True)
        self.dash_data = None
        self.dash.bind("<Configure>", lambda e: self._draw_dash())

    def refresh_dash(self):
        def ok(d):
            self.dash_data = d
            self._draw_dash()
        self.run_async("dashboard", on_ok=ok)

    def _draw_dash(self):
        c = self.dash
        c.delete("all")
        d = self.dash_data
        if not d:
            return
        W, H = max(c.winfo_width(), 600), max(c.winfo_height(), 400)
        f = self.font
        c.create_text(24, 22, anchor="w", text=f"누적 사례 {d['total']}건", font=(f, 15, "bold"), fill=COLORS["text"])

        # 왼쪽: HR 기능별 가로 막대
        self._hbars(c, 24, 60, W * 0.48, "HR 기능별 사례 수", d.get("byFunc", {}))
        # 오른쪽 위: AI 유형, 국가
        self._hbars(c, W * 0.54, 60, W * 0.42, "AI 유형별", d.get("byType", {}), small=True)
        self._hbars(c, W * 0.54, 60 + 40 + 26 * max(len(d.get("byType", {})), 1) + 20, W * 0.42,
                    "국내 / 해외", d.get("byCountry", {}), small=True)
        # 아래: 주별 채택 수 세로 막대 (최근 12주)
        weeks = sorted(d.get("byWeek", {}).items())[-12:]
        top = H * 0.58
        c.create_text(24, top, anchor="w", text="주별 채택 수 (최근 12주)", font=(f, 11, "bold"), fill=COLORS["text"])
        if weeks:
            mx = max(v for _, v in weeks) or 1
            base, ch = H - 40, H - 40 - (top + 30)
            bw = min(48, (W - 80) / len(weeks) - 10)
            for i, (wk, v) in enumerate(weeks):
                x = 40 + i * (bw + 10)
                h = ch * v / mx
                c.create_rectangle(x, base - h, x + bw, base, fill=COLORS["accent"], width=0)
                c.create_text(x + bw / 2, base - h - 10, text=str(v), font=(f, 9), fill=COLORS["text"])
                c.create_text(x + bw / 2, base + 12, text=wk[5:], font=(f, 8), fill=COLORS["sub"])
            c.create_line(32, base, W - 24, base, fill=COLORS["line"])

    def _hbars(self, c, x, y, w, title, data, small=False):
        f = self.font
        c.create_text(x, y, anchor="w", text=title, font=(f, 11, "bold"), fill=COLORS["text"])
        items = sorted(data.items(), key=lambda kv: -kv[1]) if small else list(data.items())
        if not items:
            c.create_text(x, y + 30, anchor="w", text="데이터 없음", fill=COLORS["sub"])
            return
        mx = max(v for _, v in items) or 1
        label_w, row_h = 90, 22 if small else 30
        for i, (k, v) in enumerate(items):
            yy = y + 30 + i * (row_h + 4)
            c.create_text(x, yy + row_h / 2, anchor="w", text=k, font=(f, 9 if small else 10), fill=COLORS["text"])
            bw = (w - label_w - 40) * v / mx
            c.create_rectangle(x + label_w, yy, x + label_w + max(bw, 2), yy + row_h,
                               fill=BAR_COLORS[i % len(BAR_COLORS)], width=0)
            c.create_text(x + label_w + max(bw, 2) + 6, yy + row_h / 2, anchor="w", text=str(v),
                          font=(f, 9), fill=COLORS["sub"])

    # ---------- 설정 ----------

    def _tab_settings(self):
        tab = ttk.Frame(self.nb, padding=24)
        self.nb.add(tab, text="  설정  ")
        self.demo_var = tk.BooleanVar(value=bool(self.cfg.get("demo")))
        ttk.Checkbutton(tab, text="데모 모드 (시트 연결 없이 샘플 데이터로 시연)", variable=self.demo_var).grid(
            row=0, column=0, columnspan=3, sticky="w", pady=(0, 16))

        ttk.Label(tab, text="웹 앱 URL").grid(row=1, column=0, sticky="w", pady=6)
        self.url_ent = ttk.Entry(tab, width=90)
        self.url_ent.insert(0, self.cfg.get("url", ""))
        self.url_ent.grid(row=1, column=1, sticky="we", padx=8)

        ttk.Label(tab, text="API 토큰").grid(row=2, column=0, sticky="w", pady=6)
        self.tok_ent = ttk.Entry(tab, width=90, show="•")
        self.tok_ent.insert(0, self.cfg.get("token", ""))
        self.tok_ent.grid(row=2, column=1, sticky="we", padx=8)
        self.show_tok = tk.BooleanVar(value=False)
        ttk.Checkbutton(tab, text="보기", variable=self.show_tok,
                        command=lambda: self.tok_ent.config(show="" if self.show_tok.get() else "•")).grid(
            row=2, column=2, sticky="w")

        ttk.Label(tab, text="구글 시트 주소 (선택)").grid(row=3, column=0, sticky="w", pady=6)
        self.sheet_ent = ttk.Entry(tab, width=90)
        self.sheet_ent.insert(0, self.cfg.get("sheet_url", ""))
        self.sheet_ent.grid(row=3, column=1, sticky="we", padx=8)

        bar = ttk.Frame(tab)
        bar.grid(row=4, column=1, sticky="w", pady=16, padx=8)
        ttk.Button(bar, text="저장", style="Accent.TButton", command=self.save_settings).pack(side="left")
        ttk.Button(bar, text="연결 테스트", command=self.test_connection).pack(side="left", padx=8)

        tips = ("· 웹 앱 URL: Apps Script → 배포 → 배포 관리에서 복사 (끝이 /exec)\n"
                "· API 토큰: Apps Script에서 setupApi 실행 → 실행 로그에 표시됨\n"
                f"· 설정 저장 위치: {config.config_path()}\n"
                "· 토큰은 이 PC에만 저장되고 프로그램 파일에는 들어가지 않음")
        ttk.Label(tab, text=tips, style="Sub.TLabel", justify="left").grid(row=5, column=0, columnspan=3, sticky="w")
        tab.columnconfigure(1, weight=1)

    def _settings_from_form(self):
        return {"demo": self.demo_var.get(), "url": self.url_ent.get().strip(),
                "token": self.tok_ent.get().strip(), "sheet_url": self.sheet_ent.get().strip()}

    def save_settings(self):
        new = self._settings_from_form()
        if not new["demo"] and (not new["url"] or not new["token"]):
            messagebox.showwarning(APP_TITLE, "시트 연결 모드는 웹 앱 URL과 토큰이 모두 필요합니다.")
            return
        self.cfg.update(new)
        config.save(self.cfg)
        self._make_client()
        self.log("설정 저장, 데이터 다시 불러옴")
        self.refresh_all()

    def test_connection(self):
        new = self._settings_from_form()
        client = DemoClient() if new["demo"] else ApiClient(new["url"], new["token"])

        def work():
            try:
                d = client.call("ping")
                self.jobs.put((lambda d: messagebox.showinfo(
                    APP_TITLE, f"연결 성공\n\n시트: {d.get('sheet')}\nAPI: {d.get('version')}"), d, None, False))
            except Exception as e:
                self.jobs.put((lambda _: messagebox.showerror(APP_TITLE, f"연결 실패\n\n{e}"), None, None, False))
        threading.Thread(target=work, daemon=True).start()

    # ---------- 기타 ----------

    def _open_selected(self, tree, data, key):
        sel = tree.selection()
        if not sel:
            return
        sid = sel[0]
        item = None
        if data is self.pending:
            item = next((x for x in data if str(x["row"]) == sid), None)
        elif sid.isdigit() and int(sid) < len(data):
            item = data[int(sid)]
        if item and str(item.get(key, "")).startswith("http"):
            webbrowser.open(item[key])


def main():
    app = App()
    app.mainloop()


if __name__ == "__main__":
    main()
