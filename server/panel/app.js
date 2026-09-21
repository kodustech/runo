// runo control-plane panel. No build step, no dependencies, no inline script
// (the server's CSP forbids it): everything is rendered from /v1/* JSON.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const state = { me: null, tab: "overview", days: 30, timer: null };

// ---------- api ----------

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-runo-panel": "1", ...(opts.headers || {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new ApiError(data.error?.message || `HTTP ${res.status}`, res.status, data.error?.code);
  return data.result;
}

/** Runs a panel action; an expired or stale session sends the user back through login. */
async function run(label, fn) {
  msg(label + "…");
  try {
    await fn();
    msg("");
  } catch (err) {
    if (err.code === "reauth") {
      if (confirm(err.message + "\n\nYou will come back to the panel right after.")) {
        if (state.github) location.href = "/auth/github";
        else await logout();
      }
      return msg("");
    }
    if (err.status === 401) return showLogin();
    msg("error: " + err.message);
  }
}

const msg = (text) => ($("msg").textContent = text);

// ---------- formatting ----------

const usd = (n) => "$" + (n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2));
const hours = (h) => (h >= 100 ? Math.round(h).toLocaleString("en-US") + "h" : h >= 1 ? h.toFixed(1) + "h" : Math.round(h * 60) + "m");
const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "-");
const day = (ts) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const stateTag = (s) => `<span class="state ${s === "running" ? "running" : s === "stopped" ? "stopped" : ""}">${esc(s ?? "?")}</span>`;

// ---------- charts (single series: the title names it, no legend) ----------

const W = 1000, H = 220, PAD = { l: 36, r: 12, t: 14, b: 24 };
const x0 = PAD.l, x1 = W - PAD.r, y0 = H - PAD.b, y1 = PAD.t;

function niceMax(v) {
  if (v <= 5) return Math.max(1, Math.ceil(v));
  const pow = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((m) => m >= v);
}

function axes(max, fmt, xs) {
  const ticks = max <= 5 ? Array.from({ length: max + 1 }, (_, i) => i) : [0, max / 4, max / 2, (3 * max) / 4, max];
  const y = (v) => y0 - (v / max) * (y0 - y1);
  return {
    y,
    svg:
      ticks.map((t) => `<line class="gridline" x1="${x0}" x2="${x1}" y1="${y(t)}" y2="${y(t)}"/><text x="${x0 - 6}" y="${y(t) + 4}" text-anchor="end">${esc(fmt(t))}</text>`).join("") +
      xs.map((l) => `<text x="${l.x}" y="${H - 6}" text-anchor="middle">${esc(l.text)}</text>`).join(""),
  };
}

function xLabels(points, xOf) {
  const n = Math.min(6, points.length);
  return Array.from({ length: n }, (_, i) => {
    const p = points[Math.round((i * (points.length - 1)) / Math.max(n - 1, 1))];
    return { x: xOf(p), text: day(p.ts) };
  });
}

