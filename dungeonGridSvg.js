// dungeonGridSvg.js v2026-02-23-01
// Focus: ONLY generating an SVG square grid (<rect> cells + optional icon text)

const NS = "http://www.w3.org/2000/svg";
function make(tag){ return document.createElementNS(NS, tag); }

export function makeSquareMath({ COLS, ROWS, SIZE, GAP, PAD }){
  const STEP = SIZE + GAP;

  function topLeft(c, r){
    const x = PAD + c * STEP;
    const y = PAD + r * STEP;
    return { x, y };
  }

  function center(c, r){
    const { x, y } = topLeft(c, r);
    return { x: x + SIZE/2, y: y + SIZE/2 };
  }

  function computeBounds(){
    const w = PAD*2 + COLS*SIZE + (COLS-1)*GAP;
    const h = PAD*2 + ROWS*SIZE + (ROWS-1)*GAP;
    return { w: Math.ceil(w), h: Math.ceil(h) };
  }

  return { STEP, topLeft, center, computeBounds };
}

export function buildSquareSvgGrid({
  svg,
  COLS,
  ROWS,
  SIZE,
  GAP,
  PAD,
  topLeft,
  center,
  computeBounds,
  setVisual,            // (rect, c, r) -> void
  onClickCell,          // (c, r, rect) -> void
  onEnterCell,          // (c, r, rect) -> void (optional)
  onLeaveCell,          // (c, r, rect) -> void (optional)
  makeIconText = true   // create <text> nodes and attach rect._cellIcon
}){
  const { w, h } = computeBounds();
  // svg.setAttribute("width", w);
  // svg.setAttribute("height", h);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  svg.innerHTML = "";

  const rectByKey = new Map();
  let count = 0;

  for (let r = 0; r < ROWS; r++){
    for (let c = 0; c < COLS; c++){
      const { x, y } = topLeft(c, r);

      const rect = make("rect");
      rect.setAttribute("x", x);
      rect.setAttribute("y", y);
      rect.setAttribute("width", SIZE);
      rect.setAttribute("height", SIZE);
      rect.dataset.c = String(c);
      rect.dataset.r = String(r);

      let iconText = null;
      if (makeIconText){
        const { x: cx, y: cy } = center(c, r);
        iconText = make("text");
        iconText.textContent = "";
        iconText.setAttribute("x", cx);
        iconText.setAttribute("y", cy);
        iconText.setAttribute("text-anchor", "middle");
        iconText.setAttribute("dominant-baseline", "central");
        iconText.setAttribute("font-size", "16");
        iconText.setAttribute("fill", "#000");
        iconText.style.pointerEvents = "none";
        iconText.style.userSelect = "none";
        iconText.style.display = "none";
        rect._cellIcon = iconText;
      }

      setVisual(rect, c, r);

      if (onEnterCell) rect.addEventListener("mouseenter", () => onEnterCell(c, r, rect));
      if (onLeaveCell) rect.addEventListener("mouseleave", () => onLeaveCell(c, r, rect));
      rect.addEventListener("click", () => onClickCell(c, r, rect));

      svg.appendChild(rect);
      if (iconText) svg.appendChild(iconText);

      rectByKey.set(`${c},${r}`, rect);
      count++;
    }
  }

  return { w, h, count, rectByKey };
}
