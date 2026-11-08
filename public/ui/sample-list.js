/**
 * Sample list. DOM only. The library hands it the rows.
 */

const EXTRA_ROLES = ["vox", "ride", "other"];

export function renderSampleList({ root, countEl, samples, roles, hex2, onPick }) {
  if (!root) return;
  root.innerHTML = "";
  if (countEl) countEl.textContent = String(samples.length);
  const groups = {};
  for (const sample of samples) (groups[sample.role] ||= []).push(sample);
  for (const role of [...roles, ...EXTRA_ROLES]) {
    const list = groups[role];
    if (!list?.length) continue;
    const heading = document.createElement("div");
    heading.className = "cat";
    heading.textContent = role.toUpperCase();
    root.appendChild(heading);
    for (const sample of list) {
      const el = document.createElement("div");
      el.className = "sample";
      el.dataset.id = String(sample.id);
      el.innerHTML = `<span class="id">${hex2(sample.id)}</span><span class="name"></span>`;
      el.querySelector(".name").textContent = sample.name;
      el.addEventListener("click", () => onPick(sample));
      root.appendChild(el);
    }
  }
}

export function highlightSample(selectedId) {
  document.querySelectorAll(".sample").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.id) === Number(selectedId));
  });
}