function concurrencyChart(o) {
  const pts = o.concurrency;
  if (pts.length < 2) return `<p class="empty">Collecting samples — the fleet is measured once a minute.</p>`;
  const from = pts[0].ts, to = pts[pts.length - 1].ts;
  const max = niceMax(Math.max(o.limit ?? 0, ...pts.map((p) => p.peak)));
  const xOf = (p) => x0 + ((p.ts - from) / (to - from)) * (x1 - x0);
  const ax = axes(max, (t) => (Number.isInteger(t) ? t : t.toFixed(1)), xLabels(pts, xOf));
  // a count holds until the next sample: draw steps, not slopes
  let d = `M${xOf(pts[0])},${ax.y(pts[0].peak)}`;
  for (let i = 1; i < pts.length; i++) d += `H${xOf(pts[i])}V${ax.y(pts[i].peak)}`;
  const top = pts.reduce((a, b) => (b.peak >= a.peak ? b : a));
  const limit = o.limit
    ? `<line class="limit" x1="${x0}" x2="${x1}" y1="${ax.y(o.limit)}" y2="${ax.y(o.limit)}"/>
       <text class="limit-label" x="${x1}" y="${ax.y(o.limit) - 5}" text-anchor="end">policy limit ${o.limit}</text>`
    : "";
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Machines running at the same time" data-chart="line">
    ${ax.svg}${limit}
    <path class="wash" d="${d}V${y0}H${xOf(pts[0])}Z"/><path class="series" d="${d}"/>
    <circle class="marker" cx="${xOf(top)}" cy="${ax.y(top.peak)}" r="4"/>
    <text x="${Math.min(xOf(top) + 8, x1 - 60)}" y="${ax.y(top.peak) - 8}">peak ${top.peak}</text>
    <line class="cross" y1="${y1}" y2="${y0}" hidden/>
    <rect class="hit" x="${x0}" y="${y1}" width="${x1 - x0}" height="${y0 - y1}"
      data-points="${esc(JSON.stringify(pts.map((p) => [Math.round(xOf(p)), p.ts, p.peak, Math.round(p.avg * 10) / 10])))}"/>
  </svg>`;
}

function costChart(daily) {
  if (!daily?.length) return `<p class="empty">No cost recorded in this window.</p>`;
  const max = niceMax(Math.max(...daily.map((d) => d.cost), 0.01));
  const slot = (x1 - x0) / daily.length;
  const w = Math.min(24, Math.max(2, slot - 2));
  const xOf = (_, i) => x0 + slot * i + slot / 2;
  const ax = axes(max, (t) => "$" + (max < 10 ? t.toFixed(2) : Math.round(t)), xLabels(daily, (p) => xOf(p, daily.indexOf(p))));
  const cols = daily.map((d, i) => {
    const h = (d.cost / max) * (y0 - y1);
    const r = Math.min(4, w / 2, h);
    const x = xOf(d, i) - w / 2;
    const shape = h > 0 ? `M${x},${y0}V${y0 - h + r}Q${x},${y0 - h} ${x + r},${y0 - h}H${x + w - r}Q${x + w},${y0 - h} ${x + w},${y0 - h + r}V${y0}Z` : "";
    return `<rect class="hit" x="${x0 + slot * i}" y="${y1}" width="${slot}" height="${y0 - y1}" data-tip="${esc(`<b>${usd(d.cost)}</b> · ${day(d.ts)}`)}"/><path class="col" d="${shape}"/>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Estimated cost per day">${ax.svg}${cols.join("")}</svg>`;
}

function breakdownTable(title, rows) {
  const max = Math.max(...rows.map((r) => r.cost), 0.0001);
  const body = rows.length
    ? rows.map((r) => `<tr><td>${esc(r.key)}</td><td class="num">${r.machines}</td><td class="num">${hours(r.runningHours)}</td>
        <td class="num">${usd(r.cost)}</td>
        <td><svg class="bar" width="72" height="8" aria-hidden="true"><rect class="track" width="72" height="8" rx="4"/><rect class="fill" width="${Math.max(2, (r.cost / max) * 72)}" height="8" rx="4"/></svg></td></tr>`).join("")
    : `<tr><td colspan="5" class="empty">nothing in this window</td></tr>`;
  return `<div class="card tablebox"><table><thead><tr><th>${esc(title)}</th><th class="num">machines</th><th class="num">running</th><th class="num">est. cost</th><th></th></tr></thead><tbody>${body}</tbody></table></div>`;
}

// hover layer: crosshair + tooltip on the line, per-mark tooltip on columns
const tip = $("tip");
function showTip(html, ev) {
  tip.innerHTML = html;
  tip.hidden = false;
  const pad = 14;
  tip.style.left = Math.min(ev.clientX + pad, innerWidth - tip.offsetWidth - 8) + "px";
  tip.style.top = Math.max(8, ev.clientY - tip.offsetHeight - pad) + "px";
}
document.addEventListener("mousemove", (ev) => {
  const hit = ev.target.closest?.(".hit");
  if (!hit) return (tip.hidden = true);
  if (hit.dataset.tip) return showTip(hit.dataset.tip, ev);
  const svg = hit.ownerSVGElement;
  const box = svg.getBoundingClientRect();
  const x = ((ev.clientX - box.left) / box.width) * W;
  const pts = (hit._pts ??= JSON.parse(hit.dataset.points));
  // step series: the value at x is the last sample at or before it
  let p = pts[0];
  for (const q of pts) if (q[0] <= x) p = q;
  const cross = svg.querySelector(".cross");
  cross.removeAttribute("hidden");
  cross.setAttribute("x1", p[0]);
  cross.setAttribute("x2", p[0]);
  showTip(`<b>${p[2]}</b> running at peak · avg ${p[3]}<br><span class="dim">${esc(when(p[1]))}</span>`, ev);
});
document.addEventListener("mouseout", (ev) => {
  if (ev.target.closest?.(".hit")) ev.target.ownerSVGElement?.querySelector(".cross")?.setAttribute("hidden", "");
});

