// ボード自動更新 + 承認待ち通知。
// - 15s ごとに /api/board?cwd=<現在フィルタ> を取得し .board を差し替える
// - states（id→phase）を前回と比較し、review への新規遷移を検知して通知する
// - 初回ポーリングはベースライン確立のみ（既に review にいる待機タスクで誤通知しない）
// - 通知は許可済みのときだけ OS 通知。未許可時はタブ title の (n) バッジで代替
// - document.hidden 中は polling を止め、可視復帰で即時 1 回取得して再開する

const board = document.querySelector(".board");
if (board) {
  const POLL_MS = 15000;
  const NOTIFY_KEY = "wf-notify-enabled";

  const indicator = document.querySelector("[data-live-indicator]");
  const notifyToggle = document.querySelector("[data-notify-toggle]");
  const filterSelect = document.querySelector(".filter-select");

  // phase Map のベースライン。初回取得で確立し、以後はこれとの差分だけ通知する
  /** @type {Map<string, string>} */
  let prevPhases = new Map();
  let baselineEstablished = false;
  let unread = 0;
  let timer = null;

  // 通知有効フラグ。ユーザーの明示意思を localStorage に保持する
  let notifyEnabled = localStorage.getItem(NOTIFY_KEY) === "true";

  const baseTitle = document.title;
  const updateTitle = () => {
    document.title = unread > 0 ? `(${unread}) ${baseTitle}` : baseTitle;
  };

  // インジケータ状態。live=稼働（⟳ 回転）/ idle=停止（淡色・回転なし）
  const setIndicator = (state) => {
    if (indicator) indicator.dataset.state = state;
  };

  // 通知トグルの見た目を現在の permission / enabled から決める
  const refreshToggle = () => {
    if (!notifyToggle) return;
    const perm = "Notification" in window ? Notification.permission : "denied";
    const icon = notifyToggle.querySelector("[data-notify-icon]");
    let on = false;
    let label = "通知 オフ";
    if (perm === "denied") {
      label = "通知はブラウザ設定でブロックされています";
    } else if (perm === "granted" && notifyEnabled) {
      on = true;
      label = "承認待ちを通知中（クリックでオフ）";
    } else {
      label = "クリックで承認待ちを通知";
    }
    notifyToggle.setAttribute("aria-pressed", on ? "true" : "false");
    notifyToggle.dataset.denied = perm === "denied" ? "true" : "false";
    notifyToggle.title = label;
    if (icon) icon.textContent = on ? "🔔" : "🔕";
  };

  // 現在の cwd フィルタ。filter-select の値を優先し、無ければ URL の ?cwd= を見る
  const currentFilter = () => {
    if (filterSelect) return filterSelect.value;
    return new URLSearchParams(location.search).get("cwd") ?? "";
  };

  // review への新規遷移 1 件を通知（or 未許可なら title バッジ加算）
  const notifyReview = (state) => {
    if (notifyEnabled && "Notification" in window && Notification.permission === "granted") {
      const n = new Notification("⚙ 承認待ち", {
        body: `${state.title} が Review に入りました`,
        tag: `wf-review-${state.id}`,
      });
      n.onclick = () => {
        window.focus();
        location.href = `/task/${encodeURIComponent(state.id)}?doc=plan.md`;
      };
    } else if (document.hidden || !notifyEnabled) {
      unread += 1;
      updateTitle();
    }
  };

  // states を前回 phase と突き合わせ、review への新規遷移を拾う
  const diffAndNotify = (states) => {
    const next = new Map(states.map((s) => [s.id, s.phase]));
    if (!baselineEstablished) {
      prevPhases = next;
      baselineEstablished = true;
      return;
    }
    for (const s of states) {
      const before = prevPhases.get(s.id);
      if (s.phase === "review" && before !== "review") notifyReview(s);
    }
    prevPhases = next;
  };

  const poll = async () => {
    try {
      const res = await fetch(`/api/board?cwd=${encodeURIComponent(currentFilter())}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      if (typeof data.html === "string") board.innerHTML = data.html;
      if (Array.isArray(data.states)) diffAndNotify(data.states);
      setIndicator("live");
    } catch {
      // 取得失敗（gh 未認証 / オフライン等）は淡色表示にして前回描画を保持、次周期で復帰
      setIndicator("idle");
    }
  };

  const start = () => {
    if (timer !== null) return;
    setIndicator("live");
    poll();
    timer = setInterval(poll, POLL_MS);
  };
  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    setIndicator("idle");
  };

  // タブ可視性: 裏では止めて無駄な git/gh spawn を避ける。表に戻ったら未読を消して再開
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stop();
    } else {
      unread = 0;
      updateTitle();
      start();
    }
  });

  // 通知トグル: default なら許可要求、granted ならオン/オフ切替、denied は何もしない
  if (notifyToggle) {
    notifyToggle.addEventListener("click", async () => {
      if (!("Notification" in window)) return;
      const perm = Notification.permission;
      if (perm === "denied") {
        refreshToggle();
        return;
      }
      if (perm === "default") {
        const granted = (await Notification.requestPermission()) === "granted";
        notifyEnabled = granted;
      } else {
        notifyEnabled = !notifyEnabled;
      }
      localStorage.setItem(NOTIFY_KEY, notifyEnabled ? "true" : "false");
      refreshToggle();
    });
  }

  refreshToggle();
  start();
}
