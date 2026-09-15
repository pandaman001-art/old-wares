// 価格分布の積み上げヒストグラム（インライン SVG）。
//
// 系列は 2 つ（ヤフオク / メルカリ）。色は CSS 変数から読むので、
// ライト / ダークの切り替えで再描画するだけで追従する。

const NS = "http://www.w3.org/2000/svg";
export const SERIES_VARS = ["--series-yahoo", "--series-mercari"];

const yen = (n) => (n === null || n === undefined ? "—" : "¥" + Number(n).toLocaleString("ja-JP"));

export function shortYen(n) {
  if (n === null || n === undefined) return "";
  if (Math.abs(n) >= 10000) {
    const man = n / 10000;
    return (man >= 10 ? Math.round(man) : Math.round(man * 10) / 10) + "万";
  }
  return Number(n).toLocaleString("ja-JP");
}

function roundedTop(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h);
  return `M${x},${y + h}L${x},${y + radius}Q${x},${y} ${x + radius},${y}` +
         `L${x + w - radius},${y}Q${x + w},${y} ${x + w},${y + radius}L${x + w},${y + h}Z`;
}

function niceCeil(value) {
  const exp = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= value) return m * exp;
  return 10 * exp;
}

/** result.histogram を svg に描く。tip はホバー用のツールチップ要素。 */
export function drawHistogram(result, svg, tip, legend) {
  const h = result.histogram;
  svg.innerHTML = "";
  if (!h || !h.edges.length) return;

  const css = getComputedStyle(document.documentElement);
  const ink = (name) => css.getPropertyValue(name).trim();
  const colors = h.series.map((_, i) => ink(SERIES_VARS[i % SERIES_VARS.length]));
  if (legend) {
    legend.innerHTML = h.series
      .map((name, i) => `<span><span class="swatch" style="background:${colors[i]}"></span>${name}</span>`)
      .join("");
  }

  // viewBox を実際の表示幅に合わせる。こうすると文字サイズが端末上の px と一致し、
  // スマホでラベルが潰れない。
  const cssWidth = svg.getBoundingClientRect().width || 900;
  const narrow = cssWidth < 560;
  const W = Math.round(Math.max(320, Math.min(900, cssWidth)));
  const H = narrow ? 300 : 320;
  const pad = { top: 16, right: 12, bottom: 44, left: narrow ? 34 : 44 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const bins = h.counts.length;
  const totals = h.counts.map((row) => row.reduce((a, b) => a + b, 0));
  const yMax = niceCeil(Math.max(1, ...totals));
  const slot = plotW / bins;
  const barW = Math.max(3, Math.min(slot * 0.72, narrow ? 28 : 44));
  const GAP = 2;      // 積み上げセグメント間の余白（枠線ではなく隙間で分ける）
  const RADIUS = 4;   // データ端の丸み

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const add = (tag, attrs, parent = svg) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    parent.appendChild(node);
    return node;
  };
  const y = (v) => pad.top + plotH - (v / yMax) * plotH;

  // 目盛りと薄いグリッド
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const value = Math.round((yMax / ticks) * i);
    add("line", { x1: pad.left, x2: W - pad.right, y1: y(value), y2: y(value),
      stroke: i === 0 ? ink("--axis") : ink("--grid"), "stroke-width": 1 });
    add("text", { x: pad.left - 8, y: y(value) + 4, "text-anchor": "end",
      fill: ink("--text-muted"), "font-size": 11 }).textContent = value;
  }
  add("text", { x: pad.left - 8, y: pad.top - 4, "text-anchor": "end",
    fill: ink("--text-muted"), "font-size": 11 }).textContent = "件数";

  // 棒（下から積む）
  for (let b = 0; b < bins; b++) {
    const x = pad.left + slot * b + (slot - barW) / 2;
    let cursor = y(0);
    const lastFilled = h.counts[b].reduce((acc, c, i) => (c > 0 ? i : acc), -1);
    h.counts[b].forEach((count, s) => {
      if (count <= 0) return;
      const full = (count / yMax) * plotH;
      const top = cursor - full;
      const isTop = s === lastFilled;
      add("path", {
        d: roundedTop(x, isTop ? top : top + GAP, barW,
                      Math.max(1, isTop ? full : full - GAP), isTop ? RADIUS : 0),
        fill: colors[s],
      });
      cursor = top;
    });
  }

  // x 軸ラベル（おおむね 70px 間隔になるよう間引く）
  const maxLabels = Math.max(3, Math.floor(plotW / 70));
  const every = Math.ceil(bins / maxLabels);
  for (let b = 0; b <= bins; b++) {
    if (b % every !== 0 && b !== bins) continue;
    if (b === bins && bins % every !== 0 && bins % every < every / 2) continue;
    add("text", { x: pad.left + slot * b, y: H - pad.bottom + 18, "text-anchor": "middle",
      fill: ink("--text-muted"), "font-size": 11 }).textContent = shortYen(h.edges[b]);
  }
  add("text", { x: W - pad.right, y: H - 8, "text-anchor": "end",
    fill: ink("--text-muted"), "font-size": 11 }).textContent = "落札・売却価格";

  // 相場のマーカー（直接ラベルはこの 1 本だけに絞る）
  const marker = result.blend?.equalWeightMedian ?? result.combined?.median;
  const span = h.edges[h.edges.length - 1] - h.edges[0];
  if (marker && span > 0) {
    const mx = pad.left + ((marker - h.edges[0]) / span) * plotW;
    if (mx >= pad.left && mx <= W - pad.right) {
      add("line", { x1: mx, x2: mx, y1: pad.top, y2: pad.top + plotH,
        stroke: ink("--text-secondary"), "stroke-width": 2, "stroke-linecap": "round" });
      add("text", { x: Math.min(mx + 6, W - pad.right - 4), y: pad.top + 12,
        "text-anchor": mx > W - 140 ? "end" : "start",
        "paint-order": "stroke", stroke: ink("--surface-1"), "stroke-width": 4, "stroke-linejoin": "round",
        fill: ink("--text-primary"), "font-size": 12, "font-weight": 600 }).textContent = "相場 " + yen(marker);
    }
  }

  if (!tip) return;
  // ビンごとの当たり判定。指でも押せるよう、棒ではなく列全体を対象にする
  for (let b = 0; b < bins; b++) {
    const hit = add("rect", { x: pad.left + slot * b, y: pad.top, width: slot, height: plotH,
      fill: "transparent", style: "cursor:crosshair" });
    const show = () => {
      tip.innerHTML =
        `<b>${yen(h.edges[b])} 〜 ${yen(h.edges[b + 1])}</b>` +
        h.series.map((name, s) => `<div class="line"><span>${name}</span><em>${h.counts[b][s]} 件</em></div>`).join("") +
        `<div class="line"><span>合計</span><em>${totals[b]} 件</em></div>`;
      tip.style.opacity = "1";
    };
    const place = (clientX, clientY) => {
      const box = svg.getBoundingClientRect();
      tip.style.left = Math.min(Math.max(8, clientX - box.left + 14), box.width - tip.offsetWidth - 8) + "px";
      tip.style.top = Math.max(8, clientY - box.top - 10) + "px";
    };
    hit.addEventListener("mouseenter", show);
    hit.addEventListener("mousemove", (ev) => place(ev.clientX, ev.clientY));
    hit.addEventListener("mouseleave", () => { tip.style.opacity = "0"; });
    hit.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType === "mouse") return;
      show();
      place(ev.clientX, ev.clientY);
    });
  }
  svg.addEventListener("pointerleave", () => { tip.style.opacity = "0"; }, { once: true });
}