// ---------- views ----------

const kpi = (label, value, note = "") => `<div class="card kpi"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="note">${note}</div></div>`;

const views = {
  async overview() {
    const [o, c] = await Promise.all([api(`/v1/overview?days=${state.days}`), api(`/v1/costs?days=${state.days}`)]);
    const mine = o.scope === "mine";
    const unpriced = o.unpriced.length
      ? `<div class="note-box">No price for <b>${esc(o.unpriced.join(", "))}</b> — compute for these machines is missing from every estimate.${state.me.admin ? " Add it under settings → prices." : " Ask an admin to add it."}</div>`
      : "";
    return `${unpriced}
      <div class="grid kpis">
        ${kpi("Running now", o.now ? o.now.running : "-", o.now ? `${o.now.stopped} stopped · ${esc(when(o.now.ts))}` : "no sample yet")}
        ${kpi(`Peak, last ${o.days}d`, o.peak ? o.peak.running : "-", o.peak ? `${esc(when(o.peak.ts))}${o.limit ? ` · limit ${o.limit}` : ""}` : "")}
        ${kpi(`Est. cost, last ${o.days}d${mine ? " (yours)" : ""}`, usd(o.cost), `${o.machines} machines · ${hours(o.runningHours)} running`)}
        ${o.month ? kpi("This month", usd(o.month.monthToDate), `on pace for ${usd(o.month.forecast)}`) : ""}
      </div>
      <div class="card section"><h3>Machines running at the same time — highest per ${o.days <= 7 ? "hour" : o.days <= 45 ? "6 hours" : "day"}, whole fleet</h3>${concurrencyChart(o)}</div>
      ${c.daily ? `<div class="card section"><h3>Estimated cost per day (UTC) — compute ${usd(c.compute)} · storage ${usd(c.storage)}</h3>${costChart(c.daily)}</div>` : ""}
      <div class="grid two">${breakdownTable("who asked", c.byOwner)}${breakdownTable("repo", c.byRepo)}</div>
      ${breakdownTable("instance type", c.byType)}
      <p class="dim small">Estimates: observed running hours × on-demand price + public IPv4 + gp3 storage while the machine exists. Not included: data transfer, baked images, surplus CPU credits of burstable types. Spot machines are priced with the spot factor set in settings.</p>`;
  },

  async envs() {
    const envs = await api(`/v1/envs?live=1${state.me.admin ? "&all=1" : ""}`);
    if (!envs.length) return `<div class="card empty">no environments — devs create them with <b>runo up</b></div>`;
    const rows = envs.map((e) => {
      const mine = e.owner === state.me.user || state.me.admin;
      const id = esc(e.instanceId), name = esc(e.envName);
      const actions = !mine ? "" : `
        ${e.state === "running" ? `<button data-action="suspend" data-id="${id}" data-name="${name}">suspend</button>` : ""}
        ${e.state === "stopped" ? `<button data-action="resume" data-id="${id}" data-name="${name}">resume</button>` : ""}
        <button class="danger" data-action="destroy" data-id="${id}" data-name="${name}">destroy</button>`;
      return `<tr><td>${name}</td><td>${esc(e.owner)}${e.members?.length ? ` <span class="dim">+${esc(e.members.join(", "))}</span>` : ""}</td>
        <td>${esc(e.repo)} @ ${esc(e.branch)}</td><td>${esc(e.instanceType)}${e.spot ? ' <span class="tag">spot</span>' : ""}</td>
        <td>${stateTag(e.state)}</td>
        <td>${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.slug)}</a>` : esc(e.ip ?? "-")}</td>
        <td>${esc(when(Date.parse(e.createdAt)))}</td><td class="row">${actions}</td></tr>`;
    });
    return `<div class="card tablebox"><table><thead><tr><th>env</th><th>owner</th><th>repo @ branch</th><th>instance</th><th>state</th><th>address</th><th>created</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  },

  async history() {
    const f = state.historyFilter ?? {};
    const q = new URLSearchParams({ days: state.days, ...(f.owner ? { owner: f.owner } : {}), ...(f.status ? { status: f.status } : {}) });
    const [machines, all] = await Promise.all([api(`/v1/machines?${q}`), api(`/v1/machines?days=${state.days}`)]);
    const owners = [...new Set(all.map((m) => m.owner))].sort();
    const ended = { destroy: "destroyed", ttl: "TTL policy", vanished: "terminated outside runo" };
    const rows = machines.map((m) => `<tr>
      <td title="${esc(m.instanceId)}">${esc(m.repo ?? "-")} @ ${esc(m.branch ?? "-")}<div class="dim small">${esc(m.envName)}</div></td>
      <td>${esc(m.owner)}</td>
      <td>${esc(m.instanceType ?? "?")}${m.spot ? ' <span class="tag">spot</span>' : ""}${m.diskGb ? ` <span class="dim">${m.diskGb}GB</span>` : ""}</td>
      <td>${esc(when(m.createdAt))}</td>
      <td>${m.endedAt ? `${esc(when(m.endedAt))}<div class="dim small">${esc(ended[m.endReason] ?? m.endReason)}${m.endedBy && m.endedBy !== "system" ? ` by ${esc(m.endedBy)}` : ""}</div>` : stateTag(m.running ? "running" : "stopped")}</td>
      <td class="num">${hours(m.runningHours)}<div class="dim small">of ${hours(m.aliveHours)}</div></td>
      <td class="num">${usd(m.cost)}${m.priced ? "" : ' <span class="tag" title="no price for this instance type">partial</span>'}</td></tr>`);
    return `<div class="row filters">
        <label class="range">who asked <select data-filter="owner"><option value="">everyone</option>${owners.map((o) => `<option ${f.owner === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></label>
        <label class="range">status <select data-filter="status">${[["", "all"], ["alive", "alive"], ["ended", "ended"]].map(([v, l]) => `<option value="${v}" ${f.status === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <span class="dim small">${machines.length} machines · ${usd(machines.reduce((s, m) => s + m.cost, 0))} in the last ${state.days} days</span>
      </div>
      <div class="card tablebox"><table><thead><tr><th>repo @ branch</th><th>who asked</th><th>instance</th><th>created</th><th>ended / state</th><th class="num">running</th><th class="num">est. cost</th></tr></thead>
      <tbody>${rows.join("") || `<tr><td colspan="7" class="empty">no machines in this window — history starts when this version of the server first ran</td></tr>`}</tbody></table></div>`;
  },

  async activity() {
    const events = await api("/v1/events?limit=200");
    const detail = (e) => {
      const d = e.detail ?? {};
      if (e.action === "create") return `${d.instanceType ?? ""} ${d.diskGb ? d.diskGb + "GB" : ""} ${d.spot ? "spot" : ""} · ${d.repo ?? ""} @ ${d.branch ?? ""}`;
      if (e.action === "share") return `members: ${(d.members ?? []).join(", ") || "none"}`;
      if (e.action === "login") return `via ${d.via}${d.from ? " from " + d.from : ""}`;
      if (e.action.startsWith("token.")) return `"${d.name}" for ${d.user}`;
      if (e.action === "user.update") return `${d.login}: ${["role" in d ? "role " + d.role : "", "disabled" in d ? (d.disabled ? "disabled" : "enabled") : ""].filter(Boolean).join(", ")}`;
      if (e.action === "user.create") return `${d.login} (service account)`;
      if (e.action === "policies.update") return JSON.stringify(d.after);
      if (e.action === "pool.scale") return `target ${d.target}`;
      return "";
    };
    const rows = events.map((e) => `<tr><td>${esc(when(e.ts))}</td><td>${esc(e.actor)}</td><td>${esc(e.action)}</td><td>${esc(e.envName ?? "")}</td><td class="dim">${esc(detail(e))}</td></tr>`);
    return `<div class="card tablebox"><table><thead><tr><th>when</th><th>who</th><th>what</th><th>env</th><th>detail</th></tr></thead>
      <tbody>${rows.join("") || `<tr><td colspan="5" class="empty">nothing yet</td></tr>`}</tbody></table></div>`;
  },

  async settings() {
    const admin = state.me.admin;
    const [tokens, policies, pricing, users, server] = await Promise.all([
      api(`/v1/tokens${admin ? "?all=1" : ""}`),
      api("/v1/policies"),
      api("/v1/pricing"),
      admin ? api("/v1/users") : null,
      admin ? api("/v1/server") : null,
    ]);
    const services = (users ?? []).filter((u) => u.source === "service" && !u.disabled);
    const secret = state.newToken
      ? `<div class="secret">Copy it now — it is shown once and stored only as a hash.<code>${esc(state.newToken)}</code>
         <span class="dim">export RUNO_SERVER=${esc(location.origin)} RUNO_TOKEN=…</span></div>`
      : "";
    state.newToken = null;
    const tokenRows = tokens.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.user)}</td><td class="dim">${esc(t.prefix)}…</td><td>${esc(when(t.createdAt))}</td>
      <td>${t.revokedAt ? '<span class="dim">revoked</span>' : esc(t.lastUsedAt ? when(t.lastUsedAt) : "never used")}</td>
      <td>${t.revokedAt ? "" : `<button class="danger" data-action="revoke" data-id="${t.id}" data-name="${esc(t.name)}">revoke</button>`}</td></tr>`);
    const tokenSection = `<div class="section"><h2>CLI tokens</h2>
      <form class="row" data-form="token"><input name="name" placeholder='where will it live? e.g. "macbook"' maxlength="60" required />
        ${services.length ? `<select name="user"><option value="">for me</option>${services.map((u) => `<option value="${esc(u.login)}">for ${esc(u.login)}</option>`).join("")}</select>` : ""}
        <button type="submit">create token</button></form>${secret}
      <div class="card tablebox"><table><thead><tr><th>name</th><th>identity</th><th>token</th><th>created</th><th>last used</th><th></th></tr></thead>
      <tbody>${tokenRows.join("") || `<tr><td colspan="6" class="empty">no tokens — create one to use the runo CLI against this server</td></tr>`}</tbody></table></div></div>`;
    if (!admin) return tokenSection;

    const val = (v) => esc(v ?? "");
    const policySection = `<div class="section"><h2>Policies</h2>
      <form class="settings card" data-form="policies">
        <label>Allowed instance types (comma separated; empty = any)<input name="allowed_instance_types" value="${val(policies.allowed_instance_types?.join(", "))}" /></label>
        <label>Max disk per environment, GB<input name="max_disk_gb" type="number" min="1" value="${val(policies.max_disk_gb)}" /></label>
        <label>Max environments per person<input name="max_envs_per_user" type="number" min="1" value="${val(policies.max_envs_per_user)}" /></label>
        <label>Max machines running at once, whole org<input name="max_running_total" type="number" min="1" value="${val(policies.max_running_total)}" /></label>
        <label>Destroy environments older than, days (fractions allowed)<input name="env_ttl_days" type="number" min="0" step="any" value="${val(policies.env_ttl_days)}" /></label>
        <div class="row"><button type="submit" class="primary">save policies</button><span class="dim small">Empty = unlimited. Applies to the next create; the TTL sweeper runs every 10 minutes.</span></div>
      </form></div>`;

    const p = pricing.pricing;
    const priceSection = `<div class="section"><h2>Prices <span class="dim small">(${esc(pricing.region)}${pricing.custom ? ", edited" : ", built-in defaults"})</span></h2>
      <form class="settings card" data-form="pricing">
        <label>USD per running hour, one "type price" per line<textarea name="instance_hourly" spellcheck="false">${esc(Object.entries(p.instance_hourly).map(([t, v]) => `${t} ${v}`).join("\n"))}</textarea></label>
        <label>Spot factor (0–1; 1 prices spot as on-demand, a ceiling)<input name="spot_factor" type="number" min="0" max="1" step="any" value="${p.spot_factor}" /></label>
        <label>gp3 storage, USD per GB-month<input name="ebs_gb_month" type="number" min="0" step="any" value="${p.ebs_gb_month}" /></label>
        <label>Extra IOPS/throughput, USD per volume-month<input name="ebs_extra_month" type="number" min="0" step="any" value="${p.ebs_extra_month}" /></label>
        <label>Public IPv4, USD per running hour<input name="ipv4_hourly" type="number" min="0" step="any" value="${p.ipv4_hourly}" /></label>
        <div class="row"><button type="submit" class="primary">save prices</button><button type="button" data-action="reset-pricing">reset to defaults</button>
          <span class="dim small">Changing a price re-prices all history.</span></div>
      </form></div>`;

    const userRows = users.map((u) => `<tr><td>${esc(u.login)}${u.name ? ` <span class="dim">${esc(u.name)}</span>` : ""}</td><td>${esc(u.source)}</td>
      <td>${u.role === "admin" ? '<span class="tag">admin</span>' : "member"}${u.disabled ? ' <span class="tag">disabled</span>' : ""}</td>
      <td>${esc(u.lastLoginAt ? when(u.lastLoginAt) : "-")}</td>
      <td class="row">${u.locked || u.login === state.me.user ? `<span class="dim small">${u.login === state.me.user ? "you" : "set in the server env"}</span>` : `
        ${u.source === "service" ? "" : `<button data-action="role" data-login="${esc(u.login)}" data-role="${u.role === "admin" ? "member" : "admin"}">${u.role === "admin" ? "remove admin" : "make admin"}</button>`}
        <button class="${u.disabled ? "" : "danger"}" data-action="disable" data-login="${esc(u.login)}" data-disabled="${u.disabled ? "0" : "1"}">${u.disabled ? "enable" : "disable"}</button>`}</td></tr>`);
    const userSection = `<div class="section"><h2>People and service accounts</h2>
      <form class="row" data-form="service"><input name="login" placeholder="new service account, e.g. preview-ci" pattern="[a-z0-9][a-z0-9-]*" maxlength="39" required /><button type="submit">add service account</button></form>
      <p class="dim small">People appear here after their first GitHub login. Disabling someone ends their sessions and stops all their tokens at once.</p>
      <div class="card tablebox"><table><thead><tr><th>login</th><th>source</th><th>role</th><th>last login</th><th></th></tr></thead><tbody>${userRows.join("")}</tbody></table></div></div>`;

    const gh = server.github;
    const serverSection = `<div class="section"><h2>Server <span class="dim small">(read-only — set in the server's environment file)</span></h2>
      <div class="card"><dl class="info">
        <dt>region</dt><dd>${esc(server.region)}</dd>
        <dt>expected AWS identity</dt><dd>${esc(server.expectedAwsArn ?? "not pinned")}</dd>
        <dt>hard instance ceiling</dt><dd>${esc(server.maxInstances)} (RUNO_MAX_INSTANCES)</dd>
        <dt>warm pool</dt><dd>${server.pool === null ? "-" : esc(server.pool) + " instances"}</dd>
        <dt>public URL</dt><dd>${esc(server.publicUrl ?? "not set")}</dd>
        <dt>ingress domain</dt><dd>${esc(server.ingressDomain ?? "off")}</dd>
        <dt>GitHub login</dt><dd>${gh ? esc([...gh.allowedOrgs.map((o) => "org " + o), ...gh.allowedUsers.map((u) => "@" + u)].join(", ")) + ` <span class="dim">via ${esc(gh.url)}</span>` : "off"}</dd>
        <dt>admins from env</dt><dd>${esc(server.envAdmins.join(", ") || "none")}</dd>
        <dt>session length</dt><dd>${esc(server.sessionHours)}h</dd>
        <dt>state directory</dt><dd>${esc(server.home)}</dd>
      </dl></div></div>`;
    return policySection + priceSection + userSection + tokenSection + serverSection;
  },
};

async function render() {
  clearTimeout(state.timer);
  for (const b of $("tabs").querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === state.tab));
  await run("loading", async () => {
    $("view").innerHTML = await views[state.tab]();
  });
  // live views refresh themselves; forms must not be redrawn under the user's cursor
  if (state.tab === "overview" || state.tab === "envs") state.timer = setTimeout(() => !document.hidden && render(), 30_000);
}

// ---------- actions (delegated: the CSP allows no inline handlers) ----------

const rpc = (method, id) => api("/v1/rpc", { method: "POST", body: { method, args: [{ id }] } });
const numberOrNull = (v) => (v === "" ? null : Number(v));

const actions = {
  suspend: (d) => rpc("suspend", d.id),
  resume: (d) => rpc("resume", d.id),
  destroy: (d) => confirm(`Terminate ${d.name} (${d.id})? Its disk is destroyed.`) && rpc("destroy", d.id),
  revoke: (d) => confirm(`Revoke token "${d.name}"? Whatever uses it stops working now.`) && api(`/v1/tokens/${d.id}`, { method: "DELETE" }),
  role: (d) => confirm(`${d.role === "admin" ? "Make" : "Remove"} ${d.login} ${d.role === "admin" ? "an admin" : "from admins"}?`) && api(`/v1/users/${encodeURIComponent(d.login)}`, { method: "PATCH", body: { role: d.role } }),
  disable: (d) => (d.disabled === "0" || confirm(`Disable ${d.login}? Their sessions end and their tokens stop working.`)) && api(`/v1/users/${encodeURIComponent(d.login)}`, { method: "PATCH", body: { disabled: d.disabled === "1" } }),
  "reset-pricing": () => confirm("Replace the price table with the built-in defaults?") && api("/v1/pricing", { method: "PUT", body: { reset: true } }),
};

const forms = {
  async token(f) {
    state.newToken = (await api("/v1/tokens", { method: "POST", body: { name: f.get("name"), user: f.get("user") || undefined } })).token;
  },
  service: (f) => api("/v1/users", { method: "POST", body: { login: f.get("login") } }),
  policies: (f) => api("/v1/policies", { method: "PUT", body: {
    allowed_instance_types: String(f.get("allowed_instance_types")).split(",").map((s) => s.trim()).filter(Boolean),
    max_disk_gb: numberOrNull(f.get("max_disk_gb")), max_envs_per_user: numberOrNull(f.get("max_envs_per_user")),
    max_running_total: numberOrNull(f.get("max_running_total")), env_ttl_days: numberOrNull(f.get("env_ttl_days")),
  } }),
  pricing: (f) => api("/v1/pricing", { method: "PUT", body: {
    instance_hourly: Object.fromEntries(String(f.get("instance_hourly")).split("\n").map((l) => l.trim().split(/[\s:=]+/)).filter((p) => p[0]).map(([t, v]) => [t, Number(v)])),
    spot_factor: Number(f.get("spot_factor")), ebs_gb_month: Number(f.get("ebs_gb_month")),
    ebs_extra_month: Number(f.get("ebs_extra_month")), ipv4_hourly: Number(f.get("ipv4_hourly")),
  } }),
};

$("view").addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-action]");
  if (!el) return;
  run(el.dataset.action, async () => {
    if ((await actions[el.dataset.action](el.dataset)) !== false) await render();
  });
});
$("view").addEventListener("submit", (ev) => {
  const form = ev.target.closest("[data-form]");
  if (!form) return;
  ev.preventDefault();
  run("saving", async () => {
    await forms[form.dataset.form](new FormData(form));
    await render();
  });
});
$("view").addEventListener("change", (ev) => {
  const key = ev.target.dataset?.filter;
  if (!key) return;
  state.historyFilter = { ...(state.historyFilter ?? {}), [key]: ev.target.value };
  render();
});
$("tabs").addEventListener("click", (ev) => {
  const tab = ev.target.closest("[data-tab]")?.dataset.tab;
  if (!tab) return;
  state.tab = tab;
  history.replaceState(null, "", "#" + tab);
  render();
});
$("days").addEventListener("change", (ev) => {
  state.days = Number(ev.target.value);
  render();
});

// ---------- session ----------

async function logout() {
  await api("/auth/logout", { method: "POST" }).catch(() => {});
  showLogin();
}
$("logout").addEventListener("click", logout);

$("tokenForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    await api("/auth/token", { method: "POST", body: { token: $("token").value } });
    $("token").value = "";
    await start();
  } catch (err) {
    loginError(err.message);
  }
});

function loginError(text) {
  $("loginError").textContent = text;
  $("loginError").hidden = !text;
}

function showLogin() {
  clearTimeout(state.timer);
  state.me = null;
  $("app").hidden = $("who").hidden = true;
  $("login").hidden = false;
}

async function start() {
  const config = await api("/auth/config").catch(() => ({ github: false }));
  state.github = config.github;
  $("githubLogin").hidden = !config.github;
  $("tokenLogin").open = !config.github;
  if (location.hash.startsWith("#login-error=")) {
    loginError(decodeURIComponent(location.hash.slice("#login-error=".length)));
    history.replaceState(null, "", "/");
  }
  try {
    state.me = await api("/v1/me");
  } catch {
    return showLogin();
  }
  $("login").hidden = true;
  $("app").hidden = $("who").hidden = false;
  $("whoName").textContent = state.me.name ? `${state.me.name} (${state.me.user})` : state.me.user;
  $("whoRole").hidden = !state.me.admin;
  $("avatar").hidden = !state.me.avatar;
  if (state.me.avatar) $("avatar").src = state.me.avatar;
  if (views[location.hash.slice(1)]) state.tab = location.hash.slice(1);
  await render();
}

start();
