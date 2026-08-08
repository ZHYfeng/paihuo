(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __esm = (fn, res, err) => function __init() {
    if (err) throw err[0];
    try {
      return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
    } catch (e5) {
      throw err = [e5], e5;
    }
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // internal/web/static/src/core.js
  var core_exports = {};
  __export(core_exports, {
    BOARD_COLS: () => BOARD_COLS,
    ICONS: () => ICONS,
    PERM_LABEL: () => PERM_LABEL,
    STATUS_LABEL: () => STATUS_LABEL,
    ST_COLOR: () => ST_COLOR,
    activeModal: () => activeModal,
    api: () => api,
    closeModal: () => closeModal,
    esc: () => esc,
    fetchTaskLogs: () => fetchTaskLogs,
    fmtDur: () => fmtDur,
    fmtNum: () => fmtNum,
    fmtPct: () => fmtPct,
    icon: () => icon,
    logout: () => logout,
    openModal: () => openModal,
    state: () => state,
    toast: () => toast
  });
  function esc(s5) {
    return String(s5 ?? "").replace(/[&<>"']/g, (c5) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c5]);
  }
  function icon(name, cls) {
    return `<svg class="ic ${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] || ""}"/></svg>`;
  }
  function fmtPct(x2) {
    return Math.round(x2 * 10) / 10 + "%";
  }
  function fmtNum(x2) {
    return Math.round(x2 * 10) / 10;
  }
  function fmtDur(sec) {
    if (!sec || sec <= 0) return "-";
    if (sec < 60) return Math.round(sec) + "s";
    if (sec < 3600) return Math.round(sec / 60) + "m";
    return Math.round(sec / 360) / 10 + "h";
  }
  function toast(msg, isErr) {
    const t5 = document.getElementById("toast");
    if (!t5) return;
    t5.innerHTML = `${icon(isErr ? "alert" : "check")}<span>${esc(msg)}</span>`;
    t5.className = "toast" + (isErr ? " error" : "");
    clearTimeout(t5._timer);
    t5._timer = setTimeout(() => t5.classList.add("hidden"), 3e3);
  }
  async function api(path, opts = {}) {
    const headers = { ...opts.headers || {} };
    if (opts.body !== void 0) headers["Content-Type"] = "application/json";
    const res = await fetch(path, { ...opts, headers });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = (await res.json()).error || msg;
      } catch (_2) {
      }
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }
  async function fetchTaskLogs(id, options = {}) {
    const params = new URLSearchParams();
    if (options.all) params.set("all", "1");
    else {
      params.set("limit", String(options.limit || 200));
      if (options.before) params.set("before", String(options.before));
    }
    const data = await api(`/api/tasks/${id}/logs?${params}`);
    if (Array.isArray(data)) return { logs: data, has_more: false, total: data.length };
    return {
      logs: Array.isArray(data?.logs) ? data.logs : [],
      has_more: Boolean(data?.has_more),
      total: Number(data?.total) || 0
    };
  }
  function activeModal() {
    const modals = document.querySelectorAll(".modal:not(.hidden)");
    return modals.length ? modals[modals.length - 1] : null;
  }
  function syncModalLayer() {
    const main = document.querySelector(".main");
    if (!main) return;
    main.classList.toggle("modal-layer", Boolean(main.querySelector(".modal:not(.hidden)")));
  }
  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    const previous = activeModal();
    if (previous && previous !== modal) {
      previous.setAttribute("aria-hidden", "true");
      previous.removeAttribute("aria-modal");
    }
    modal._returnFocus = document.activeElement;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-hidden", "false");
    const label = modal.querySelector("[data-modal-title], h1, h2, h3, .t-title");
    if (label) {
      if (!label.id) label.id = `${id}Label`;
      modal.setAttribute("aria-labelledby", label.id);
    }
    modal.classList.remove("hidden");
    syncModalLayer();
    const target = modal.querySelector("[data-autofocus], [autofocus]") || modal.querySelector("input:not([type='hidden']), textarea, select, button, [href], [tabindex]:not([tabindex='-1'])");
    target?.focus({ preventScroll: true });
  }
  function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add("hidden");
    syncModalLayer();
    modal.setAttribute("aria-hidden", "true");
    modal.removeAttribute("aria-modal");
    const previous = activeModal();
    if (previous) {
      previous.setAttribute("aria-hidden", "false");
      previous.setAttribute("aria-modal", "true");
    }
    const trigger = modal._returnFocus;
    modal._returnFocus = null;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }
  async function logout() {
    try {
      await fetch("/logout", { method: "POST" });
    } catch (_2) {
    }
    location.href = "/login";
  }
  var state, STATUS_LABEL, PERM_LABEL, ST_COLOR, BOARD_COLS, ICONS;
  var init_core = __esm({
    "internal/web/static/src/core.js"() {
      init_agents();
      state = {
        tasks: [],
        agents: [],
        schedules: [],
        templates: [],
        projects: [],
        schema: {},
        // cli -> {id, name, docs, fields}
        overview: null,
        // 总览统计
        agentStats: {},
        // agentId -> stats
        projectStats: {},
        // projectId -> stats
        view: "board",
        selected: null,
        logs: [],
        logsTask: null,
        logsHasMore: false,
        logsLoading: false,
        logsOldestSeq: 0,
        logFilter: "all",
        logsTotal: 0,
        termTask: null,
        es: null,
        // SSE 连接（隐藏时断开、可见时重连）
        history: [],
        historySel: /* @__PURE__ */ new Set(),
        agentEditing: null,
        agentTab: "overview",
        roleStudio: null,
        // 唯一角色编辑器的草稿、助手对话与测试对话
        projectView: null,
        // 项目详情中的项目 id
        projectReorderBusy: false,
        agentView: "grid",
        agentSort: "name-asc",
        skillLib: [],
        // 注册到 paihuo 工作目录的技能库 [{id,name,description,tags,dir}]
        skillSelected: /* @__PURE__ */ new Set(),
        // Skills 管理页当前勾选的技能 id
        skillDetail: null,
        // 当前打开的技能详情（含 SKILL.md 内容）
        skillView: "grid"
        // Skills 管理页显示模式：grid | list
      };
      STATUS_LABEL = {
        queued: "\u5F85\u6267\u884C",
        claimed: "\u9886\u53D6\u4E2D",
        running: "\u6267\u884C\u4E2D",
        awaiting_review: "\u5F85\u5BA1\u6279",
        succeeded: "\u5B8C\u6210",
        failed: "\u5931\u8D25",
        cancelled: "\u5DF2\u53D6\u6D88"
      };
      PERM_LABEL = { full: "\u81EA\u52A8\u6D3E\u53D1\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1", review: "\u5BA1\u6279\u540E Agent \u5408\u5E76" };
      ST_COLOR = {
        queued: "var(--st-queued)",
        claimed: "var(--st-claimed)",
        running: "var(--st-running)",
        awaiting_review: "var(--st-review)",
        succeeded: "var(--st-done)",
        failed: "var(--st-failed)",
        cancelled: "var(--st-cancel)"
      };
      BOARD_COLS = [
        ["queue", "\u6392\u961F", ["queued", "claimed"]],
        ["running", "\u6267\u884C\u4E2D", ["running"]],
        ["awaiting_review", "\u5F85\u5BA1\u6279", ["awaiting_review"]]
      ];
      ICONS = {
        plus: "M12 5v14M5 12h14",
        back: "M19 12H5M12 19l-7-7 7-7",
        retry: "M16 8H5M9 12l-4-4 4-4M5 8v5a9 9 0 0 0 14 5",
        trash: "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6",
        copy: "M9 9h12v12H9zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
        expand: "M15 3h6v6M21 3l-7 7M9 21H3v-6M3 21l7-7",
        check: "M20 6 9 17l-5-5",
        x: "M18 6 6 18M6 6l12 12",
        search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3",
        folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
        robot: "M4 10a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8Zm5-2V6a3 3 0 0 1 6 0v2M9 15h.01M15 15h.01",
        clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 3",
        bookmark: "M6 3h12v18l-6-4-6 4V3Z",
        gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1m0-14.2-2.1 2.1m-10 10-2.1 2.1",
        logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9",
        board: "M3 3h7v8H3zM14 3h7v5h-7zM14 11h7v10h-7zM3 14h7v7H3z",
        calendar: "M8 2v4m8-4v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
        zap: "M13 2 3 14h7l-1 8 10-12h-7l1-8Z",
        sparkle: "M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6L12 3Z",
        history: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 3",
        terminal: "M4 17l6-5-6-5m8 10h8",
        chevL: "M15 18l-6-6 6-6",
        alert: "M12 3 2.5 20h19L12 3Zm0 7v5m0 3.5v.5",
        arrowUp: "M12 19V5m-6 6 6-6 6 6",
        arrowDown: "M12 5v14m6-6-6 6-6-6",
        grip: "M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"
      };
    }
  });

  // node_modules/@lit/reactive-element/css-tag.js
  var t, e, s, o, n, r, i, S, c;
  var init_css_tag = __esm({
    "node_modules/@lit/reactive-element/css-tag.js"() {
      t = globalThis;
      e = t.ShadowRoot && (void 0 === t.ShadyCSS || t.ShadyCSS.nativeShadow) && "adoptedStyleSheets" in Document.prototype && "replace" in CSSStyleSheet.prototype;
      s = /* @__PURE__ */ Symbol();
      o = /* @__PURE__ */ new WeakMap();
      n = class {
        constructor(t5, e5, o7) {
          if (this._$cssResult$ = true, o7 !== s) throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");
          this.cssText = t5, this.t = e5;
        }
        get styleSheet() {
          let t5 = this.o;
          const s5 = this.t;
          if (e && void 0 === t5) {
            const e5 = void 0 !== s5 && 1 === s5.length;
            e5 && (t5 = o.get(s5)), void 0 === t5 && ((this.o = t5 = new CSSStyleSheet()).replaceSync(this.cssText), e5 && o.set(s5, t5));
          }
          return t5;
        }
        toString() {
          return this.cssText;
        }
      };
      r = (t5) => new n("string" == typeof t5 ? t5 : t5 + "", void 0, s);
      i = (t5, ...e5) => {
        const o7 = 1 === t5.length ? t5[0] : e5.reduce((e6, s5, o8) => e6 + ((t6) => {
          if (true === t6._$cssResult$) return t6.cssText;
          if ("number" == typeof t6) return t6;
          throw Error("Value passed to 'css' function must be a 'css' function result: " + t6 + ". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.");
        })(s5) + t5[o8 + 1], t5[0]);
        return new n(o7, t5, s);
      };
      S = (s5, o7) => {
        if (e) s5.adoptedStyleSheets = o7.map((t5) => t5 instanceof CSSStyleSheet ? t5 : t5.styleSheet);
        else for (const e5 of o7) {
          const o8 = document.createElement("style"), n6 = t.litNonce;
          void 0 !== n6 && o8.setAttribute("nonce", n6), o8.textContent = e5.cssText, s5.appendChild(o8);
        }
      };
      c = e ? (t5) => t5 : (t5) => t5 instanceof CSSStyleSheet ? ((t6) => {
        let e5 = "";
        for (const s5 of t6.cssRules) e5 += s5.cssText;
        return r(e5);
      })(t5) : t5;
    }
  });

  // node_modules/@lit/reactive-element/reactive-element.js
  var i2, e2, h, r2, o2, n2, a, c2, l, p, d, u, f, b, y;
  var init_reactive_element = __esm({
    "node_modules/@lit/reactive-element/reactive-element.js"() {
      init_css_tag();
      init_css_tag();
      ({ is: i2, defineProperty: e2, getOwnPropertyDescriptor: h, getOwnPropertyNames: r2, getOwnPropertySymbols: o2, getPrototypeOf: n2 } = Object);
      a = globalThis;
      c2 = a.trustedTypes;
      l = c2 ? c2.emptyScript : "";
      p = a.reactiveElementPolyfillSupport;
      d = (t5, s5) => t5;
      u = { toAttribute(t5, s5) {
        switch (s5) {
          case Boolean:
            t5 = t5 ? l : null;
            break;
          case Object:
          case Array:
            t5 = null == t5 ? t5 : JSON.stringify(t5);
        }
        return t5;
      }, fromAttribute(t5, s5) {
        let i6 = t5;
        switch (s5) {
          case Boolean:
            i6 = null !== t5;
            break;
          case Number:
            i6 = null === t5 ? null : Number(t5);
            break;
          case Object:
          case Array:
            try {
              i6 = JSON.parse(t5);
            } catch (t6) {
              i6 = null;
            }
        }
        return i6;
      } };
      f = (t5, s5) => !i2(t5, s5);
      b = { attribute: true, type: String, converter: u, reflect: false, useDefault: false, hasChanged: f };
      Symbol.metadata ?? (Symbol.metadata = /* @__PURE__ */ Symbol("metadata")), a.litPropertyMetadata ?? (a.litPropertyMetadata = /* @__PURE__ */ new WeakMap());
      y = class extends HTMLElement {
        static addInitializer(t5) {
          this._$Ei(), (this.l ?? (this.l = [])).push(t5);
        }
        static get observedAttributes() {
          return this.finalize(), this._$Eh && [...this._$Eh.keys()];
        }
        static createProperty(t5, s5 = b) {
          if (s5.state && (s5.attribute = false), this._$Ei(), this.prototype.hasOwnProperty(t5) && ((s5 = Object.create(s5)).wrapped = true), this.elementProperties.set(t5, s5), !s5.noAccessor) {
            const i6 = /* @__PURE__ */ Symbol(), h4 = this.getPropertyDescriptor(t5, i6, s5);
            void 0 !== h4 && e2(this.prototype, t5, h4);
          }
        }
        static getPropertyDescriptor(t5, s5, i6) {
          const { get: e5, set: r6 } = h(this.prototype, t5) ?? { get() {
            return this[s5];
          }, set(t6) {
            this[s5] = t6;
          } };
          return { get: e5, set(s6) {
            const h4 = e5?.call(this);
            r6?.call(this, s6), this.requestUpdate(t5, h4, i6);
          }, configurable: true, enumerable: true };
        }
        static getPropertyOptions(t5) {
          return this.elementProperties.get(t5) ?? b;
        }
        static _$Ei() {
          if (this.hasOwnProperty(d("elementProperties"))) return;
          const t5 = n2(this);
          t5.finalize(), void 0 !== t5.l && (this.l = [...t5.l]), this.elementProperties = new Map(t5.elementProperties);
        }
        static finalize() {
          if (this.hasOwnProperty(d("finalized"))) return;
          if (this.finalized = true, this._$Ei(), this.hasOwnProperty(d("properties"))) {
            const t6 = this.properties, s5 = [...r2(t6), ...o2(t6)];
            for (const i6 of s5) this.createProperty(i6, t6[i6]);
          }
          const t5 = this[Symbol.metadata];
          if (null !== t5) {
            const s5 = litPropertyMetadata.get(t5);
            if (void 0 !== s5) for (const [t6, i6] of s5) this.elementProperties.set(t6, i6);
          }
          this._$Eh = /* @__PURE__ */ new Map();
          for (const [t6, s5] of this.elementProperties) {
            const i6 = this._$Eu(t6, s5);
            void 0 !== i6 && this._$Eh.set(i6, t6);
          }
          this.elementStyles = this.finalizeStyles(this.styles);
        }
        static finalizeStyles(s5) {
          const i6 = [];
          if (Array.isArray(s5)) {
            const e5 = new Set(s5.flat(1 / 0).reverse());
            for (const s6 of e5) i6.unshift(c(s6));
          } else void 0 !== s5 && i6.push(c(s5));
          return i6;
        }
        static _$Eu(t5, s5) {
          const i6 = s5.attribute;
          return false === i6 ? void 0 : "string" == typeof i6 ? i6 : "string" == typeof t5 ? t5.toLowerCase() : void 0;
        }
        constructor() {
          super(), this._$Ep = void 0, this.isUpdatePending = false, this.hasUpdated = false, this._$Em = null, this._$Ev();
        }
        _$Ev() {
          this._$ES = new Promise((t5) => this.enableUpdating = t5), this._$AL = /* @__PURE__ */ new Map(), this._$E_(), this.requestUpdate(), this.constructor.l?.forEach((t5) => t5(this));
        }
        addController(t5) {
          (this._$EO ?? (this._$EO = /* @__PURE__ */ new Set())).add(t5), void 0 !== this.renderRoot && this.isConnected && t5.hostConnected?.();
        }
        removeController(t5) {
          this._$EO?.delete(t5);
        }
        _$E_() {
          const t5 = /* @__PURE__ */ new Map(), s5 = this.constructor.elementProperties;
          for (const i6 of s5.keys()) this.hasOwnProperty(i6) && (t5.set(i6, this[i6]), delete this[i6]);
          t5.size > 0 && (this._$Ep = t5);
        }
        createRenderRoot() {
          const t5 = this.shadowRoot ?? this.attachShadow(this.constructor.shadowRootOptions);
          return S(t5, this.constructor.elementStyles), t5;
        }
        connectedCallback() {
          this.renderRoot ?? (this.renderRoot = this.createRenderRoot()), this.enableUpdating(true), this._$EO?.forEach((t5) => t5.hostConnected?.());
        }
        enableUpdating(t5) {
        }
        disconnectedCallback() {
          this._$EO?.forEach((t5) => t5.hostDisconnected?.());
        }
        attributeChangedCallback(t5, s5, i6) {
          this._$AK(t5, i6);
        }
        _$ET(t5, s5) {
          const i6 = this.constructor.elementProperties.get(t5), e5 = this.constructor._$Eu(t5, i6);
          if (void 0 !== e5 && true === i6.reflect) {
            const h4 = (void 0 !== i6.converter?.toAttribute ? i6.converter : u).toAttribute(s5, i6.type);
            this._$Em = t5, null == h4 ? this.removeAttribute(e5) : this.setAttribute(e5, h4), this._$Em = null;
          }
        }
        _$AK(t5, s5) {
          const i6 = this.constructor, e5 = i6._$Eh.get(t5);
          if (void 0 !== e5 && this._$Em !== e5) {
            const t6 = i6.getPropertyOptions(e5), h4 = "function" == typeof t6.converter ? { fromAttribute: t6.converter } : void 0 !== t6.converter?.fromAttribute ? t6.converter : u;
            this._$Em = e5;
            const r6 = h4.fromAttribute(s5, t6.type);
            this[e5] = r6 ?? this._$Ej?.get(e5) ?? r6, this._$Em = null;
          }
        }
        requestUpdate(t5, s5, i6, e5 = false, h4) {
          if (void 0 !== t5) {
            const r6 = this.constructor;
            if (false === e5 && (h4 = this[t5]), i6 ?? (i6 = r6.getPropertyOptions(t5)), !((i6.hasChanged ?? f)(h4, s5) || i6.useDefault && i6.reflect && h4 === this._$Ej?.get(t5) && !this.hasAttribute(r6._$Eu(t5, i6)))) return;
            this.C(t5, s5, i6);
          }
          false === this.isUpdatePending && (this._$ES = this._$EP());
        }
        C(t5, s5, { useDefault: i6, reflect: e5, wrapped: h4 }, r6) {
          i6 && !(this._$Ej ?? (this._$Ej = /* @__PURE__ */ new Map())).has(t5) && (this._$Ej.set(t5, r6 ?? s5 ?? this[t5]), true !== h4 || void 0 !== r6) || (this._$AL.has(t5) || (this.hasUpdated || i6 || (s5 = void 0), this._$AL.set(t5, s5)), true === e5 && this._$Em !== t5 && (this._$Eq ?? (this._$Eq = /* @__PURE__ */ new Set())).add(t5));
        }
        async _$EP() {
          this.isUpdatePending = true;
          try {
            await this._$ES;
          } catch (t6) {
            Promise.reject(t6);
          }
          const t5 = this.scheduleUpdate();
          return null != t5 && await t5, !this.isUpdatePending;
        }
        scheduleUpdate() {
          return this.performUpdate();
        }
        performUpdate() {
          if (!this.isUpdatePending) return;
          if (!this.hasUpdated) {
            if (this.renderRoot ?? (this.renderRoot = this.createRenderRoot()), this._$Ep) {
              for (const [t7, s6] of this._$Ep) this[t7] = s6;
              this._$Ep = void 0;
            }
            const t6 = this.constructor.elementProperties;
            if (t6.size > 0) for (const [s6, i6] of t6) {
              const { wrapped: t7 } = i6, e5 = this[s6];
              true !== t7 || this._$AL.has(s6) || void 0 === e5 || this.C(s6, void 0, i6, e5);
            }
          }
          let t5 = false;
          const s5 = this._$AL;
          try {
            t5 = this.shouldUpdate(s5), t5 ? (this.willUpdate(s5), this._$EO?.forEach((t6) => t6.hostUpdate?.()), this.update(s5)) : this._$EM();
          } catch (s6) {
            throw t5 = false, this._$EM(), s6;
          }
          t5 && this._$AE(s5);
        }
        willUpdate(t5) {
        }
        _$AE(t5) {
          this._$EO?.forEach((t6) => t6.hostUpdated?.()), this.hasUpdated || (this.hasUpdated = true, this.firstUpdated(t5)), this.updated(t5);
        }
        _$EM() {
          this._$AL = /* @__PURE__ */ new Map(), this.isUpdatePending = false;
        }
        get updateComplete() {
          return this.getUpdateComplete();
        }
        getUpdateComplete() {
          return this._$ES;
        }
        shouldUpdate(t5) {
          return true;
        }
        update(t5) {
          this._$Eq && (this._$Eq = this._$Eq.forEach((t6) => this._$ET(t6, this[t6]))), this._$EM();
        }
        updated(t5) {
        }
        firstUpdated(t5) {
        }
      };
      y.elementStyles = [], y.shadowRootOptions = { mode: "open" }, y[d("elementProperties")] = /* @__PURE__ */ new Map(), y[d("finalized")] = /* @__PURE__ */ new Map(), p?.({ ReactiveElement: y }), (a.reactiveElementVersions ?? (a.reactiveElementVersions = [])).push("2.1.2");
    }
  });

  // node_modules/lit-html/lit-html.js
  function V(t5, i6) {
    if (!u2(t5) || !t5.hasOwnProperty("raw")) throw Error("invalid template strings array");
    return void 0 !== e3 ? e3.createHTML(i6) : i6;
  }
  function M(t5, i6, s5 = t5, e5) {
    if (i6 === E) return i6;
    let h4 = void 0 !== e5 ? s5._$Co?.[e5] : s5._$Cl;
    const o7 = a2(i6) ? void 0 : i6._$litDirective$;
    return h4?.constructor !== o7 && (h4?._$AO?.(false), void 0 === o7 ? h4 = void 0 : (h4 = new o7(t5), h4._$AT(t5, s5, e5)), void 0 !== e5 ? (s5._$Co ?? (s5._$Co = []))[e5] = h4 : s5._$Cl = h4), void 0 !== h4 && (i6 = M(t5, h4._$AS(t5, i6.values), h4, e5)), i6;
  }
  var t2, i3, s2, e3, h2, o3, n3, r3, l2, c3, a2, u2, d2, f2, v, _, m, p2, g, $, y2, x, b2, w, T, E, A, C, P, N, S2, R, k, H, I, L, z, Z, j, B, D;
  var init_lit_html = __esm({
    "node_modules/lit-html/lit-html.js"() {
      t2 = globalThis;
      i3 = (t5) => t5;
      s2 = t2.trustedTypes;
      e3 = s2 ? s2.createPolicy("lit-html", { createHTML: (t5) => t5 }) : void 0;
      h2 = "$lit$";
      o3 = `lit$${Math.random().toFixed(9).slice(2)}$`;
      n3 = "?" + o3;
      r3 = `<${n3}>`;
      l2 = document;
      c3 = () => l2.createComment("");
      a2 = (t5) => null === t5 || "object" != typeof t5 && "function" != typeof t5;
      u2 = Array.isArray;
      d2 = (t5) => u2(t5) || "function" == typeof t5?.[Symbol.iterator];
      f2 = "[ 	\n\f\r]";
      v = /<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g;
      _ = /-->/g;
      m = />/g;
      p2 = RegExp(`>|${f2}(?:([^\\s"'>=/]+)(${f2}*=${f2}*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`, "g");
      g = /'/g;
      $ = /"/g;
      y2 = /^(?:script|style|textarea|title)$/i;
      x = (t5) => (i6, ...s5) => ({ _$litType$: t5, strings: i6, values: s5 });
      b2 = x(1);
      w = x(2);
      T = x(3);
      E = /* @__PURE__ */ Symbol.for("lit-noChange");
      A = /* @__PURE__ */ Symbol.for("lit-nothing");
      C = /* @__PURE__ */ new WeakMap();
      P = l2.createTreeWalker(l2, 129);
      N = (t5, i6) => {
        const s5 = t5.length - 1, e5 = [];
        let n6, l3 = 2 === i6 ? "<svg>" : 3 === i6 ? "<math>" : "", c5 = v;
        for (let i7 = 0; i7 < s5; i7++) {
          const s6 = t5[i7];
          let a3, u3, d3 = -1, f4 = 0;
          for (; f4 < s6.length && (c5.lastIndex = f4, u3 = c5.exec(s6), null !== u3); ) f4 = c5.lastIndex, c5 === v ? "!--" === u3[1] ? c5 = _ : void 0 !== u3[1] ? c5 = m : void 0 !== u3[2] ? (y2.test(u3[2]) && (n6 = RegExp("</" + u3[2], "g")), c5 = p2) : void 0 !== u3[3] && (c5 = p2) : c5 === p2 ? ">" === u3[0] ? (c5 = n6 ?? v, d3 = -1) : void 0 === u3[1] ? d3 = -2 : (d3 = c5.lastIndex - u3[2].length, a3 = u3[1], c5 = void 0 === u3[3] ? p2 : '"' === u3[3] ? $ : g) : c5 === $ || c5 === g ? c5 = p2 : c5 === _ || c5 === m ? c5 = v : (c5 = p2, n6 = void 0);
          const x2 = c5 === p2 && t5[i7 + 1].startsWith("/>") ? " " : "";
          l3 += c5 === v ? s6 + r3 : d3 >= 0 ? (e5.push(a3), s6.slice(0, d3) + h2 + s6.slice(d3) + o3 + x2) : s6 + o3 + (-2 === d3 ? i7 : x2);
        }
        return [V(t5, l3 + (t5[s5] || "<?>") + (2 === i6 ? "</svg>" : 3 === i6 ? "</math>" : "")), e5];
      };
      S2 = class _S {
        constructor({ strings: t5, _$litType$: i6 }, e5) {
          let r6;
          this.parts = [];
          let l3 = 0, a3 = 0;
          const u3 = t5.length - 1, d3 = this.parts, [f4, v2] = N(t5, i6);
          if (this.el = _S.createElement(f4, e5), P.currentNode = this.el.content, 2 === i6 || 3 === i6) {
            const t6 = this.el.content.firstChild;
            t6.replaceWith(...t6.childNodes);
          }
          for (; null !== (r6 = P.nextNode()) && d3.length < u3; ) {
            if (1 === r6.nodeType) {
              if (r6.hasAttributes()) for (const t6 of r6.getAttributeNames()) if (t6.endsWith(h2)) {
                const i7 = v2[a3++], s5 = r6.getAttribute(t6).split(o3), e6 = /([.?@])?(.*)/.exec(i7);
                d3.push({ type: 1, index: l3, name: e6[2], strings: s5, ctor: "." === e6[1] ? I : "?" === e6[1] ? L : "@" === e6[1] ? z : H }), r6.removeAttribute(t6);
              } else t6.startsWith(o3) && (d3.push({ type: 6, index: l3 }), r6.removeAttribute(t6));
              if (y2.test(r6.tagName)) {
                const t6 = r6.textContent.split(o3), i7 = t6.length - 1;
                if (i7 > 0) {
                  r6.textContent = s2 ? s2.emptyScript : "";
                  for (let s5 = 0; s5 < i7; s5++) r6.append(t6[s5], c3()), P.nextNode(), d3.push({ type: 2, index: ++l3 });
                  r6.append(t6[i7], c3());
                }
              }
            } else if (8 === r6.nodeType) if (r6.data === n3) d3.push({ type: 2, index: l3 });
            else {
              let t6 = -1;
              for (; -1 !== (t6 = r6.data.indexOf(o3, t6 + 1)); ) d3.push({ type: 7, index: l3 }), t6 += o3.length - 1;
            }
            l3++;
          }
        }
        static createElement(t5, i6) {
          const s5 = l2.createElement("template");
          return s5.innerHTML = t5, s5;
        }
      };
      R = class {
        constructor(t5, i6) {
          this._$AV = [], this._$AN = void 0, this._$AD = t5, this._$AM = i6;
        }
        get parentNode() {
          return this._$AM.parentNode;
        }
        get _$AU() {
          return this._$AM._$AU;
        }
        u(t5) {
          const { el: { content: i6 }, parts: s5 } = this._$AD, e5 = (t5?.creationScope ?? l2).importNode(i6, true);
          P.currentNode = e5;
          let h4 = P.nextNode(), o7 = 0, n6 = 0, r6 = s5[0];
          for (; void 0 !== r6; ) {
            if (o7 === r6.index) {
              let i7;
              2 === r6.type ? i7 = new k(h4, h4.nextSibling, this, t5) : 1 === r6.type ? i7 = new r6.ctor(h4, r6.name, r6.strings, this, t5) : 6 === r6.type && (i7 = new Z(h4, this, t5)), this._$AV.push(i7), r6 = s5[++n6];
            }
            o7 !== r6?.index && (h4 = P.nextNode(), o7++);
          }
          return P.currentNode = l2, e5;
        }
        p(t5) {
          let i6 = 0;
          for (const s5 of this._$AV) void 0 !== s5 && (void 0 !== s5.strings ? (s5._$AI(t5, s5, i6), i6 += s5.strings.length - 2) : s5._$AI(t5[i6])), i6++;
        }
      };
      k = class _k {
        get _$AU() {
          return this._$AM?._$AU ?? this._$Cv;
        }
        constructor(t5, i6, s5, e5) {
          this.type = 2, this._$AH = A, this._$AN = void 0, this._$AA = t5, this._$AB = i6, this._$AM = s5, this.options = e5, this._$Cv = e5?.isConnected ?? true;
        }
        get parentNode() {
          let t5 = this._$AA.parentNode;
          const i6 = this._$AM;
          return void 0 !== i6 && 11 === t5?.nodeType && (t5 = i6.parentNode), t5;
        }
        get startNode() {
          return this._$AA;
        }
        get endNode() {
          return this._$AB;
        }
        _$AI(t5, i6 = this) {
          t5 = M(this, t5, i6), a2(t5) ? t5 === A || null == t5 || "" === t5 ? (this._$AH !== A && this._$AR(), this._$AH = A) : t5 !== this._$AH && t5 !== E && this._(t5) : void 0 !== t5._$litType$ ? this.$(t5) : void 0 !== t5.nodeType ? this.T(t5) : d2(t5) ? this.k(t5) : this._(t5);
        }
        O(t5) {
          return this._$AA.parentNode.insertBefore(t5, this._$AB);
        }
        T(t5) {
          this._$AH !== t5 && (this._$AR(), this._$AH = this.O(t5));
        }
        _(t5) {
          this._$AH !== A && a2(this._$AH) ? this._$AA.nextSibling.data = t5 : this.T(l2.createTextNode(t5)), this._$AH = t5;
        }
        $(t5) {
          const { values: i6, _$litType$: s5 } = t5, e5 = "number" == typeof s5 ? this._$AC(t5) : (void 0 === s5.el && (s5.el = S2.createElement(V(s5.h, s5.h[0]), this.options)), s5);
          if (this._$AH?._$AD === e5) this._$AH.p(i6);
          else {
            const t6 = new R(e5, this), s6 = t6.u(this.options);
            t6.p(i6), this.T(s6), this._$AH = t6;
          }
        }
        _$AC(t5) {
          let i6 = C.get(t5.strings);
          return void 0 === i6 && C.set(t5.strings, i6 = new S2(t5)), i6;
        }
        k(t5) {
          u2(this._$AH) || (this._$AH = [], this._$AR());
          const i6 = this._$AH;
          let s5, e5 = 0;
          for (const h4 of t5) e5 === i6.length ? i6.push(s5 = new _k(this.O(c3()), this.O(c3()), this, this.options)) : s5 = i6[e5], s5._$AI(h4), e5++;
          e5 < i6.length && (this._$AR(s5 && s5._$AB.nextSibling, e5), i6.length = e5);
        }
        _$AR(t5 = this._$AA.nextSibling, s5) {
          for (this._$AP?.(false, true, s5); t5 !== this._$AB; ) {
            const s6 = i3(t5).nextSibling;
            i3(t5).remove(), t5 = s6;
          }
        }
        setConnected(t5) {
          void 0 === this._$AM && (this._$Cv = t5, this._$AP?.(t5));
        }
      };
      H = class {
        get tagName() {
          return this.element.tagName;
        }
        get _$AU() {
          return this._$AM._$AU;
        }
        constructor(t5, i6, s5, e5, h4) {
          this.type = 1, this._$AH = A, this._$AN = void 0, this.element = t5, this.name = i6, this._$AM = e5, this.options = h4, s5.length > 2 || "" !== s5[0] || "" !== s5[1] ? (this._$AH = Array(s5.length - 1).fill(new String()), this.strings = s5) : this._$AH = A;
        }
        _$AI(t5, i6 = this, s5, e5) {
          const h4 = this.strings;
          let o7 = false;
          if (void 0 === h4) t5 = M(this, t5, i6, 0), o7 = !a2(t5) || t5 !== this._$AH && t5 !== E, o7 && (this._$AH = t5);
          else {
            const e6 = t5;
            let n6, r6;
            for (t5 = h4[0], n6 = 0; n6 < h4.length - 1; n6++) r6 = M(this, e6[s5 + n6], i6, n6), r6 === E && (r6 = this._$AH[n6]), o7 || (o7 = !a2(r6) || r6 !== this._$AH[n6]), r6 === A ? t5 = A : t5 !== A && (t5 += (r6 ?? "") + h4[n6 + 1]), this._$AH[n6] = r6;
          }
          o7 && !e5 && this.j(t5);
        }
        j(t5) {
          t5 === A ? this.element.removeAttribute(this.name) : this.element.setAttribute(this.name, t5 ?? "");
        }
      };
      I = class extends H {
        constructor() {
          super(...arguments), this.type = 3;
        }
        j(t5) {
          this.element[this.name] = t5 === A ? void 0 : t5;
        }
      };
      L = class extends H {
        constructor() {
          super(...arguments), this.type = 4;
        }
        j(t5) {
          this.element.toggleAttribute(this.name, !!t5 && t5 !== A);
        }
      };
      z = class extends H {
        constructor(t5, i6, s5, e5, h4) {
          super(t5, i6, s5, e5, h4), this.type = 5;
        }
        _$AI(t5, i6 = this) {
          if ((t5 = M(this, t5, i6, 0) ?? A) === E) return;
          const s5 = this._$AH, e5 = t5 === A && s5 !== A || t5.capture !== s5.capture || t5.once !== s5.once || t5.passive !== s5.passive, h4 = t5 !== A && (s5 === A || e5);
          e5 && this.element.removeEventListener(this.name, this, s5), h4 && this.element.addEventListener(this.name, this, t5), this._$AH = t5;
        }
        handleEvent(t5) {
          "function" == typeof this._$AH ? this._$AH.call(this.options?.host ?? this.element, t5) : this._$AH.handleEvent(t5);
        }
      };
      Z = class {
        constructor(t5, i6, s5) {
          this.element = t5, this.type = 6, this._$AN = void 0, this._$AM = i6, this.options = s5;
        }
        get _$AU() {
          return this._$AM._$AU;
        }
        _$AI(t5) {
          M(this, t5);
        }
      };
      j = { M: h2, P: o3, A: n3, C: 1, L: N, R, D: d2, V: M, I: k, H, N: L, U: z, B: I, F: Z };
      B = t2.litHtmlPolyfillSupport;
      B?.(S2, k), (t2.litHtmlVersions ?? (t2.litHtmlVersions = [])).push("3.3.3");
      D = (t5, i6, s5) => {
        const e5 = s5?.renderBefore ?? i6;
        let h4 = e5._$litPart$;
        if (void 0 === h4) {
          const t6 = s5?.renderBefore ?? null;
          e5._$litPart$ = h4 = new k(i6.insertBefore(c3(), t6), t6, void 0, s5 ?? {});
        }
        return h4._$AI(t5), h4;
      };
    }
  });

  // node_modules/lit-element/lit-element.js
  var s3, i4, o4;
  var init_lit_element = __esm({
    "node_modules/lit-element/lit-element.js"() {
      init_reactive_element();
      init_reactive_element();
      init_lit_html();
      init_lit_html();
      s3 = globalThis;
      i4 = class extends y {
        constructor() {
          super(...arguments), this.renderOptions = { host: this }, this._$Do = void 0;
        }
        createRenderRoot() {
          var _a;
          const t5 = super.createRenderRoot();
          return (_a = this.renderOptions).renderBefore ?? (_a.renderBefore = t5.firstChild), t5;
        }
        update(t5) {
          const r6 = this.render();
          this.hasUpdated || (this.renderOptions.isConnected = this.isConnected), super.update(t5), this._$Do = D(r6, this.renderRoot, this.renderOptions);
        }
        connectedCallback() {
          super.connectedCallback(), this._$Do?.setConnected(true);
        }
        disconnectedCallback() {
          super.disconnectedCallback(), this._$Do?.setConnected(false);
        }
        render() {
          return E;
        }
      };
      i4._$litElement$ = true, i4["finalized"] = true, s3.litElementHydrateSupport?.({ LitElement: i4 });
      o4 = s3.litElementPolyfillSupport;
      o4?.({ LitElement: i4 });
      (s3.litElementVersions ?? (s3.litElementVersions = [])).push("4.2.2");
    }
  });

  // node_modules/lit-html/is-server.js
  var init_is_server = __esm({
    "node_modules/lit-html/is-server.js"() {
    }
  });

  // node_modules/lit/index.js
  var init_lit = __esm({
    "node_modules/lit/index.js"() {
      init_reactive_element();
      init_lit_html();
      init_lit_element();
      init_is_server();
    }
  });

  // node_modules/lit-html/directive-helpers.js
  var t3, r4;
  var init_directive_helpers = __esm({
    "node_modules/lit-html/directive-helpers.js"() {
      init_lit_html();
      ({ I: t3 } = j);
      r4 = (o7) => void 0 === o7.strings;
    }
  });

  // node_modules/lit-html/directive.js
  var t4, e4, i5;
  var init_directive = __esm({
    "node_modules/lit-html/directive.js"() {
      t4 = { ATTRIBUTE: 1, CHILD: 2, PROPERTY: 3, BOOLEAN_ATTRIBUTE: 4, EVENT: 5, ELEMENT: 6 };
      e4 = (t5) => (...e5) => ({ _$litDirective$: t5, values: e5 });
      i5 = class {
        constructor(t5) {
        }
        get _$AU() {
          return this._$AM._$AU;
        }
        _$AT(t5, e5, i6) {
          this._$Ct = t5, this._$AM = e5, this._$Ci = i6;
        }
        _$AS(t5, e5) {
          return this.update(t5, e5);
        }
        update(t5, e5) {
          return this.render(...e5);
        }
      };
    }
  });

  // node_modules/lit-html/async-directive.js
  function h3(i6) {
    void 0 !== this._$AN ? (o5(this), this._$AM = i6, r5(this)) : this._$AM = i6;
  }
  function n4(i6, t5 = false, e5 = 0) {
    const r6 = this._$AH, h4 = this._$AN;
    if (void 0 !== h4 && 0 !== h4.size) if (t5) if (Array.isArray(r6)) for (let i7 = e5; i7 < r6.length; i7++) s4(r6[i7], false), o5(r6[i7]);
    else null != r6 && (s4(r6, false), o5(r6));
    else s4(this, i6);
  }
  var s4, o5, r5, c4, f3;
  var init_async_directive = __esm({
    "node_modules/lit-html/async-directive.js"() {
      init_directive_helpers();
      init_directive();
      init_directive();
      s4 = (i6, t5) => {
        const e5 = i6._$AN;
        if (void 0 === e5) return false;
        for (const i7 of e5) i7._$AO?.(t5, false), s4(i7, t5);
        return true;
      };
      o5 = (i6) => {
        let t5, e5;
        do {
          if (void 0 === (t5 = i6._$AM)) break;
          e5 = t5._$AN, e5.delete(i6), i6 = t5;
        } while (0 === e5?.size);
      };
      r5 = (i6) => {
        for (let t5; t5 = i6._$AM; i6 = t5) {
          let e5 = t5._$AN;
          if (void 0 === e5) t5._$AN = e5 = /* @__PURE__ */ new Set();
          else if (e5.has(i6)) break;
          e5.add(i6), c4(t5);
        }
      };
      c4 = (i6) => {
        i6.type == t4.CHILD && (i6._$AP ?? (i6._$AP = n4), i6._$AQ ?? (i6._$AQ = h3));
      };
      f3 = class extends i5 {
        constructor() {
          super(...arguments), this._$AN = void 0;
        }
        _$AT(i6, t5, e5) {
          super._$AT(i6, t5, e5), r5(this), this.isConnected = i6._$AU;
        }
        _$AO(i6, t5 = true) {
          i6 !== this.isConnected && (this.isConnected = i6, i6 ? this.reconnected?.() : this.disconnected?.()), t5 && (s4(this, i6), o5(this));
        }
        setValue(t5) {
          if (r4(this._$Ct)) this._$Ct._$AI(t5, this);
          else {
            const i6 = [...this._$Ct._$AH];
            i6[this._$Ci] = t5, this._$Ct._$AI(i6, this, 0);
          }
        }
        disconnected() {
        }
        reconnected() {
        }
      };
    }
  });

  // node_modules/lit-html/directives/ref.js
  var o6, n5;
  var init_ref = __esm({
    "node_modules/lit-html/directives/ref.js"() {
      init_lit_html();
      init_async_directive();
      init_directive();
      o6 = /* @__PURE__ */ new WeakMap();
      n5 = e4(class extends f3 {
        render(i6) {
          return A;
        }
        update(i6, [s5]) {
          const e5 = s5 !== this.G;
          return e5 && this.rt(void 0), (e5 || this.lt !== this.ct) && (this.G = s5, this.ht = i6.options?.host, this.rt(this.ct = i6.element)), A;
        }
        rt(t5) {
          if (void 0 !== this.G) if (this.isConnected || (t5 = void 0), "function" == typeof this.G) {
            const i6 = this.ht ?? globalThis;
            let s5 = o6.get(i6);
            void 0 === s5 && (s5 = /* @__PURE__ */ new WeakMap(), o6.set(i6, s5)), void 0 !== s5.get(this.G) && this.G.call(this.ht, void 0), s5.set(this.G, t5), void 0 !== t5 && this.G.call(this.ht, t5);
          } else this.G.value = t5;
        }
        get lt() {
          return "function" == typeof this.G ? o6.get(this.ht ?? globalThis)?.get(this.G) : this.G?.value;
        }
        disconnected() {
          this.lt === this.ct && this.rt(void 0);
        }
        reconnected() {
          this.rt(this.ct);
        }
      });
    }
  });

  // node_modules/lit/directives/ref.js
  var init_ref2 = __esm({
    "node_modules/lit/directives/ref.js"() {
      init_ref();
    }
  });

  // internal/web/static/src/sessions.js
  function esc2(s5) {
    return String(s5).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function md(src) {
    if (!src) return "";
    src = String(src);
    const out = [];
    let rest = src;
    while (rest.length) {
      const m2 = /```([\w-]*)\n?([\s\S]*?)```/.exec(rest);
      if (!m2) {
        out.push(inlineMd(rest));
        break;
      }
      out.push(inlineMd(rest.slice(0, m2.index)));
      const code = esc2(m2[2].replace(/\n$/, ""));
      const lang = esc2(m2[1]);
      out.push(`<pre class="ph-code"><code${lang ? ` data-lang="${lang}"` : ""}>${code}</code></pre>`);
      rest = rest.slice(m2.index + m2[0].length);
    }
    return out.join("");
  }
  function inlineMd(src) {
    let s5 = esc2(src);
    s5 = s5.replace(/^(#{1,4})\s+(.+)$/gm, (_2, h4, t5) => `<h${h4.length}>${t5}</h${h4.length}>`);
    s5 = s5.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");
    s5 = s5.replace(/^[-*]\s+(.+)$/gm, "<li>$1</li>");
    s5 = s5.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>");
    const codes = [];
    s5 = s5.replace(/`([^`]+)`/g, (_2, c5) => {
      codes.push(esc2(c5));
      return `\0${codes.length - 1}\0`;
    });
    s5 = s5.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s5 = s5.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s5 = s5.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s5 = s5.replace(/\u0000(\d+)\u0000/g, (_2, i6) => `<code>${codes[+i6]}</code>`);
    return s5;
  }
  function toolArg(tool, args) {
    if (!args) return "";
    const key = tool === "read_file" || tool === "write_file" || tool === "edit" || tool === "edit_file" ? "path" : tool === "grep" || tool === "glob" ? "pattern" : tool === "bash" ? "command" : "";
    if (key && args[key] != null) return String(args[key]).slice(0, 80);
    return "";
  }
  function toolName(block) {
    return block.name || block.toolName || "tool";
  }
  function buildRenderItems(entries) {
    const items = [];
    const byToolId = /* @__PURE__ */ new Map();
    for (const e5 of entries) {
      if (!e5 || typeof e5 !== "object") continue;
      const attach = (it) => {
        it._id = e5.id || "";
        return it;
      };
      switch (e5.type) {
        case "message": {
          const msg = e5.message || {};
          const role = msg.role;
          if (role === "toolResult") {
            byToolId.set(msg.toolCallId, msg);
            break;
          }
          if (role === "assistant") {
            items.push(attach({ kind: "assistant", msg, toolResults: byToolId }));
            continue;
          }
          if (role === "bashExecution") {
            items.push(attach({ kind: "bash", msg }));
            continue;
          }
          items.push(attach({ kind: role === "user" ? "user" : "custom", msg }));
          break;
        }
        case "model_change":
          items.push(attach({ kind: "ev-model", provider: e5.provider, modelId: e5.modelId }));
          break;
        case "thinking_level_change":
          items.push(attach({ kind: "ev-thinking", level: e5.thinkingLevel }));
          break;
        case "compaction":
          items.push(attach({ kind: "ev-compaction", summary: e5.summary, tokensBefore: e5.tokensBefore }));
          break;
        case "branch_summary":
          items.push(attach({ kind: "ev-branch", summary: e5.summary }));
          break;
        default:
          break;
      }
    }
    return items;
  }
  function applyLiveEvent(ev) {
    const st = sessionState;
    switch (ev.type) {
      case "agent_start":
        st.agentRunning = true;
        break;
      case "agent_settled":
        st.agentRunning = false;
        break;
      case "turn_start":
        st.agentRunning = true;
        break;
      case "message_start": {
        const msg = ev.message || {};
        if (msg.role === "assistant") {
          st.pending = { kind: "assistant", msg, toolResults: /* @__PURE__ */ new Map(), streaming: true };
          st.entries.push(st.pending);
        }
        break;
      }
      case "message_update": {
        const pending = st.pending;
        if (!pending || !pending.msg) break;
        const d3 = ev.assistantMessageEvent || {};
        const msg = pending.msg;
        let content = Array.isArray(msg.content) ? msg.content : [];
        if (!content.length && typeof msg.content === "string") content = [{ type: "text", text: msg.content }];
        const idx = Number.isInteger(d3.contentIndex) ? d3.contentIndex : Math.max(content.length - 1, 0);
        const block = content[idx] || { type: "text", text: "" };
        if (d3.type === "text_delta" && typeof d3.delta === "string") block.text = (block.text || "") + d3.delta;
        else if (d3.type === "thinking_delta" && typeof d3.delta === "string") {
          if (block.type !== "thinking") block.type = "thinking";
          block.thinking = (block.thinking || "") + d3.delta;
        }
        content[idx] = block;
        msg.content = content;
        break;
      }
      case "message_end": {
        const msg = ev.message || {};
        if (msg.role === "assistant") {
          if (st.pending) {
            st.pending.msg = msg;
            st.pending.streaming = false;
            st.pending = null;
          } else if (st.entries.length) {
            const last = st.entries[st.entries.length - 1];
            if (last && last.kind === "assistant") {
              last.msg = msg;
              last.streaming = false;
            }
          }
        }
        break;
      }
      case "tool_execution_start":
      case "tool_execution_update":
        if (st.pending) st.pending.toolLive = ev;
        break;
      case "tool_execution_end": {
        if (ev.result != null) {
          for (let i6 = st.entries.length - 1; i6 >= 0; i6--) {
            const it = st.entries[i6];
            if (it && it.kind === "assistant") {
              if (!it.toolResults) it.toolResults = /* @__PURE__ */ new Map();
              it.toolResults.set(ev.toolCallId, ev.result);
              break;
            }
          }
        }
        break;
      }
      case "user_echo": {
        st.entries.push({ kind: "user", msg: ev.message || {} });
        break;
      }
      default:
        break;
    }
  }
  function toastErr(msg) {
    Promise.resolve().then(() => (init_core(), core_exports)).then((m2) => m2.toast(msg, true)).catch(() => alert(msg));
  }
  function renderItem(it, key) {
    switch (it.kind) {
      case "user":
        return b2`<ph-msg-user .msg=${it.msg}></ph-msg-user>`;
      case "assistant":
        return b2`<ph-msg-assistant .msg=${it.msg} .toolLive=${it.toolLive} .toolResults=${it.toolResults} .streaming=${it.streaming}></ph-msg-assistant>`;
      case "bash":
        return b2`<ph-msg-bash .msg=${it.msg}></ph-msg-bash>`;
      case "custom":
        return b2`<ph-msg-custom .msg=${it.msg}></ph-msg-custom>`;
      case "ev-model":
        return b2`<div class="pw-event">🔄 模型切换 → ${it.provider}/${it.modelId}</div>`;
      case "ev-thinking":
        return b2`<div class="pw-event">💭 思考级别 → ${it.level}</div>`;
      case "ev-compaction":
        return b2`<div class="pw-event" title=${it.summary || ""}>🧹 上下文已压缩（-${it.tokensBefore || "?"} tokens）</div>`;
      case "ev-branch":
        return b2`<div class="pw-event">🌿 分支摘要${it.summary ? `: ${it.summary.slice(0, 60)}` : ""}</div>`;
      default:
        return A;
    }
  }
  function fmtTime(ts) {
    if (!ts) return "";
    const d3 = new Date(ts);
    if (isNaN(d3)) return "";
    const pad = (n6) => String(n6).padStart(2, "0");
    return `${d3.getFullYear()}-${pad(d3.getMonth() + 1)}-${pad(d3.getDate())} ${pad(d3.getHours())}:${pad(d3.getMinutes())}:${pad(d3.getSeconds())}`;
  }
  function relTime(iso) {
    if (!iso) return "";
    const t5 = new Date(iso).getTime();
    if (!t5) return "";
    const d3 = (Date.now() - t5) / 1e3;
    if (d3 < 60) return "\u521A\u521A";
    if (d3 < 3600) return `${Math.floor(d3 / 60)} \u5206\u949F\u524D`;
    if (d3 < 86400) return `${Math.floor(d3 / 3600)} \u5C0F\u65F6\u524D`;
    if (d3 < 86400 * 7) return `${Math.floor(d3 / 86400)} \u5929\u524D`;
    return new Date(iso).toLocaleDateString();
  }
  var PW, STATUS_DOT, STATUS_LABEL2, sessionState, PhSessionsPage, PhSessionList, PhSessionCreate, PhSessionView, PhSessionHeader, PhMessageStream, msgStyles, PhMsgUser, PhMsgAssistant, PhMsgBash, PhMsgCustom, PhToolCard, PhSessionTerm, PhSessionInput;
  var init_sessions = __esm({
    "internal/web/static/src/sessions.js"() {
      init_lit();
      init_ref2();
      init_core();
      PW = i`
  :host {
  --pw-bg: #0d1117;
  --pw-surface: #161b22;
  --pw-surface-hover: #21262d;
  --pw-border: #30363d;
  --pw-border-muted: #21262d;
  --pw-text: #e6edf3;
  --pw-text-secondary: #c9d1d9;
  --pw-muted: #8b949e;
  --pw-dim: #6e7681;
  --pw-accent: #58a6ff;
  --pw-accent-border: #2f81f7;
  --pw-selection-bg: #0d2847;
  --pw-success: #3fb950;
  --pw-success-border: #238636;
  --pw-success-bg: #0f1b12;
  --pw-success-ring: #3fb95055;
  --pw-warning: #d29922;
  --pw-warning-border: #6e5200;
  --pw-warning-surface: #1f1a10;
  --pw-danger: #ff7b72;
  --pw-purple: #d2a8ff;
  --pw-purple-border: #a371f7;
  --pw-purple-surface: #21132f;
  --pw-terminal-bg: #05070a;
  --pw-overlay: #0008;
  --pw-shadow: #0008;
  --pw-shadow-soft: #0006;
  }
`;
      STATUS_DOT = { created: "\u25CB", active: "\u25C9", suspended: "\u25CB", delivered: "\u2713", deleted: "\u2715" };
      STATUS_LABEL2 = {
        created: "\u672A\u542F\u52A8",
        active: "\u6D3B\u8DC3",
        suspended: "\u5DF2\u6302\u8D77",
        delivered: "\u5DF2\u4EA4\u4ED8",
        deleted: "\u5DF2\u5220\u9664"
      };
      sessionState = {
        list: [],
        selectedId: null,
        detail: null,
        entries: [],
        live: null,
        agentRunning: false,
        pending: null,
        loading: false,
        filter: "all",
        projectFilter: "",
        transcriptTotal: 0,
        transcriptLoaded: 0,
        _firstEntryId: ""
      };
      PhSessionsPage = class extends i4 {
        constructor() {
          super();
          this.selectedId = null;
          this.showCreate = false;
          this.prefill = null;
          this._onMessage = (e5) => this._handleLive(e5.detail);
          this._onUpdated = (e5) => {
            const d3 = e5.detail;
            if (d3 && d3.id && sessionState.detail && d3.id === sessionState.detail.id) {
              sessionState.detail = d3;
              this.requestUpdate();
            }
            this.refreshList();
          };
          this._onDetailRefresh = (e5) => {
            if (e5.detail) this._loadDetail(e5.detail);
          };
        }
        connectedCallback() {
          super.connectedCallback();
          window.addEventListener("ph-session-message", this._onMessage);
          window.addEventListener("ph-session-updated", this._onUpdated);
          window.addEventListener("ph-session-detail-refresh", this._onDetailRefresh);
          this.refreshList();
          const q = new URLSearchParams(location.search);
          if (q.has("agent") || q.has("project") || q.has("title")) {
            this.prefill = { agent: q.get("agent") || "", project: q.get("project") || "", title: q.get("title") || "" };
            this.showCreate = true;
            history.replaceState(null, "", "/sessions");
          }
        }
        disconnectedCallback() {
          super.disconnectedCallback();
          window.removeEventListener("ph-session-message", this._onMessage);
          window.removeEventListener("ph-session-updated", this._onUpdated);
          window.removeEventListener("ph-session-detail-refresh", this._onDetailRefresh);
        }
        async refreshList() {
          try {
            const list = await api("/api/sessions");
            sessionState.list = Array.isArray(list) ? list : [];
            this.requestUpdate();
          } catch (_2) {
          }
        }
        async select(id) {
          this.selectedId = id;
          sessionState.selectedId = id;
          sessionState.detail = null;
          sessionState.entries = [];
          sessionState.pending = null;
          sessionState.live = null;
          this.requestUpdate();
          await this._loadDetail(id);
        }
        async _loadDetail(id) {
          try {
            const ss = await api(`/api/sessions/${id}`);
            sessionState.detail = ss;
            const tr = await api(`/api/sessions/${id}/transcript?limit=100`);
            sessionState.entries = buildRenderItems(tr && tr.entries ? tr.entries : []);
            sessionState.transcriptTotal = tr ? tr.total : sessionState.entries.length;
            sessionState.transcriptLoaded = sessionState.entries.length;
            this.requestUpdate();
            if (ss.status === "active") this._loadState(id);
          } catch (e5) {
            toastErr(`\u52A0\u8F7D\u4F1A\u8BDD\u5931\u8D25: ${e5.message || e5}`);
          }
        }
        // 分页：加载更早的消息（pi-web：Scroll up to load earlier messages）。
        async loadEarlier() {
          const id = sessionState.detail?.id;
          if (!id || !sessionState.entries.length) return;
          const before = sessionState.entries[0]?._id || "";
          if (!before) return 0;
          try {
            const tr = await api(`/api/sessions/${id}/transcript?limit=100&before=${encodeURIComponent(before || "")}`);
            const older = buildRenderItems(tr && tr.entries ? tr.entries : []);
            const known = new Set(sessionState.entries.map((e5) => e5._id));
            const merged = [...older.filter((e5) => !known.has(e5._id)), ...sessionState.entries];
            sessionState.entries = merged;
            sessionState.transcriptTotal = tr ? tr.total : merged.length;
            this.requestUpdate();
            return merged.length - sessionState.entries.length;
          } catch (_2) {
            return 0;
          }
        }
        async _loadState(id) {
          try {
            const r6 = await api(`/api/sessions/${id}/state`);
            if (sessionState.detail && sessionState.detail.id !== id) return;
            sessionState.live = r6 && r6.data || null;
            this.requestUpdate();
          } catch (_2) {
          }
        }
        _handleLive(detail) {
          if (!sessionState.detail || sessionState.detail.id !== detail.session_id) return;
          const ev = detail.event || {};
          if (ev.type === "agent_start") this._loadState(detail.session_id);
          applyLiveEvent(ev);
          this.requestUpdate();
        }
        render() {
          return b2`
      <div class="col-list">
        <ph-session-list .selectedId=${this.selectedId} @select=${(e5) => this.select(e5.detail)} @create=${() => {
            this.showCreate = true;
            this.prefill = null;
            this.requestUpdate();
          }}></ph-session-list>
      </div>
      <div class="col-main">
        ${sessionState.detail ? b2`<ph-session-view .sessionId=${this.selectedId} @close=${() => {
            this.selectedId = null;
            sessionState.detail = null;
            this.requestUpdate();
          }}></ph-session-view>` : b2`<div class="pw-empty">选择或新建一个会话开始协作</div>`}
      </div>
      ${this.showCreate ? b2`<ph-session-create .prefill=${this.prefill} @close=${() => {
            this.showCreate = false;
            this.requestUpdate();
          }} @created=${(e5) => {
            this.showCreate = false;
            this.refreshList();
            this.requestUpdate();
            this.select(e5.detail);
          }}></ph-session-create>` : ""}
    `;
        }
      };
      __publicField(PhSessionsPage, "styles", i`
    ${PW}
    :host {
      display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 0;
      height: calc(100vh - 150px); min-height: 480px;
      background: var(--pw-bg); color: var(--pw-text);
      font: 14px system-ui, sans-serif; border: 1px solid var(--pw-border);
      border-radius: 12px; overflow: hidden;
    }
    .col-list { border-right: 1px solid var(--pw-border); min-height: 0; background: var(--pw-bg); }
    .col-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--pw-bg); }
    @media (max-width: 860px) {
      :host { grid-template-columns: 1fr; grid-template-rows: auto 1fr; height: auto; }
      .col-list { border-right: 0; border-bottom: 1px solid var(--pw-border); max-height: 38vh; }
      .col-main { height: 70vh; }
    }
  `);
      __publicField(PhSessionsPage, "properties", {
        selectedId: { state: true }
      });
      customElements.define("ph-sessions-page", PhSessionsPage);
      PhSessionList = class extends i4 {
        constructor() {
          super();
          this.list = [];
          this.selectedId = null;
          this.filter = "all";
          this.loading = false;
        }
        connectedCallback() {
          super.connectedCallback();
          if (!this.list.length) this._load();
        }
        async _load() {
          try {
            this.list = await api("/api/sessions");
            this.requestUpdate();
          } catch (_2) {
          }
        }
        _filtered() {
          let l3 = Array.isArray(this.list) ? this.list : [];
          if (this.filter !== "all") l3 = l3.filter((x2) => x2.status === this.filter);
          return l3;
        }
        render() {
          const items = this._filtered();
          return b2`
      <div class="head">
        <h2>会话</h2><span class="count">${items.length}</span>
      </div>
      <div class="toolbar">
        <select .value=${this.filter} @change=${(e5) => {
            this.filter = e5.target.value;
          }}>
          <option value="all">全部</option>
          <option value="active">活跃</option>
          <option value="suspended">已挂起</option>
          <option value="delivered">已交付</option>
        </select>
      </div>
      <div class="items">
        ${items.map((s5) => b2`
          <div class="item ${s5.id === this.selectedId ? "sel" : ""}" @click=${() => this._emit("select", s5.id)}>
            <div class="t1">
              <span class="dot st-${s5.status}">${STATUS_DOT[s5.status] || "\u25CB"}</span>
              <span class="title" title=${s5.title}>${s5.title}</span>
            </div>
            <div class="meta">
              <span class="cli">${s5.cli || "?"}</span>
              <span>${s5.agent_name || ""}</span>
              ${s5.project_name ? b2`<span>·</span><span>${s5.project_name}</span>` : ""}
              <span>·</span><span>${relTime(s5.last_message_at || s5.created_at)}</span>
              ${s5.message_count ? b2`<span>·</span><span>${s5.message_count} 条消息</span>` : ""}
              ${s5.task_id ? b2`<span>·</span><a href="#/issue/${s5.task_id}" @click=${(e5) => e5.stopPropagation()}>任务 #${s5.task_id}</a>` : ""}
            </div>
          </div>`)}
        ${!items.length ? b2`<div class="pw-empty-sm">暂无会话</div>` : ""}
      </div>
      <button class="new" @click=${() => this._emit("create")}>＋ 新建会话</button>
    `;
        }
        _emit(name, detail) {
          this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
        }
      };
      __publicField(PhSessionList, "styles", i`
    ${PW}
    :host { display: flex; flex-direction: column; height: 100%; background: var(--pw-bg); }
    .head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--pw-border); }
    .head h2 { margin: 0; font-size: 14px; font-weight: 700; color: var(--pw-text); }
    .head .count { color: var(--pw-dim); font-size: 12px; }
    .toolbar { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--pw-border-muted); }
    select { border: 1px solid var(--pw-border); background: var(--pw-surface); color: var(--pw-text); border-radius: 7px; padding: 4px 8px; font-size: 12.5px; }
    .items { flex: 1; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
    .item { border: 1px solid transparent; border-radius: 8px; padding: 8px 10px; cursor: pointer; background: transparent; color: var(--pw-text); }
    .item:hover { background: var(--pw-surface-hover); }
    .item.sel { border-color: var(--pw-accent-border); background: var(--pw-selection-bg); }
    .t1 { display: flex; gap: 8px; align-items: center; }
    .dot { font-size: 11px; }
    .dot.st-running { color: var(--pw-success); }
    .dot.st-succeeded { color: var(--pw-accent); }
    .dot.st-cancelled { color: var(--pw-dim); }
    .dot.st-failed { color: var(--pw-danger); }
    .title { font-weight: 600; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .meta { color: var(--pw-muted); font-size: 11.5px; margin-top: 3px; display: flex; gap: 6px; align-items: center; }
    .cli { border: 1px solid var(--pw-border); border-radius: 4px; padding: 0 5px; font-size: 10px; font-weight: 700; color: var(--pw-text-secondary); }
    .meta a { color: var(--pw-accent); text-decoration: none; }
    .new { margin: 8px 10px; padding: 6px; border: 1px dashed var(--pw-border); border-radius: 8px; text-align: center; cursor: pointer; color: var(--pw-muted); font-size: 12.5px; background: transparent; }
    .new:hover { color: var(--pw-text); border-color: var(--pw-border); background: var(--pw-surface-hover); }
    .pw-empty-sm { color: var(--pw-dim); text-align: center; padding: 28px 0; font-size: 12.5px; }
  `);
      __publicField(PhSessionList, "properties", { list: { state: true }, selectedId: { attribute: false }, filter: { state: true } });
      customElements.define("ph-session-list", PhSessionList);
      PhSessionCreate = class extends i4 {
        constructor() {
          super();
          this.agents = [];
          this.projects = [];
          this.agentId = "";
          this.projectId = "";
          this.title = "";
          this.submitting = false;
        }
        connectedCallback() {
          super.connectedCallback();
          const pf = this.prefill || {};
          Promise.all([api("/api/agents"), api("/api/projects")]).then(([a3, p3]) => {
            this.agents = a3.filter((x2) => x2.enabled);
            this.projects = p3;
            if (pf.agent && this.agents.some((x2) => String(x2.id) === String(pf.agent))) this.agentId = String(pf.agent);
            else if (this.agents.length) this.agentId = String(this.agents[0].id);
            if (pf.project && this.projects.some((x2) => String(x2.id) === String(pf.project))) this.projectId = String(pf.project);
            else if (this.projects.length) this.projectId = String(this.projects[0].id);
            this.title = pf.title || "";
            this.requestUpdate();
          }).catch(() => {
          });
        }
        async submit() {
          if (!this.agentId || !this.title.trim()) {
            toastErr("\u8BF7\u586B\u5199\u89D2\u8272\u4E0E\u6807\u9898");
            return;
          }
          this.submitting = true;
          try {
            const ss = await api("/api/sessions", {
              method: "POST",
              body: JSON.stringify({
                agent_id: Number(this.agentId),
                project_id: this.projectId ? Number(this.projectId) : null,
                title: this.title.trim()
              })
            });
            this.dispatchEvent(new CustomEvent("created", { detail: ss.id, bubbles: true, composed: true }));
          } catch (e5) {
            toastErr(`\u521B\u5EFA\u5931\u8D25: ${e5.message || e5}`);
          }
          this.submitting = false;
        }
        render() {
          const proj = this.projects.find((p3) => String(p3.id) === this.projectId);
          return b2`
      <div class="box" @click=${(e5) => e5.stopPropagation()}>
        <h3>新建会话</h3>
        <label>标题 <input .value=${this.title} @input=${(e5) => this.title = e5.target.value} placeholder="例如：修复登录失败" @keydown=${(e5) => e5.key === "Enter" && !e5.isComposing && this.submit()}></label>
        <label>角色
          <select .value=${this.agentId} @change=${(e5) => this.agentId = e5.target.value}>
            ${this.agents.map((a3) => b2`<option value=${a3.id}>${a3.name}（${a3.cli}）</option>`)}
          </select>
        </label>
        <label>项目
          <select .value=${this.projectId} @change=${(e5) => this.projectId = e5.target.value}>
            <option value="">（无项目）</option>
            ${this.projects.map((p3) => b2`<option value=${p3.id}>${p3.name}</option>`)}
          </select>
        </label>
        ${proj && proj.is_git ? b2`<div class="hint">git 项目：将创建独立 worktree（paihuo/session-N），与任务隔离互不冲突。</div>` : ""}
        <div class="row">
          <button @click=${() => this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }))}>取消</button>
          <button class="primary" @click=${this.submit}>${this.submitting ? "\u521B\u5EFA\u4E2D\u2026" : "\u521B\u5EFA\u4F1A\u8BDD"}</button>
        </div>
      </div>`;
        }
      };
      __publicField(PhSessionCreate, "styles", i`
    ${PW}
    :host { position: fixed; inset: 0; background: var(--pw-overlay); display: flex; align-items: center; justify-content: center; z-index: 60; }
    .box { background: var(--pw-surface); border: 1px solid var(--pw-border); border-radius: 12px; padding: 20px; width: 440px; max-width: 92vw; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 12px 48px var(--pw-shadow); color: var(--pw-text); font: 14px system-ui, sans-serif; }
    h3 { margin: 0; font-size: 15px; }
    label { font-size: 12.5px; color: var(--pw-muted); display: flex; flex-direction: column; gap: 5px; }
    input, select { border: 1px solid var(--pw-border); border-radius: 8px; padding: 8px 10px; font-size: 14px; background: var(--pw-bg); color: var(--pw-text); font-family: inherit; }
    input:focus, select:focus { outline: none; border-color: var(--pw-accent-border); }
    .hint { font-size: 12px; color: var(--pw-muted); }
    .row { display: flex; gap: 8px; justify-content: flex-end; }
    button { border-radius: 8px; padding: 7px 14px; border: 1px solid var(--pw-border); cursor: pointer; font-size: 13.5px; background: var(--pw-bg); color: var(--pw-text); }
    button:hover { background: var(--pw-surface-hover); }
    button.primary { background: var(--pw-accent); border-color: var(--pw-accent-border); color: #fff; font-weight: 600; }
    button.primary:hover { background: var(--pw-accent-border); }
  `);
      __publicField(PhSessionCreate, "properties", { agents: { state: true }, projects: { state: true }, prefill: { attribute: false } });
      customElements.define("ph-session-create", PhSessionCreate);
      PhSessionView = class extends i4 {
        constructor() {
          super();
          this._onLive = () => this.requestUpdate();
        }
        connectedCallback() {
          super.connectedCallback();
          window.addEventListener("ph-session-message", this._onLive);
          window.addEventListener("ph-session-updated", this._onLive);
        }
        disconnectedCallback() {
          super.disconnectedCallback();
          window.removeEventListener("ph-session-message", this._onLive);
          window.removeEventListener("ph-session-updated", this._onLive);
        }
        render() {
          const st = sessionState;
          const ss = st.detail;
          if (!ss) return b2`<div class="pw-empty">加载中…</div>`;
          const isPi = (ss.cli || "") === "pi";
          return b2`
      <ph-session-header .session=${ss} .live=${st.live} .running=${st.agentRunning}></ph-session-header>
      ${isPi ? b2`<ph-message-stream .sessionId=${this.sessionId} .entries=${st.entries}></ph-message-stream>
             <ph-session-input .session=${ss} .running=${st.agentRunning} @refresh=${() => this.requestUpdate()}></ph-session-input>` : b2`<ph-session-term .session=${ss}></ph-session-term>`}
    `;
        }
      };
      __publicField(PhSessionView, "styles", i`
    ${PW}
    :host { display: flex; flex-direction: column; height: 100%; background: var(--pw-bg); color: var(--pw-text); }
    .pw-empty { margin: auto; color: var(--pw-muted); font-size: 14px; }
  `);
      __publicField(PhSessionView, "properties", { sessionId: { attribute: false } });
      customElements.define("ph-session-view", PhSessionView);
      PhSessionHeader = class extends i4 {
        async act(action) {
          const id = this.session.id;
          try {
            if (action === "start") await api(`/api/sessions/${id}/start`, { method: "POST" });
            else if (action === "suspend") await api(`/api/sessions/${id}/suspend`, { method: "POST" });
            else if (action === "resume") await api(`/api/sessions/${id}/resume`, { method: "POST" });
            else if (action === "delete") {
              if (!confirm("\u4E22\u5F03\u8BE5\u4F1A\u8BDD\uFF1F\uFF08worktree \u5C06\u88AB\u6E05\u7406\uFF09")) return;
              await api(`/api/sessions/${id}`, { method: "DELETE" });
              this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
            } else if (action === "deliver") {
              const title = prompt("\u4EFB\u52A1\u6807\u9898\uFF08\u9ED8\u8BA4\u4F7F\u7528\u4F1A\u8BDD\u6807\u9898\uFF09\uFF1A", this.session.title);
              if (title === null) return;
              const perm = confirm("\u5BA1\u6279\u540E\u5408\u5E76\uFF1F\u3010\u786E\u5B9A=\u5BA1\u6279\u6A21\u5F0F / \u53D6\u6D88=\u81EA\u52A8\u5408\u5E76\u3011") ? "review" : "full";
              const tk = await api(`/api/sessions/${id}/deliver`, { method: "POST", body: JSON.stringify({ task_title: title, perm }) });
              location.hash = `#/issue/${tk.id}`;
              location.reload();
              return;
            }
            window.dispatchEvent(new CustomEvent("ph-session-updated"));
            this.requestUpdate();
            window.dispatchEvent(new CustomEvent("ph-session-detail-refresh", { detail: id }));
            setTimeout(() => window.dispatchEvent(new CustomEvent("ph-session-updated")), 400);
          } catch (e5) {
            toastErr(e5.message || String(e5));
          }
        }
        render() {
          const s5 = this.session;
          const running = this.running;
          const statusCls = running && s5.status === "active" ? "running" : s5.status;
          const statusText = running && s5.status === "active" ? "\u601D\u8003\u4E2D" : STATUS_LABEL2[s5.status] || s5.status;
          return b2`
      <div class="strip">
        <div class="title">
          <span class="badge ${statusCls}">${statusText}</span>
          <span class="title-text">${s5.title}</span>
        </div>
        <div class="meta">
          <span class="cli">${s5.cli}</span>
          <span>${s5.agent_name}</span>
          ${s5.project_name ? b2`<span>·</span><span>${s5.project_name}</span>` : ""}
          ${this.live && this.live.model ? b2`<span>·</span><span title="当前模型">${this.live.model.id || ""}</span>` : ""}
          ${this.live && this.live.thinkingLevel ? b2`<span>·</span><span>思考:${this.live.thinkingLevel}</span>` : ""}
        </div>
        <span class="spacer"></span>
        ${s5.status === "created" ? b2`<button class="primary" @click=${() => this.act("start")}>启动</button><button class="danger" @click=${() => this.act("delete")}>丢弃</button>` : ""}
        ${s5.status === "active" ? b2`
          ${running ? b2`<button @click=${() => this.act("abort")}>中止</button>` : ""}
          <button @click=${() => this.act("suspend")}>挂起</button>
          <button class="primary" @click=${() => this.act("deliver")}>交付</button>` : ""}
        ${s5.status === "suspended" ? b2`
          <button class="primary" @click=${() => this.act("resume")}>恢复</button>
          <button @click=${() => this.act("deliver")}>交付</button>
          <button class="danger" @click=${() => this.act("delete")}>丢弃</button>` : ""}
        ${s5.status === "delivered" ? b2`
          ${s5.task_id ? b2`<a class="link" href="#/issue/${s5.task_id}">查看任务 #${s5.task_id} →</a>` : ""}` : ""}
      </div>`;
        }
      };
      __publicField(PhSessionHeader, "styles", i`
    ${PW}
    :host { flex: 0 0 auto; border-bottom: 1px solid var(--pw-border); background: var(--pw-bg); }
    .strip { display: flex; align-items: center; gap: 10px; padding: 8px 12px; flex-wrap: wrap; }
    .title { font-weight: 700; font-size: 14px; color: var(--pw-text); display: flex; align-items: center; gap: 8px; min-width: 0; }
    .title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { font-size: 11px; border-radius: 999px; padding: 2px 10px; font-weight: 600; border: 1px solid var(--pw-border); color: var(--pw-text-secondary); flex: 0 0 auto; }
    .badge.running { border-color: var(--pw-success-border); background: var(--pw-success-surface); color: var(--pw-success); }
    .badge.suspended { color: var(--pw-dim); }
    .badge.delivered { border-color: var(--pw-accent-border); background: var(--pw-selection-bg); color: var(--pw-accent); }
    .badge.created { color: var(--pw-muted); }
    .meta { color: var(--pw-muted); font-size: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; min-width: 0; }
    .meta .cli { border: 1px solid var(--pw-border); border-radius: 4px; padding: 0 5px; font-size: 10px; font-weight: 700; }
    .spacer { flex: 1; }
    button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--pw-border); border-radius: 7px; background: var(--pw-surface); color: var(--pw-text); padding: 5px 10px; cursor: pointer; font-size: 12.5px; }
    button:hover { background: var(--pw-surface-hover); }
    button.primary { border-color: var(--pw-accent-border); background: var(--pw-selection-bg); color: var(--pw-accent); }
    button.danger { color: var(--pw-danger); border-color: var(--pw-danger); }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .link { color: var(--pw-accent); font-size: 12.5px; text-decoration: none; }
    .link:hover { text-decoration: underline; }
  `);
      __publicField(PhSessionHeader, "properties", { session: { attribute: false }, live: { attribute: false }, running: { attribute: false } });
      customElements.define("ph-session-header", PhSessionHeader);
      PhMessageStream = class extends i4 {
        constructor() {
          super();
          this.entries = [];
          this.sessionId = null;
          this._atBottom = true;
          this._loadingOlder = false;
          this._onLive = () => this.requestUpdate();
        }
        connectedCallback() {
          super.connectedCallback();
          window.addEventListener("ph-session-message", this._onLive);
        }
        disconnectedCallback() {
          super.disconnectedCallback();
          window.removeEventListener("ph-session-message", this._onLive);
        }
        willUpdate(ch) {
          if (ch.has("sessionId")) this._atBottom = true;
        }
        updated() {
          if (this._atBottom) {
            cancelAnimationFrame(this._scrollRaf);
            this._scrollRaf = requestAnimationFrame(() => this.scrollToBottom());
          }
        }
        scrollToBottom() {
          const chat = this.renderRoot.querySelector(".chat");
          if (chat) chat.scrollTop = chat.scrollHeight;
        }
        onScroll(e5) {
          const chat = e5.currentTarget;
          this._atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
          if (chat.scrollTop <= 40 && !this._loadingOlder && this._hasOlder()) {
            this._loadingOlder = true;
            const prevHeight = chat.scrollHeight;
            setTimeout(() => {
              const page = document.querySelector("ph-sessions-page");
              page.loadEarlier().then(() => {
                chat.scrollTop = chat.scrollHeight - prevHeight + 40;
                this._loadingOlder = false;
              });
            }, 50);
          }
        }
        _hasOlder() {
          const st = sessionState;
          return st.transcriptLoaded < st.transcriptTotal;
        }
        render() {
          if (!this.entries.length) {
            return b2`<div class="chat"><div class="pw-empty">还没有消息。在下方输入第一条指令，开始与 agent 协作。<br>完成后可点「交付」转为任务，走审批 → 合并流程。</div></div>`;
          }
          const st = sessionState;
          const from = st.transcriptTotal - st.transcriptLoaded + 1;
          const bar = st.transcriptTotal > 100 ? b2`<div class="page-bar">
      <span>Showing ${Math.max(from, 1)}–${st.transcriptTotal} of ${st.transcriptTotal}</span>
      ${this._hasOlder() ? b2`<button @click=${() => this.scrollTop = 0}>↑ 加载更早</button>` : ""}
    </div>` : "";
          return b2`
      <div class="chat" @scroll=${this.onScroll}>${this.entries.map((it, i6) => renderItem(it, i6))}</div>
      ${bar}`;
        }
      };
      __publicField(PhMessageStream, "styles", i`
    ${PW}
    :host { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .chat { flex: 1; min-height: 0; overflow: auto; overflow-anchor: none; padding: 26px 16px 64px; box-sizing: border-box; }
    .pw-empty { margin: 60px auto; max-width: 420px; color: var(--pw-muted); text-align: center; font-size: 14px; line-height: 1.8; }
    .page-bar { flex: 0 0 auto; display: flex; justify-content: center; gap: 8px; align-items: center; padding: 6px; font-size: 11.5px; color: var(--pw-dim); border-top: 1px solid var(--pw-border-muted); }
    .page-bar button { border: 1px solid var(--pw-border); border-radius: 7px; background: var(--pw-surface); color: var(--pw-text-secondary); padding: 3px 10px; cursor: pointer; font-size: 11.5px; }
    .page-bar button:hover { background: var(--pw-surface-hover); }
  `);
      __publicField(PhMessageStream, "properties", { entries: { attribute: false }, sessionId: { attribute: false } });
      customElements.define("ph-message-stream", PhMessageStream);
      msgStyles = i`
  ${PW}
  :host { display: block; max-width: 100%; min-width: 0; }
  .msg { max-width: 100%; min-width: 0; box-sizing: border-box; margin: 0 0 14px; padding: 12px; border: 1px solid var(--pw-border); border-radius: 10px; background: var(--pw-surface); overflow: visible; color: var(--pw-text); font-size: 14px; line-height: 1.6; }
  .msg.user { border-color: var(--pw-accent-border); background: var(--pw-selection-bg); }
  .msg.streaming { border-color: var(--pw-success-border); box-shadow: 0 0 0 1px var(--pw-success-ring); }
  .msg-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 22px; margin-bottom: 8px; }
  .msg-header .who { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 700; color: var(--pw-text-secondary); }
  .msg-header .when { color: var(--pw-dim); font-size: 11.5px; }
  .msg.user .msg-header .who { color: var(--pw-accent); }
  .msg .ph-md :is(p, ul, ol) { margin: 4px 0; }
  .msg .ph-md h1, .msg .ph-md h2, .msg .ph-md h3, .msg .ph-md h4 { font-size: 14.5px; margin: 8px 0 4px; }
  .msg .ph-md blockquote { border-left: 3px solid var(--pw-border); margin: 4px 0; padding-left: 8px; color: var(--pw-muted); }
  .msg .ph-md code { background: var(--pw-surface-hover); border-radius: 4px; padding: 1px 5px; font-size: 12.5px; }
  .msg .ph-md a { color: var(--pw-accent); }
  .ph-code { background: var(--pw-terminal-bg); color: var(--pw-text-secondary); border: 1px solid var(--pw-border-muted); border-radius: 8px; padding: 10px 12px; overflow-x: auto; font-size: 12.5px; line-height: 1.55; }
  .ph-md pre { margin: 6px 0; }
  .thinking { border: 1px solid var(--pw-purple-border); background: var(--pw-purple-surface); border-radius: 8px; padding: 6px 10px; margin: 6px 0; font-size: 13px; color: var(--pw-purple); }
  .thinking summary { cursor: pointer; font-weight: 600; }
  .usage { font-size: 11.5px; color: var(--pw-dim); margin-top: 4px; }
  .stop-aborted { color: var(--pw-danger); font-size: 11.5px; }
  .pw-event { text-align: center; font-size: 11.5px; color: var(--pw-dim); padding: 10px 0; }
`;
      PhMsgUser = class extends i4 {
        render() {
          const m2 = this.msg || {};
          const blocks = Array.isArray(m2.content) ? m2.content : [{ type: "text", text: m2.content }];
          return b2`<div class="msg user">
      <div class="msg-header"><span class="who">你</span><span class="when">${fmtTime(m2.timestamp)}</span></div>
      <div class="ph-md">${blocks.map((b3) => b3.type === "image" ? b2`<img src=${`data:${b3.mimeType || "image/png"};base64,${b3.data}`} style="max-width:200px;border-radius:8px">` : b2`<div>${md(b3.text || "")}</div>`)}</div>
    </div>`;
        }
      };
      __publicField(PhMsgUser, "styles", msgStyles);
      __publicField(PhMsgUser, "properties", { msg: { attribute: false } });
      customElements.define("ph-msg-user", PhMsgUser);
      PhMsgAssistant = class extends i4 {
        render() {
          const m2 = this.msg || {};
          const streaming = this.streaming || m2.stopReason === "pending";
          const blocks = Array.isArray(m2.content) ? m2.content : [];
          const texts = [], tools = [];
          for (const b3 of blocks) {
            if (b3.type === "text") texts.push(md(b3.text || ""));
            else if (b3.type === "thinking") texts.push(b2`<details class="thinking"><summary>💭 思考（${(b3.thinking || "").length} 字）</summary><div class="ph-md">${md(b3.thinking)}</div></details>`);
            else if (b3.type === "toolCall") tools.push(b3);
          }
          const model = m2.model || "";
          const toolResults = this.toolResults;
          const events = tools.length ? b2`<details class="events" ${streaming ? "open" : ""}>
          <summary><span>▸ events</span><span class="count">${tools.length} tool</span></summary>
          <div class="events-body">${tools.map((t5) => b2`<ph-tool-card .call=${t5} .result=${toolResults && toolResults.get(t5.id) || null}></ph-tool-card>`)}</div>
        </details>` : "";
          return b2`<div class="msg assistant ${streaming ? "streaming" : ""}">
      <div class="msg-header">
        <span class="who">${model ? model.split("/").pop() : "Agent"}${streaming ? b2`<span style="color:var(--pw-success);font-weight:400">…</span>` : ""}</span>
        <span class="when">${fmtTime(m2.timestamp)}${m2.stopReason === "aborted" ? b2`<span class="stop-aborted"> · 已中止</span>` : ""}</span>
      </div>
      <div class="ph-md">${texts}</div>
      ${events}
      ${m2.usage ? b2`<div class="usage">tokens: ${m2.usage.totalTokens || 0}${m2.usage.cost ? ` \xB7 $${m2.usage.cost.total || 0}` : ""}</div>` : ""}
    </div>`;
        }
      };
      __publicField(PhMsgAssistant, "styles", [msgStyles, i`
    .events { border: 1px solid var(--pw-border); border-radius: 8px; margin: 8px 0 4px; overflow: hidden; }
    .events summary { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; font-size: 12px; color: var(--pw-muted); background: var(--pw-bg); user-select: none; }
    .events summary:hover { background: var(--pw-surface-hover); color: var(--pw-text-secondary); }
    .events[open] summary { border-bottom: 1px solid var(--pw-border); }
    .events .count { font-weight: 700; }
    .events-body { padding: 6px 8px; background: var(--pw-bg); }
  `]);
      __publicField(PhMsgAssistant, "properties", { msg: { attribute: false }, toolLive: { attribute: false }, toolResults: { attribute: false }, streaming: { attribute: false } });
      customElements.define("ph-msg-assistant", PhMsgAssistant);
      PhMsgBash = class extends i4 {
        render() {
          const m2 = this.msg || {};
          const err = m2.isError || m2.exitCode !== void 0 && m2.exitCode !== null && m2.exitCode !== 0;
          return b2`<div class="bash">
      <div class="cmd"><span class="prompt">$ </span>${m2.command || ""}</div>
      ${m2.output ? b2`<div class="out">${m2.output}</div>` : ""}
      <div class="code"><span class="${err ? "err" : "ok"}">${err ? "\u2717 \u5931\u8D25" : "\u2713 \u6210\u529F"}</span>${m2.exitCode !== void 0 && m2.exitCode !== null ? ` \xB7 exit ${m2.exitCode}` : ""}${m2.truncated ? " \xB7 \u5DF2\u622A\u65AD" : ""}</div>
    </div>`;
        }
      };
      __publicField(PhMsgBash, "styles", i`
    ${PW}
    :host { display: block; margin: 0 0 14px; }
    .bash { border: 1px solid var(--pw-border); border-radius: 10px; background: var(--pw-terminal-bg); color: var(--pw-text-secondary); font-family: ui-monospace, monospace; font-size: 12.5px; overflow: hidden; }
    .cmd { padding: 9px 12px; color: var(--pw-text); border-bottom: 1px solid var(--pw-border-muted); }
    .cmd .prompt { color: var(--pw-success); }
    .out { padding: 9px 12px; white-space: pre-wrap; max-height: 320px; overflow-y: auto; color: var(--pw-text-secondary); }
    .code { padding: 0 12px 9px; font-size: 11.5px; display: flex; gap: 8px; align-items: center; }
    .ok { color: var(--pw-success); } .err { color: var(--pw-danger); }
  `);
      __publicField(PhMsgBash, "properties", { msg: { attribute: false } });
      customElements.define("ph-msg-bash", PhMsgBash);
      PhMsgCustom = class extends i4 {
        render() {
          const m2 = this.msg || {};
          return b2`<div class="box"><div class="t">${m2.customType || "custom"}</div><div class="ph-md">${md(typeof m2.content === "string" ? m2.content : "")}</div></div>`;
        }
      };
      __publicField(PhMsgCustom, "styles", i`
    ${PW}
    :host { display: block; margin: 0 0 14px; }
    .box { border: 1px solid var(--pw-purple-border); border-radius: 10px; padding: 8px 12px; font-size: 13px; background: var(--pw-purple-surface); color: var(--pw-text); }
    .t { font-weight: 700; color: var(--pw-purple); font-size: 11px; margin-bottom: 4px; }
  `);
      __publicField(PhMsgCustom, "properties", { msg: { attribute: false } });
      customElements.define("ph-msg-custom", PhMsgCustom);
      PhToolCard = class extends i4 {
        constructor() {
          super();
          this.open = false;
        }
        render() {
          const t5 = this.call || {};
          const r6 = this.result;
          const name = toolName(t5);
          const arg = toolArg(name, t5.arguments);
          const isErr = r6 && r6.isError;
          const status = isErr ? "error" : "success";
          const icon2 = isErr ? "\u2717" : "\u2713";
          const body = r6 ? Array.isArray(r6.content) ? r6.content.map((c5) => c5.text || "").join("\n") : String(r6.content || "") : "";
          return b2`
      <div class="tool-card ${status}">
        <div class="tool-header" @click=${() => this.open = !this.open}>
          <div class="tool-title">
            <span class="status-icon">${this.open ? "\u25BE" : "\u25B8"}</span>
            <strong>${name}</strong>
            ${arg ? b2`<span class="target">${arg}</span>` : ""}
          </div>
          <div class="tool-meta"><span class="${isErr ? "err" : "ok"}">${icon2}</span>${body ? this.open ? "\u6536\u8D77" : "\u5C55\u5F00" : ""}</div>
        </div>
        ${this.open && body !== "" ? b2`<div class="body">${body}</div>` : ""}
      </div>`;
        }
      };
      __publicField(PhToolCard, "styles", i`
    ${PW}
    :host { display: block; width: 100%; max-width: 100%; min-width: 0; color: var(--pw-text); margin: 8px 0; }
    .tool-card { display: grid; gap: 8px; width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; overflow: hidden; border: 1px solid var(--pw-border); border-radius: 8px; background: var(--pw-bg); padding: 9px; color: var(--pw-text); }
    .tool-card.success { border-color: var(--pw-success-border); background: var(--pw-success-bg); }
    .tool-card.error { border-color: var(--pw-danger); background: color-mix(in srgb, var(--pw-danger) 10%, var(--pw-bg)); }
    .tool-header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-width: 0; cursor: pointer; }
    .tool-title { flex: 1 1 auto; display: inline-flex; align-items: baseline; gap: 7px; min-width: 0; }
    .status-icon { flex: 0 0 auto; color: var(--pw-muted); }
    .tool-title strong { flex: 0 0 auto; color: var(--pw-text); font-size: 13px; }
    .target { display: block; flex: 1 1 auto; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pw-muted); font-size: 12.5px; font-family: ui-monospace, monospace; }
    .tool-meta { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 8px; color: var(--pw-dim); font-size: 11.5px; }
    .tool-meta .ok { color: var(--pw-success); } .tool-meta .err { color: var(--pw-danger); }
    .body { border-top: 1px solid var(--pw-border-muted); padding-top: 8px; max-height: 320px; overflow-y: auto; white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 12px; color: var(--pw-text-secondary); }
  `);
      __publicField(PhToolCard, "properties", { call: { attribute: false }, result: { attribute: false }, open: { state: true } });
      customElements.define("ph-tool-card", PhToolCard);
      PhSessionTerm = class extends i4 {
        constructor() {
          super();
          this._term = null;
          this._fit = null;
          this._timer = null;
          this._dead = false;
        }
        connectedCallback() {
          super.connectedCallback();
          this._init();
        }
        disconnectedCallback() {
          super.disconnectedCallback();
          if (this._timer) clearInterval(this._timer);
          this._timer = null;
          if (this._resizeTimer) clearInterval(this._resizeTimer);
          if (this._term) {
            try {
              this._term.dispose();
            } catch (_2) {
            }
          }
          this._term = null;
        }
        async _init() {
          const id = this.session.id;
          const wrap = this.shadowRoot.querySelector(".term-wrap");
          if (!wrap || !globalThis.Terminal) return;
          this._term = new Terminal({ fontSize: 13, fontFamily: "ui-monospace, monospace", theme: { background: "#05070a", foreground: "#e6edf3", cursor: "#58a6ff" }, scrollback: 5e3 });
          if (globalThis.FitAddon) {
            this._fit = new globalThis.FitAddon.FitAddon();
            this._term.loadAddon(this._fit);
          }
          this._term.open(wrap);
          if (this._fit) this._fit.fit();
          this._term.onData((data) => {
            api(`/api/sessions/${id}/terminal/input`, { method: "POST", body: JSON.stringify({ text: data, raw: true }) }).catch(() => {
            });
          });
          if (this._fit) {
            const fit = this._fit;
            const pushResize = () => {
              if (this._term && !this._dead) {
                api(`/api/sessions/${id}/terminal/resize`, { method: "POST", body: JSON.stringify({ cols: this._term.cols, rows: this._term.rows }) }).catch(() => {
                });
              }
            };
            try {
              fit.fit();
              pushResize();
            } catch (_2) {
            }
            this._resizeTimer = setInterval(() => {
              try {
                fit.fit();
                pushResize();
              } catch (_2) {
              }
            }, 3e3);
          }
          this._timer = setInterval(async () => {
            try {
              const r6 = await api(`/api/sessions/${id}/terminal/output`);
              if (r6.output) this._term.write(r6.output);
              if (r6.alive === false) {
                this._dead = true;
                if (this._timer) clearInterval(this._timer);
              }
            } catch (_2) {
            }
          }, 700);
        }
        render() {
          const s5 = this.session;
          return b2`
      <div class="bar">终端式会话（${s5.cli}）· 输出由 tmux 实时捕获</div>
      <div class="term-wrap"></div>
      <div class="tip">点击终端直接输入 · 输入 /exit 退出 · 挂起后恢复将重建窗口</div>
    `;
        }
      };
      __publicField(PhSessionTerm, "styles", i`
    ${PW}
    :host { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px; gap: 8px; background: var(--pw-bg); }
    .bar { font-size: 12px; color: var(--pw-muted); display: flex; align-items: center; gap: 8px; }
    .term-wrap { flex: 1; min-height: 240px; border: 1px solid var(--pw-border); border-radius: 10px; overflow: hidden; padding: 6px; background: var(--pw-terminal-bg); }
    .tip { font-size: 12px; color: var(--pw-dim); }
  `);
      __publicField(PhSessionTerm, "properties", { session: { attribute: false } });
      customElements.define("ph-session-term", PhSessionTerm);
      PhSessionInput = class extends i4 {
        constructor() {
          super();
          this.value = "";
          this.mode = "steer";
        }
        _send() {
          const msg = this.value.trim();
          if (!msg) return;
          const id = this.session.id;
          const body = { message: msg };
          if (this.running) body.streaming_behavior = this.mode === "followUp" ? "followUp" : "steer";
          api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify(body) }).then(() => {
            this.value = "";
            this.requestUpdate();
            window.dispatchEvent(new CustomEvent("ph-session-message", {
              detail: {
                session_id: id,
                event: {
                  type: "user_echo",
                  message: { role: "user", content: [{ type: "text", text: msg }], timestamp: Date.now() }
                }
              }
            }));
            this.dispatchEvent(new CustomEvent("refresh", { bubbles: true, composed: true }));
          }).catch((e5) => toastErr(e5.message || String(e5)));
        }
        _abort() {
          api(`/api/sessions/${this.session.id}/abort`, { method: "POST" }).then(() => window.dispatchEvent(new CustomEvent("ph-session-updated"))).catch((e5) => toastErr(e5.message || String(e5)));
        }
        render() {
          const s5 = this.session;
          const disabled = s5.status === "delivered" || s5.status === "deleted" || s5.status === "created";
          const shellMode = this.running && s5.status === "active";
          const hint = s5.status === "delivered" ? "\u5DF2\u4EA4\u4ED8\u4E3A\u4EFB\u52A1\uFF0C\u4F1A\u8BDD\u51BB\u7ED3\uFF08\u53EA\u8BFB\uFF09" : s5.status === "created" ? "\u70B9\u51FB\u300C\u542F\u52A8\u300D\u5F00\u59CB\u4F1A\u8BDD" : s5.status === "suspended" ? "\u4F1A\u8BDD\u5DF2\u6302\u8D77\uFF0C\u70B9\u51FB\u300C\u6062\u590D\u300D\u7EE7\u7EED\u5BF9\u8BDD" : shellMode ? "agent \u6B63\u5728\u5904\u7406\u2026" : "Enter \u53D1\u9001 \xB7 Shift+Enter \u6362\u884C";
          return b2`
      <footer class=${shellMode ? "shell-mode" : ""}>
        ${shellMode ? b2`<div class="hint">
          <span class="mode">
            <span class=${this.mode === "steer" ? "on" : ""} @click=${() => this.mode = "steer"}>插入</span>
            <span class=${this.mode === "followUp" ? "on" : ""} @click=${() => this.mode = "followUp"}>排队</span>
          </span>
          <span class="mode-hint">运行中 · 消息将排队</span>
          <span class="spacer"></span>
          <button class="danger" @click=${this._abort}>■ 中止</button>
        </div>` : b2`<div class="hint">${hint}</div>`}
        <div class="row">
          <textarea .value=${this.value} ?disabled=${disabled} @input=${(e5) => this.value = e5.target.value}
            @keydown=${(e5) => {
            if (e5.key === "Enter" && !e5.shiftKey && !e5.isComposing) {
              e5.preventDefault();
              this._send();
            }
          }}
            placeholder=${disabled ? hint : "\u8F93\u5165\u6307\u4EE4\uFF0C\u4E0E agent \u534F\u4F5C\u2026"}></textarea>
          <button class="primary" ?disabled=${disabled || !this.value.trim()} @click=${this._send} title="发送 (Enter)">↑ 发送</button>
        </div>
      </footer>`;
        }
      };
      __publicField(PhSessionInput, "styles", i`
    ${PW}
    :host { flex: 0 0 auto; color: var(--pw-text); font: 14px system-ui, sans-serif; }
    footer { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 12px; border-top: 1px solid var(--pw-border); }
    footer.shell-mode { border-top-color: var(--pw-success); background: var(--pw-success-bg); }
    textarea { box-sizing: border-box; width: 100%; min-height: 54px; max-height: 220px; resize: none; overflow-y: auto; border-radius: 8px; border: 1px solid var(--pw-border); background: var(--pw-bg); color: var(--pw-text); font: 15px/1.4 system-ui, sans-serif; padding: 8px 10px; }
    textarea:focus { outline: none; border-color: var(--pw-accent-border); }
    .shell-mode textarea { border-color: var(--pw-success); box-shadow: 0 0 0 1px var(--pw-success-ring); }
    textarea:disabled { opacity: .5; cursor: not-allowed; }
    .hint { font-size: 12px; color: var(--pw-dim); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .mode { display: flex; border: 1px solid var(--pw-border); border-radius: 7px; overflow: hidden; }
    .mode span { padding: 3px 9px; font-size: 11.5px; cursor: pointer; color: var(--pw-muted); }
    .mode span.on { background: var(--pw-selection-bg); color: var(--pw-accent); }
    .mode-hint { border: 1px solid var(--pw-success-border); border-radius: 999px; background: var(--pw-success-surface); color: var(--pw-success); padding: 2px 9px; font-size: 12px; }
    .row { display: flex; gap: 8px; align-items: flex-end; }
    button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--pw-border); border-radius: 8px; background: var(--pw-surface); color: var(--pw-text); padding: 7px 12px; cursor: pointer; font-size: 13px; }
    button:hover { background: var(--pw-surface-hover); }
    button.primary { border-color: var(--pw-accent-border); background: var(--pw-selection-bg); color: var(--pw-accent); font-weight: 600; }
    button.primary:hover { background: var(--pw-accent-border); color: #fff; }
    button.danger { color: var(--pw-danger); }
    button:disabled { opacity: .5; cursor: not-allowed; }
  `);
      __publicField(PhSessionInput, "properties", { session: { attribute: false }, running: { attribute: false }, value: { state: true }, mode: { state: true } });
      customElements.define("ph-session-input", PhSessionInput);
    }
  });

  // internal/web/static/src/task-diff.js
  function parseUnifiedDiff(text) {
    const files = [];
    let cur = null;
    const lines = String(text || "").split("\n");
    for (let i6 = 0; i6 < lines.length; i6++) {
      const l3 = lines[i6];
      if (l3.startsWith("diff --git")) {
        if (cur) files.push(cur);
        cur = { name: "", oldName: "", status: "M", added: 0, removed: 0, hunks: [] };
        const m2 = /diff --git a\/(\S+) b\/(\S+)/.exec(l3);
        if (m2) {
          cur.oldName = m2[1];
          cur.name = m2[2];
        }
        continue;
      }
      if (!cur) continue;
      if (l3.startsWith("new file")) {
        cur.status = "A";
        cur.name = cur.name || lines[i6 + 1]?.replace(/^.*\s/, "");
        continue;
      }
      if (l3.startsWith("deleted file")) {
        cur.status = "D";
        continue;
      }
      if (l3.startsWith("rename")) {
        cur.status = "R";
        continue;
      }
      if (l3.startsWith("index ") || l3.startsWith("--- ") || l3.startsWith("+++ ") || l3.startsWith("Binary") || l3.startsWith("similarity") || l3.startsWith("dissimilarity")) continue;
      const h4 = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l3);
      if (h4) {
        cur.hunks.push({
          oldStart: +h4[1],
          oldLines: h4[2] ? +h4[2] : 1,
          newStart: +h4[3],
          newLines: h4[4] ? +h4[4] : 1,
          lines: []
        });
        continue;
      }
      const hunk = cur.hunks[cur.hunks.length - 1];
      if (!hunk) continue;
      if (l3.startsWith("+")) {
        hunk.lines.push({ kind: "add", text: l3.slice(1) });
        cur.added++;
      } else if (l3.startsWith("-")) {
        hunk.lines.push({ kind: "del", text: l3.slice(1) });
        cur.removed++;
      } else if (l3.startsWith(" ")) hunk.lines.push({ kind: "ctx", text: l3.slice(1) });
      else hunk.lines.push({ kind: "ctx", text: l3 });
    }
    if (cur) files.push(cur);
    return files;
  }
  function mountTaskDiff(el, taskId, taskStatus) {
    el.innerHTML = "";
    const node = document.createElement("ph-task-diff");
    node.taskId = taskId;
    node._taskStatus = taskStatus;
    el.appendChild(node);
    return node;
  }
  var PhTaskDiff;
  var init_task_diff = __esm({
    "internal/web/static/src/task-diff.js"() {
      init_lit();
      init_core();
      PhTaskDiff = class extends i4 {
        constructor() {
          super();
          this.taskId = null;
          this.files = [];
          this.note = "";
          this.loading = false;
          this.open = /* @__PURE__ */ new Set();
          this.reviewNote = "";
          this.busy = false;
        }
        async updated(changed) {
          if (changed.has("taskId") && this.taskId) await this.load();
        }
        async load() {
          this.loading = true;
          this.files = [];
          this.note = "";
          this.requestUpdate();
          try {
            const d3 = await api(`/api/tasks/${this.taskId}/diff`);
            const parsed = parseUnifiedDiff(d3.diff);
            for (const f4 of parsed) {
              const big = f4.added + f4.removed > 60 || f4.hunks.length > 3;
              this.open.add(f4.name);
              if (big) this.open.delete(f4.name);
            }
            this.files = parsed;
            this.note = d3.note || "";
            this._stat = d3.stat;
          } catch (_2) {
          }
          this.loading = false;
          this.requestUpdate();
        }
        _toggle(name) {
          if (this.open.has(name)) this.open.delete(name);
          else this.open.add(name);
          this.requestUpdate();
        }
        async approve() {
          this.busy = true;
          try {
            await api(`/api/tasks/${this.taskId}`, {
              method: "PATCH",
              body: JSON.stringify({ status: "succeeded" })
            });
            window.dispatchEvent(new CustomEvent("task-refresh"));
          } catch (e5) {
            Promise.resolve().then(() => (init_core(), core_exports)).then((m2) => m2.toast(e5.message || String(e5), true));
          }
          this.busy = false;
        }
        async reject() {
          if (!this.reviewNote.trim()) {
            Promise.resolve().then(() => (init_core(), core_exports)).then((m2) => m2.toast("\u8BF7\u586B\u5199\u4FEE\u6539\u610F\u89C1", true));
            return;
          }
          this.busy = true;
          try {
            await api(`/api/tasks/${this.taskId}`, {
              method: "PATCH",
              body: JSON.stringify({ status: "queued", review_note: this.reviewNote })
            });
            this.reviewNote = "";
            window.dispatchEvent(new CustomEvent("task-refresh"));
          } catch (e5) {
            Promise.resolve().then(() => (init_core(), core_exports)).then((m2) => m2.toast(e5.message || String(e5), true));
          }
          this.busy = false;
        }
        render() {
          if (this.loading) return b2`<div class="empty">加载 diff…</div>`;
          if (!this.files.length) return b2`<div class="empty">无文件改动或非 git 仓库${this.note ? `\uFF08${this.note}\uFF09` : ""}</div>`;
          const totalAdd = this.files.reduce((s5, f4) => s5 + f4.added, 0);
          const totalDel = this.files.reduce((s5, f4) => s5 + f4.removed, 0);
          return b2`
      <div class="bar">
        <span class="stat">${this.files.length} 个文件 · <span class="add">+${totalAdd}</span> <span class="del">-${totalDel}</span></span>
        <span class="spacer"></span>
        <button @click=${() => this._toggleAll(true)}>全部展开</button>
        <button @click=${() => this._toggleAll(false)}>全部折叠</button>
      </div>
      ${this.renderReviewBar()}
      ${this.files.map((f4) => this.renderFile(f4))}
    `;
        }
        _toggleAll(open) {
          if (open) for (const f4 of this.files) this.open.add(f4.name);
          else for (const f4 of this.files) this.open.delete(f4.name);
          this.requestUpdate();
        }
        renderReviewBar() {
          const st = this._taskStatus;
          if (st !== "awaiting_review") return A;
          return b2`
      <div class="bar" style="border-color:var(--warning);background:rgba(234,191,101,.08)">
        <span class="stat">⏳ 待审批 — 请审查下方 diff 后决定</span>
        <span class="spacer"></span>
        <textarea .value=${this.reviewNote} @input=${(e5) => this.reviewNote = e5.target.value} placeholder="驳回时填写修改意见…"></textarea>
        <button class="no" ?disabled=${this.busy} @click=${this.reject}>驳回</button>
        <button class="ok" ?disabled=${this.busy} @click=${this.approve}>批准合并</button>
      </div>`;
        }
        renderFile(f4) {
          const open = this.open.has(f4.name);
          return b2`
      <div class="fhead" @click=${() => this._toggle(f4.name)}>
        <span>${open ? "\u25BE" : "\u25B8"}</span>
        <span class="status st-${f4.status}">${f4.status === "A" ? "\u65B0\u589E" : f4.status === "D" ? "\u5220\u9664" : f4.status === "R" ? "\u6539\u540D" : "\u4FEE\u6539"}</span>
        <span class="fname" title=${f4.name}>${f4.name}</span>
        <span class="fmeta">+${f4.added} -${f4.removed}</span>
        <span class="jump">${f4.hunks.length} 段</span>
      </div>
      ${open ? f4.hunks.map((h4) => this.renderHunk(f4, h4)) : ""}`;
        }
        renderHunk(f4, h4) {
          const MAX_CTX = 16;
          const out = [];
          let oldN = h4.oldStart, newN = h4.newStart;
          let ctxRun = [];
          const flushCtx = (folded) => {
            if (!ctxRun.length) return;
            if (folded) {
              out.push(b2`<tr><td class="fold" colspan="2" @click=${this._expandAll}>⋯ 上下文折叠 ${ctxRun.length} 行（点击展开全部）⋯</td></tr>`);
            } else {
              for (const l3 of ctxRun) out.push(this.row(l3, oldN++, newN++));
            }
            ctxRun = [];
          };
          for (const l3 of h4.lines) {
            if (l3.kind === "ctx") {
              ctxRun.push(l3);
              if (ctxRun.length > MAX_CTX) flushCtx(true);
              continue;
            }
            flushCtx(ctxRun.length > MAX_CTX && false);
            if (l3.kind === "add") {
              out.push(this.row(l3, null, newN++));
            } else if (l3.kind === "del") {
              out.push(this.row(l3, oldN++, null));
            }
          }
          flushCtx(false);
          return b2`<table><tbody>${out}</tbody></table>`;
        }
        row(l3, oldN, newN) {
          return b2`<tr class=${l3.kind}>
      <td class="ln">${oldN ?? ""}</td><td class="ln">${newN ?? ""}</td>
      <td class="tx">${l3.text}</td></tr>`;
        }
      };
      __publicField(PhTaskDiff, "styles", i`
    :host { display: block; color: var(--pw-text); font: 14px system-ui, sans-serif; }
    .bar { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border: 1px solid var(--pw-border); border-radius: 8px; margin-bottom: 10px; flex-wrap: wrap; background: var(--pw-surface); }
    .bar .stat { font-size: 12.5px; color: var(--pw-muted); display: flex; gap: 8px; align-items: center; }
    .add { color: var(--pw-success); font-weight: 700; }
    .del { color: var(--pw-danger); font-weight: 700; }
    .spacer { flex: 1; }
    button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--pw-border); border-radius: 7px; background: var(--pw-surface); color: var(--pw-text); padding: 4px 10px; cursor: pointer; font-size: 12.5px; }
    button:hover { background: var(--pw-surface-hover); }
    button.ok { background: var(--pw-success); border-color: var(--pw-success-border); color: #fff; font-weight: 600; }
    button.no { background: var(--pw-danger); border-color: var(--pw-danger); color: #fff; font-weight: 600; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    textarea { border: 1px solid var(--pw-border); border-radius: 8px; padding: 6px 10px; font-size: 13px; width: 260px; background: var(--pw-bg); color: var(--pw-text); font-family: inherit; }
    textarea:focus { outline: none; border-color: var(--pw-accent-border); }
    .fhead { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--pw-border); border-radius: 8px; margin: 4px 0; cursor: pointer; background: var(--pw-surface); font-size: 13px; color: var(--pw-text); }
    .fhead:hover { border-color: var(--pw-accent-border); }
    .fname { font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .fmeta { font-size: 11.5px; color: var(--pw-muted); }
    .status { font-weight: 700; font-size: 11px; border-radius: 4px; padding: 0 5px; }
    .st-A { color: var(--pw-success); } .st-D { color: var(--pw-danger); } .st-M { color: var(--pw-accent); }
    table { border-collapse: collapse; width: 100%; font-family: ui-monospace, monospace; font-size: 12.5px; margin-bottom: 8px; border: 1px solid var(--pw-border); border-radius: 8px; overflow: hidden; background: var(--pw-bg); }
    tr { border: none; }
    td { padding: 0; vertical-align: top; }
    .ln { width: 44px; text-align: right; padding-right: 8px; color: var(--pw-dim); user-select: none; background: var(--pw-surface); }
    .tx { white-space: pre-wrap; word-break: break-all; padding-left: 10px; }
    .add { background: var(--pw-success-bg); }
    .del { background: color-mix(in srgb, var(--pw-danger) 10%, var(--pw-bg)); }
    .add .tx { color: var(--pw-success); } .del .tx { color: var(--pw-danger); }
    .ctx .tx { color: var(--pw-text-secondary); opacity: .8; }
    .fold { text-align: center; font-size: 11.5px; color: var(--pw-dim); background: var(--pw-surface); cursor: pointer; padding: 3px; user-select: none; }
    .fold:hover { color: var(--pw-accent); }
    .empty { color: var(--pw-muted); font-size: 13px; padding: 8px 4px; }
    .jump { margin-left: auto; font-size: 11.5px; color: var(--pw-dim); }
  `);
      __publicField(PhTaskDiff, "properties", {
        taskId: { attribute: false },
        files: { state: true },
        note: { state: true },
        loading: { state: true },
        reviewNote: { state: true },
        busy: { state: true }
      });
      customElements.define("ph-task-diff", PhTaskDiff);
    }
  });

  // internal/web/static/src/dashboard.js
  function dashCardHTML(t5, actions) {
    return `<article class="card dash-card" onclick="openTask(${t5.id})" style="--st-color:${ST_COLOR[t5.status]}">
    <div class="c-top">
      <span class="st-dot"></span><span class="c-id">#${t5.id}</span>
      <span class="c-time">${(t5.created_at || "").slice(5, 16).replace("T", " ")}</span>
      ${t5.perm === "review" ? `<span class="chip review">\u5BA1\u6279</span>` : ""}
    </div>
    <a class="c-title card-primary-action" href="#/issue/${t5.id}" onclick="event.stopPropagation();openTask(${t5.id});return false">${esc(t5.title)}</a>
    <div class="c-meta">
      ${t5.project_name ? `<span class="chip">${esc(t5.project_name)}</span>` : ""}
      <span class="c-foot">
        ${t5.agent_name ? `<span class="c-agent"><span class="avatar sm av-${esc(t5.agent_name)}">${esc((t5.agent_name || "?").slice(0, 1))}</span>${esc(t5.agent_name)}</span>` : `<span class="c-agent" style="color:var(--fg-faint)">\u672A\u6307\u6D3E</span>`}
      </span>
    </div>
    ${actions ? `<div class="dash-actions" onclick="event.stopPropagation()">${actions}</div>` : ""}
  </article>`;
  }
  function dashEmpty(title, detail, action) {
    return `<div class="dash-empty">
    <span class="dash-empty-mark" aria-hidden="true"><i></i></span>
    <b>${title}</b><span>${detail}</span>
    ${action || ""}
  </div>`;
  }
  function loadDashboard() {
    refreshOverview();
    renderDashTasks();
    renderDashProjects();
    loadDashAgents();
  }
  function renderDashTasks() {
    const run = document.getElementById("dashRunning");
    const rev = document.getElementById("dashReview");
    if (!run || !rev) return;
    const running = state.tasks.filter((t5) => ["queued", "claimed", "running"].includes(t5.status)).sort((a3, b3) => (a3.created_at || "") < (b3.created_at || "") ? 1 : -1).slice(0, 6);
    const review = state.tasks.filter((t5) => t5.status === "awaiting_review").sort((a3, b3) => (a3.created_at || "") < (b3.created_at || "") ? 1 : -1).slice(0, 6);
    run.innerHTML = running.map((t5) => dashCardHTML(t5)).join("") || dashEmpty(
      "\u6267\u884C\u961F\u5217\u5DF2\u6E05\u7A7A",
      "\u521B\u5EFA\u4EFB\u52A1\u540E\uFF0C\u8FDB\u5EA6\u4F1A\u5728\u8FD9\u91CC\u5B9E\u65F6\u66F4\u65B0\u3002",
      `<button type="button" class="btn xs" onclick="openNewTask()">\u6D3E\u53D1\u4EFB\u52A1</button>`
    );
    rev.innerHTML = review.map((t5) => dashCardHTML(
      t5,
      `<button class="btn xs brand" onclick="setTaskStatus(${t5.id},'succeeded')">\u901A\u8FC7\u5E76\u5408\u5E76</button><button class="btn xs" onclick="rejectTask(${t5.id})">\u9A73\u56DE</button><button class="btn xs" onclick="openTask(${t5.id})">\u67E5\u770B\u8BE6\u60C5</button>`
    )).join("") || dashEmpty(
      "\u5F53\u524D\u65E0\u9700\u5BA1\u6279",
      "\u9700\u8981\u4EBA\u5DE5\u786E\u8BA4\u7684\u4EA4\u4ED8\u4F1A\u96C6\u4E2D\u51FA\u73B0\u5728\u8FD9\u91CC\u3002",
      `<a class="btn xs" href="/history">\u67E5\u770B\u5386\u53F2</a>`
    );
    const rc = document.getElementById("dashRunningCount");
    if (rc) rc.textContent = running.length;
    const vc = document.getElementById("dashReviewCount");
    if (vc) vc.textContent = review.length;
  }
  function renderDashProjects() {
    const box = document.getElementById("dashProjects");
    if (!box) return;
    const active = state.projects.filter((p3) => p3.status === "active");
    if (!active.length) {
      box.innerHTML = `<div class="dash-onboard">
      <div class="ob-title">\u5F00\u59CB\u7B2C\u4E00\u6B21\u4EA4\u4ED8</div>
      <a class="ob-step" href="/agents"><b>01</b><span>\u914D\u7F6E\u672C\u673A\u667A\u80FD\u4F53</span></a>
      <a class="ob-step" href="/roles"><b>02</b><span>\u521B\u5EFA\u4EFB\u52A1\u89D2\u8272</span></a>
      <a class="ob-step" href="/projects"><b>03</b><span>\u5EFA\u7ACB\u9879\u76EE\u5DE5\u4F5C\u533A</span></a>
      <a class="ob-step" href="/board"><b>04</b><span>\u6D3E\u53D1\u9996\u4E2A\u4EFB\u52A1</span></a>
    </div>`;
      return;
    }
    const ranked = active.map((p3) => {
      const ts = state.tasks.filter((t5) => t5.project_id === p3.id);
      const done = ts.filter((t5) => t5.status === "succeeded").length;
      const pct = ts.length ? Math.round(done / ts.length * 100) : 0;
      const inflight = ts.filter((t5) => ["queued", "claimed", "running", "awaiting_review"].includes(t5.status)).length;
      return { p: p3, ts, pct, inflight };
    }).sort((a3, b3) => b3.inflight - a3.inflight || a3.p.name.localeCompare(b3.p.name, "zh-CN"));
    const visible = ranked.slice(0, 4);
    box.innerHTML = visible.map(({ p: p3, ts, pct, inflight }) => {
      return `<a class="dash-proj" href="/projects#/project/${p3.id}">
      <div class="dp-top"><b title="${esc(p3.name)}">${esc(p3.name)}</b>
        ${inflight ? `<span class="badge running">${inflight} \u6D3B\u8DC3</span>` : `<span class="badge">${ts.length} \u4EFB\u52A1</span>`}</div>
      <div class="pc-progress"><div class="pp-bar"><div style="width:${pct}%"></div></div>
        <span class="pc-pct">${pct}%</span></div>
    </a>`;
    }).join("") + (ranked.length > visible.length ? `<a class="dash-more" href="/projects">\u67E5\u770B\u5176\u4F59 ${ranked.length - visible.length} \u4E2A\u9879\u76EE <span aria-hidden="true">\u2192</span></a>` : "");
  }
  async function loadDashAgents() {
    try {
      const prov = await api("/api/provision");
      const box = document.getElementById("dashAgents");
      if (!box) return;
      const installed = prov.filter((p3) => p3.installed);
      const agents = state.agents || [];
      box.innerHTML = `
      <div class="dash-prov">
        ${prov.map((p3) => `<span class="prov-chip ${p3.installed ? "ok" : ""} ${p3.login ? "login" : ""}" title="${esc(p3.name)}${p3.installed ? " " + esc(p3.version) : " \u2014 \u672A\u5B89\u88C5"}${p3.installed && !p3.login ? "\uFF08\u672A\u767B\u5F55\uFF09" : ""}"><i aria-hidden="true"></i>${esc(p3.name)}<span class="sr-only">${p3.installed ? p3.login ? "\u5DF2\u5B89\u88C5\u5E76\u767B\u5F55" : "\u5DF2\u5B89\u88C5\uFF0C\u672A\u767B\u5F55" : "\u672A\u5B89\u88C5"}</span></span>`).join("")}
      </div>
      <div class="dash-prov-meta">
        <span><b>${installed.length}/${prov.length}</b> \u5DF2\u5B89\u88C5</span>
        <span><b>${agents.filter((a3) => a3.enabled).length}</b> \u89D2\u8272\u542F\u7528</span>
      </div>`;
    } catch (_2) {
    }
  }
  var init_dashboard = __esm({
    "internal/web/static/src/dashboard.js"() {
      init_core();
      init_main();
      init_task();
    }
  });

  // internal/web/static/src/history.js
  function loadHistory() {
    const agentId = document.getElementById("hAgent").value;
    const status = document.getElementById("hStatus").value;
    const days = Number(document.getElementById("hDays").value) || 0;
    state.history = state.tasks.filter((t5) => {
      if (agentId && t5.agent_id !== Number(agentId)) return false;
      if (status && t5.status !== status) return false;
      if (days > 0) {
        const end = t5.finished_at || t5.created_at;
        if (!end || Date.now() - new Date(end).getTime() > days * 864e5) return false;
      }
      return true;
    });
    state.historySel.clear();
    renderHistory();
  }
  function renderHistory() {
    const body = document.getElementById("historyBody");
    if (!body) return;
    body.innerHTML = state.history.map((t5) => `
    <tr data-id="${t5.id}" class="${state.historySel.has(t5.id) ? "selected" : ""}" onclick="toggleRow(this)">
      <td class="chk history-check"><input type="checkbox" ${state.historySel.has(t5.id) ? "checked" : ""} onclick="event.stopPropagation()" onchange="toggleRow(this.closest('tr'), this.checked)" aria-label="\u9009\u62E9\u4EFB\u52A1 #${t5.id}"></td>
      <td class="num history-id">#${t5.id}</td>
      <td class="t-title history-title"><span class="t-link" onclick="event.stopPropagation();openTask(${t5.id})">${esc(t5.title)}</span>${isMergeTask(t5) ? ` <span class="chip merge">\u5408\u5E76 #${t5.merge_of}</span>` : ""}</td>
      <td class="history-agent" data-label="\u89D2\u8272">${esc(t5.agent_name || "-")}</td>
      <td class="history-project" data-label="\u9879\u76EE">${esc(t5.project_name || "-")}</td>
      <td class="history-perm" data-label="\u6743\u9650">${PERM_LABEL[t5.perm] || t5.perm}</td>
      <td class="history-status" data-label="\u72B6\u6001"><span class="badge ${t5.status}" style="--st-color:${ST_COLOR[t5.status]}"><span class="st-dot"></span>${STATUS_LABEL[t5.status]}</span></td>
      <td class="history-rounds" data-label="\u8F6E\u6B21">${t5.review_rounds || ""}</td>
      <td class="num history-created" data-label="\u521B\u5EFA">${(t5.created_at || "").slice(5, 16).replace("T", " ")}</td>
      <td class="num history-finished" data-label="\u7ED3\u675F">${(t5.finished_at || "").slice(5, 16).replace("T", " ")}</td>
      <td class="history-actions" data-label="\u64CD\u4F5C">
        <span class="ops">
          ${canRetryTask(t5) ? `<button type="button" class="btn xs" title="${esc(retryTaskLabel(t5))}" aria-label="${esc(retryTaskLabel(t5))}" onclick="event.stopPropagation();setTaskStatus(${t5.id},'queued')">${icon("retry")}<span class="history-action-label">${esc(retryTaskLabel(t5))}</span></button>` : ""}
          ${canDeleteTask(t5) ? `<button type="button" class="btn xs danger" title="\u5220\u9664\u4EFB\u52A1" aria-label="\u5220\u9664\u4EFB\u52A1" onclick="event.stopPropagation();deleteTask(${t5.id})">${icon("trash")}<span class="history-action-label">\u5220\u9664</span></button>` : ""}
        </span>
      </td>
    </tr>`).join("");
    const empty = document.getElementById("historyEmpty");
    if (empty) empty.classList.toggle("hidden", state.history.length > 0);
    const cnt = document.getElementById("hSelCount");
    if (cnt) cnt.textContent = state.historySel.size;
    syncHistorySelectionControls();
  }
  function syncHistorySelectionControls() {
    const checkAll = document.getElementById("hCheckAll");
    if (!checkAll) return;
    const selectedCount = state.history.reduce((count, t5) => count + (state.historySel.has(t5.id) ? 1 : 0), 0);
    const hasHistory = state.history.length > 0;
    checkAll.checked = hasHistory && selectedCount === state.history.length;
    checkAll.indeterminate = selectedCount > 0 && selectedCount < state.history.length;
  }
  function toggleRow(tr, checked) {
    const id = Number(tr.dataset.id);
    const selected = typeof checked === "boolean" ? checked : !state.historySel.has(id);
    if (selected) state.historySel.add(id);
    else state.historySel.delete(id);
    tr.classList.toggle("selected", selected);
    const cb = tr.querySelector("input[type=checkbox]");
    if (cb) cb.checked = selected;
    const cnt = document.getElementById("hSelCount");
    if (cnt) cnt.textContent = state.historySel.size;
    syncHistorySelectionControls();
  }
  function toggleAll(checked) {
    const checkAll = document.getElementById("hCheckAll");
    const all = typeof checked === "boolean" ? checked : Boolean(checkAll?.checked);
    state.historySel.clear();
    if (all) state.history.forEach((t5) => state.historySel.add(t5.id));
    renderHistory();
  }
  function selectAllNonMergeTasks() {
    state.historySel.clear();
    state.history.filter((t5) => !isMergeTask(t5)).forEach((t5) => state.historySel.add(t5.id));
    renderHistory();
  }
  async function deleteSelected() {
    const ids = [...state.historySel];
    if (!ids.length) return toast("\u5148\u52FE\u9009\u8981\u5220\u9664\u7684\u4EFB\u52A1", true);
    if (ids.some((id) => isMergeTask(state.history.find((t5) => t5.id === id)))) {
      return toast("\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1\u4E0D\u80FD\u5355\u72EC\u5220\u9664\uFF1B\u8BF7\u5220\u9664\u5176\u6E90\u4EFB\u52A1\u4EE5\u653E\u5F03\u6574\u7EC4\u4EE3\u7801", true);
    }
    if (!confirm(`\u5220\u9664\u9009\u4E2D\u7684 ${ids.length} \u6761\u4EFB\u52A1\uFF1F\u4E0D\u53EF\u6062\u590D\u3002`)) return;
    try {
      for (const id of ids) await api(`/api/tasks/${id}`, { method: "DELETE" });
      toast(`\u5DF2\u5220\u9664 ${ids.length} \u6761`);
      await loadAll();
      loadHistory();
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  async function cleanupHistory() {
    const agentId = Number(document.getElementById("hAgent").value) || null;
    const days = Number(document.getElementById("hDays").value) || 0;
    const before = days > 0 ? new Date(Date.now() - days * 864e5).toISOString() : "";
    if (!confirm(`\u5220\u9664${agentId ? "\u8BE5\u89D2\u8272" : "\u5168\u90E8\u89D2\u8272"}${before ? "\u3001" + days + " \u5929\u524D" : ""}\u7684\u7EC8\u6001\u4EFB\u52A1\uFF1F\u4E0D\u53EF\u6062\u590D\uFF01`)) return;
    try {
      const r6 = await api("/api/tasks/cleanup", { method: "POST", body: JSON.stringify({ agent_id: agentId, before }) });
      toast(`\u5DF2\u5220\u9664 ${r6.deleted} \u6761\u5386\u53F2`);
      await loadAll();
      loadHistory();
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  var init_history = __esm({
    "internal/web/static/src/history.js"() {
      init_core();
      init_main();
      init_task();
    }
  });

  // internal/web/static/src/skills.js
  function setSkillTab(tab) {
    const skills = tab === "skills";
    if (skills && state.skillDetail !== null) {
      hideSkillDetail();
      if (/^#\/skill\/\d+/.test(location.hash)) location.hash = "#/";
    }
    if (!skills && /^#\/skill\/\d+/.test(location.hash)) location.hash = "#/";
    if (!skills) hideSkillDetail();
    document.getElementById("segSkillLib").classList.toggle("active", skills);
    document.getElementById("segExt").classList.toggle("active", !skills);
    document.getElementById("skillShell").classList.toggle("hidden", !skills);
    document.getElementById("extShell").classList.toggle("hidden", skills);
    document.getElementById("btnAddSkill").classList.toggle("hidden", !skills);
    document.getElementById("btnAddExt").classList.toggle("hidden", skills);
    const detail = state.skillDetail !== null;
    document.getElementById("skillDisplaySeg")?.classList.toggle("hidden", !skills || detail);
    document.getElementById("skillFilterControls")?.classList.toggle("hidden", !skills || detail);
    document.getElementById("skillManageControls")?.classList.toggle("hidden", !skills || state.skillDetail !== null);
    if (!skills) loadExtensions();
  }
  function setSkillView(view) {
    state.skillView = view === "list" ? "list" : "grid";
    document.getElementById("skillDisplaySeg")?.classList.remove("hidden");
    document.getElementById("segSkillGrid")?.classList.toggle("active", state.skillView === "grid");
    document.getElementById("segSkillList")?.classList.toggle("active", state.skillView === "list");
    try {
      localStorage.setItem("paihuo.skillView", state.skillView);
    } catch (_2) {
    }
    renderSkillLib();
  }
  async function loadExtensions() {
    const raw = document.getElementById("extRaw");
    if (!raw) return;
    try {
      const d3 = await api("/api/extensions");
      raw.textContent = d3.raw || "\uFF08\u7A7A\uFF09";
      if (d3.error && d3.raw) raw.textContent = d3.raw + "\n\n[\u6267\u884C\u63D0\u793A] " + d3.error;
    } catch (e5) {
      raw.textContent = "\u52A0\u8F7D\u5931\u8D25: " + e5.message;
    }
  }
  function openExtModal() {
    document.getElementById("extSource").value = "";
    openModal("extModal");
  }
  async function submitExt() {
    const source = document.getElementById("extSource").value.trim();
    if (!source) return toast("\u9700\u8981 extension \u6765\u6E90", true);
    try {
      const d3 = await api("/api/extensions/install", { method: "POST", body: JSON.stringify({ source }) });
      closeModal("extModal");
      toast("\u5DF2\u5B89\u88C5");
      loadExtensions();
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  async function removeExt() {
    const name = prompt("\u8F93\u5165\u8981\u79FB\u9664\u7684 extension \u540D\u79F0\uFF08\u53EF\u4ECE\u4E0A\u65B9\u5217\u8868\u67E5\u770B\uFF09");
    if (!name) return;
    try {
      await api(`/api/extensions/${encodeURIComponent(name)}`, { method: "DELETE" });
      toast("\u5DF2\u79FB\u9664");
      loadExtensions();
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  async function loadSkillLib() {
    try {
      state.skillLib = await api("/api/skills");
      const known = new Set(state.skillLib.map((s5) => s5.id));
      state.skillSelected.forEach((id) => {
        if (!known.has(id)) state.skillSelected.delete(id);
      });
      syncSkillTagFilter();
    } catch (_2) {
      state.skillLib = [];
      state.skillSelected.clear();
      syncSkillTagFilter();
    }
  }
  function skillTags(skill) {
    return Array.isArray(skill?.tags) ? skill.tags.filter(Boolean).map(String) : [];
  }
  function skillTagsHTML(skill) {
    const tags = skillTags(skill);
    return tags.length ? tags.map((tag) => `<span class="skill-tag">${esc(tag)}</span>`).join("") : `<span class="skill-tag muted">\u672A\u5206\u7C7B</span>`;
  }
  function skillTagsEditorHTML(skill) {
    const inputId = `skill-tags-${skill.id}`;
    return `
    <div class="skill-tags-row">
      <div class="skill-tags" aria-label="\u5F53\u524D\u6807\u7B7E">${skillTagsHTML(skill)}</div>
      <button type="button" class="btn xs ghost skill-tags-edit" data-skill-tags-toggle="${skill.id}"
        aria-controls="skill-tag-editor-${skill.id}" aria-expanded="false"
        onclick="event.stopPropagation();toggleSkillTagsEditor(${skill.id})">\u7F16\u8F91\u6807\u7B7E</button>
    </div>
    <div class="skill-tag-editor hidden" id="skill-tag-editor-${skill.id}" onclick="event.stopPropagation()">
      <input id="${inputId}" class="skill-tags-input" value="${esc(skillTags(skill).join(", "))}"
        aria-label="\u7F16\u8F91 ${esc(skill.name)} \u7684\u6807\u7B7E" placeholder="\u6807\u7B7E\uFF0C\u7528\u9017\u53F7\u5206\u9694"
        onkeydown="if (event.key === 'Enter') { event.preventDefault(); saveSkillTagsInline(${skill.id}, this); }">
      <button type="button" class="btn xs primary" onclick="saveSkillTagsInline(${skill.id}, this)">\u4FDD\u5B58</button>
    </div>`;
  }
  function parseTagInput(raw) {
    const seen = /* @__PURE__ */ new Set();
    return String(raw || "").split(/[,，\n]/).map((tag) => tag.trim()).filter((tag) => {
      if (!tag) return false;
      const key = tag.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  function allSkillTags() {
    const tags = /* @__PURE__ */ new Map();
    state.skillLib.forEach((skill) => skillTags(skill).forEach((tag) => {
      const key = tag.toLocaleLowerCase();
      if (!tags.has(key)) tags.set(key, tag);
    }));
    return [...tags.values()].sort((a3, b3) => a3.localeCompare(b3));
  }
  function syncSkillTagFilter() {
    const select = document.getElementById("skillTagFilter");
    if (!select) return;
    const current = select.value;
    const options = [`<option value="">\u5168\u90E8\u6807\u7B7E</option>`].concat(allSkillTags().map((tag) => `<option value="${esc(tag)}">${esc(tag)}</option>`));
    if (state.skillLib.some((skill) => !skillTags(skill).length)) {
      options.push(`<option value="__untagged__">\u672A\u5206\u7C7B</option>`);
    }
    select.innerHTML = options.join("");
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  }
  function filteredSkills() {
    const query = (document.getElementById("skillSearch")?.value || "").trim().toLocaleLowerCase();
    const tag = document.getElementById("skillTagFilter")?.value || "";
    const list = state.skillLib.filter((skill) => {
      const tags = skillTags(skill);
      const matchesTag = !tag || (tag === "__untagged__" ? tags.length === 0 : tags.some((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase()));
      if (!matchesTag) return false;
      if (!query) return true;
      return [skill.name, skill.description, skill.dir, skill.source_path, ...tags].some((value) => String(value || "").toLocaleLowerCase().includes(query));
    });
    return { list, query, tag };
  }
  function skillGroupDirectory(skill) {
    const raw = String(skill.source_path || skill.dir || "").trim().replace(/[\\/]+$/, "");
    if (!raw) return "\u672A\u6307\u5B9A\u6765\u6E90\u76EE\u5F55";
    const slash = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
    if (slash < 0) return "\u6839\u76EE\u5F55";
    if (slash === 0) return raw.slice(0, 1);
    if (slash === 2 && raw[1] === ":") return raw.slice(0, 3);
    return raw.slice(0, slash) || "\u6839\u76EE\u5F55";
  }
  function skillPathName(path) {
    const raw = String(path || "").trim().replace(/[\\/]+$/, "");
    if (!raw) return "\u672A\u6307\u5B9A";
    const slash = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
    return slash >= 0 ? raw.slice(slash + 1) || raw : raw;
  }
  function skillCreatedDate(skill) {
    return String(skill.created_at || "").slice(0, 10) || "\u2014";
  }
  function skillGroups(skills = state.skillLib) {
    const groups = /* @__PURE__ */ new Map();
    skills.forEach((skill) => {
      const directory = skillGroupDirectory(skill);
      let group = groups.get(directory);
      if (!group) {
        group = { directory, skills: [] };
        groups.set(directory, group);
      }
      group.skills.push(skill);
    });
    return [...groups.values()].sort((a3, b3) => a3.directory.localeCompare(b3.directory));
  }
  function skillCardHTML(s5) {
    const selected = state.skillSelected.has(s5.id);
    const sourcePath = s5.source_path || s5.dir || "";
    const sourceName = skillPathName(sourcePath);
    const copyName = skillPathName(s5.dir);
    return `
    <article class="skill-card${selected ? " selected" : ""}" tabindex="0" aria-label="\u6253\u5F00\u6280\u80FD ${esc(s5.name)}"
      onclick="openSkillDetail(${s5.id})"
      onkeydown="if (!event.target.closest('a,button,input,select,textarea') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openSkillDetail(${s5.id}); }">
      <div class="sk-top">
        <label class="skill-select" onclick="event.stopPropagation()" title="\u9009\u62E9 ${esc(s5.name)}">
          <input type="checkbox" data-skill-id="${s5.id}" ${selected ? "checked" : ""} aria-label="\u9009\u62E9\u6280\u80FD ${esc(s5.name)}" onchange="toggleSkillSelection(${s5.id}, this.checked)">
        </label>
        <span class="avatar">${esc((s5.name || "?").slice(0, 1))}</span>
        <div class="sk-id">
          <a class="sk-name card-primary-action" href="#/skill/${s5.id}" onclick="event.stopPropagation()">${esc(s5.name)}</a>
          <div class="sk-desc">${esc(s5.description || "\u65E0\u63CF\u8FF0")}</div>
        </div>
      </div>
      <div class="sk-meta">
        ${skillTagsEditorHTML(s5)}
        <div class="skill-card-context">
          <span class="skill-card-context-item" title="${esc(sourcePath || "\u672A\u6307\u5B9A\u6765\u6E90\u8DEF\u5F84")}">
            ${icon("folder")}<span><small>\u6765\u6E90\u76EE\u5F55</small><b>${esc(sourceName)}</b></span>
          </span>
          <span class="skill-card-context-item">
            ${icon("clock")}<span><small>\u6DFB\u52A0\u65F6\u95F4</small><time>${esc(skillCreatedDate(s5))}</time></span>
          </span>
        </div>
      </div>
      <div class="sk-foot">
        <span class="skill-copy-path" title="${esc(s5.dir || "\u672A\u6307\u5B9A\u526F\u672C\u8DEF\u5F84")}">${icon("copy")}<span>\u526F\u672C</span><code>${esc(copyName)}</code></span>
        <span class="ac-ops">
          <button class="btn xs ghost" onclick="event.stopPropagation();openSkillDetail(${s5.id})">\u6253\u5F00\u8BE6\u60C5${icon("expand")}</button>
          <button class="btn xs danger" onclick="event.stopPropagation();deleteSkill(${s5.id})">${icon("trash")}\u5220\u9664</button>
        </span>
      </div>
    </article>`;
  }
  function skillListRowHTML(s5) {
    const selected = state.skillSelected.has(s5.id);
    const sourcePath = s5.source_path || s5.dir || "";
    const sourceName = skillPathName(sourcePath);
    return `<tr class="skill-list-row${selected ? " selected" : ""}" tabindex="0" aria-label="\u6253\u5F00\u6280\u80FD ${esc(s5.name)}"
    onclick="openSkillDetail(${s5.id})"
    onkeydown="if (!event.target.closest('a,button,input,select,textarea') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openSkillDetail(${s5.id}); }">
    <td class="skill-list-check" data-label="\u9009\u62E9"><label class="skill-select" onclick="event.stopPropagation()" title="\u9009\u62E9 ${esc(s5.name)}">
      <input type="checkbox" data-skill-id="${s5.id}" ${selected ? "checked" : ""} aria-label="\u9009\u62E9\u6280\u80FD ${esc(s5.name)}" onchange="toggleSkillSelection(${s5.id}, this.checked)">
    </label></td>
    <td class="skill-list-main-cell" data-label="\u6280\u80FD"><span class="skill-list-name"><span class="avatar">${esc((s5.name || "?").slice(0, 1))}</span><span><a class="table-primary-action" href="#/skill/${s5.id}" onclick="event.stopPropagation()">${esc(s5.name)}</a><small>${esc(s5.description || "\u65E0\u63CF\u8FF0")}</small></span></span></td>
    <td class="skill-list-tags-cell" data-label="\u6807\u7B7E">${skillTagsEditorHTML(s5)}</td>
    <td class="skill-list-source-cell" data-label="\u6765\u6E90\u76EE\u5F55">
      <span class="skill-list-source" title="${esc(sourcePath || "\u672A\u6307\u5B9A\u6765\u6E90\u8DEF\u5F84")}">
        <b>${esc(sourceName)}</b><code>${esc(skillGroupDirectory(s5))}</code>
      </span>
    </td>
    <td class="skill-list-date-cell num" data-label="\u6DFB\u52A0\u65F6\u95F4"><time>${esc(skillCreatedDate(s5))}</time></td>
    <td class="skill-list-actions-cell" data-label="\u64CD\u4F5C"><span class="ops"><button class="btn xs ghost" onclick="event.stopPropagation();openSkillDetail(${s5.id})">\u6253\u5F00\u8BE6\u60C5${icon("expand")}</button><button class="btn xs danger" onclick="event.stopPropagation();deleteSkill(${s5.id})">${icon("trash")}\u5220\u9664</button></span></td>
  </tr>`;
  }
  function syncSkillSelectionControls(groups = skillGroups(filteredSkills().list)) {
    const lib = state.skillLib;
    const selected = state.skillSelected;
    const selectedCount = selected.size;
    const all = lib.length > 0 && selectedCount === lib.length;
    const checkAll = document.getElementById("skillCheckAll");
    if (checkAll) {
      checkAll.checked = all;
      checkAll.indeterminate = selectedCount > 0 && !all;
    }
    document.querySelectorAll("#skillGrid input[data-skill-id]").forEach((cb) => {
      const on = selected.has(Number(cb.dataset.skillId));
      cb.checked = on;
      cb.closest(".skill-card")?.classList.toggle("selected", on);
      cb.closest("tr")?.classList.toggle("selected", on);
    });
    groups.forEach((group, i6) => {
      const groupSelected = group.skills.filter((s5) => selected.has(s5.id)).length;
      const cb = document.querySelector(`#skillGrid input[data-skill-group="${i6}"]`);
      if (!cb) return;
      cb.checked = groupSelected === group.skills.length;
      cb.indeterminate = groupSelected > 0 && groupSelected < group.skills.length;
    });
    const cnt = document.getElementById("skillSelectedCount");
    if (cnt) cnt.textContent = `\u5DF2\u9009 ${selectedCount}`;
    const del = document.getElementById("btnDeleteSkills");
    if (del) del.disabled = selectedCount === 0;
  }
  function renderSkillLib() {
    const grid = document.getElementById("skillGrid");
    if (!grid) return;
    const lib = state.skillLib;
    const { list, query, tag } = filteredSkills();
    const groups = skillGroups(list);
    grid.className = state.skillView === "list" ? "skill-list-shell" : "skill-groups";
    if (state.skillView === "list") {
      grid.innerHTML = `<div class="list-wrap skill-list-wrap"><table class="list-grid skill-list-grid" aria-label="\u6280\u80FD\u5217\u8868">
      <caption class="sr-only">\u6280\u80FD\u5217\u8868\uFF0C\u5171 ${list.length} \u4E2A\u6280\u80FD</caption>
      <thead><tr><th class="skill-list-check">\u9009\u62E9</th><th>\u6280\u80FD</th><th>\u6807\u7B7E</th><th>\u6765\u6E90\u76EE\u5F55</th><th>\u6DFB\u52A0\u65F6\u95F4</th><th class="skill-list-actions-head">\u64CD\u4F5C</th></tr></thead>
      <tbody>${list.map(skillListRowHTML).join("")}</tbody>
    </table></div>`;
    } else {
      grid.innerHTML = groups.map((group, i6) => `
      <section class="skill-group">
        <header class="skill-group-head">
          <label class="skill-group-select" title="\u9009\u62E9\u76EE\u5F55 ${esc(group.directory)}">
            <input type="checkbox" data-skill-group="${i6}" aria-label="\u9009\u62E9\u76EE\u5F55 ${esc(group.directory)}" onchange="toggleSkillGroup(${i6}, this.checked)">
          </label>
          ${icon("folder")}
          <div class="skill-group-title">
            <b>\u6765\u6E90\u76EE\u5F55</b>
            <code title="${esc(group.directory)}">${esc(group.directory)}</code>
          </div>
          <span class="count-info">${group.skills.length} \u4E2A\u6280\u80FD</span>
        </header>
        <div class="skill-group-grid">${group.skills.map(skillCardHTML).join("")}</div>
      </section>`).join("");
    }
    const empty = document.getElementById("skillEmpty");
    if (empty) {
      empty.innerHTML = lib.length === 0 ? `<b class="empty-title">\u6C89\u6DC0\u7B2C\u4E00\u4E2A\u53EF\u590D\u7528\u6280\u80FD</b>
        <span class="empty-copy">\u5BFC\u5165\u5355\u4E2A\u6280\u80FD\u76EE\u5F55\uFF0C\u6216\u626B\u63CF\u4E00\u4E2A\u76EE\u5F55\u6811\u4E2D\u7684\u5168\u90E8 skills\u3002</span>
        <button type="button" class="btn brand sm" onclick="openSkillModal()">\u6DFB\u52A0\u6280\u80FD</button>` : `<b class="empty-title">\u6CA1\u6709\u7B26\u5408\u5F53\u524D\u6761\u4EF6\u7684\u6280\u80FD</b>
        <span class="empty-copy">\u6E05\u9664\u641C\u7D22\u8BCD\u4E0E\u6807\u7B7E\u7B5B\u9009\u540E\uFF0C\u518D\u67E5\u770B\u5B8C\u6574\u6280\u80FD\u5E93\u3002</span>
        <button type="button" class="btn sm" onclick="document.getElementById('skillSearch').value='';document.getElementById('skillTagFilter').value='';renderSkillLib()">\u6E05\u9664\u7B5B\u9009</button>`;
      empty.classList.toggle("hidden", list.length > 0);
    }
    const hasLibrary = lib.length > 0;
    document.getElementById("skillDisplaySeg")?.classList.toggle("hidden", !hasLibrary);
    document.getElementById("skillFilterControls")?.classList.toggle("hidden", !hasLibrary);
    document.getElementById("skillManageControls")?.classList.toggle("hidden", !hasLibrary);
    const cnt = document.getElementById("skillCount");
    if (cnt) cnt.textContent = list.length === lib.length ? `${lib.length} \u4E2A\u6280\u80FD` : `${list.length} / ${lib.length} \u4E2A\u6280\u80FD`;
    syncSkillSelectionControls(groups);
  }
  function toggleSkillSelection(id, checked) {
    if (checked) state.skillSelected.add(id);
    else state.skillSelected.delete(id);
    syncSkillSelectionControls();
  }
  function toggleSkillGroup(groupIndex, checked) {
    const group = skillGroups(filteredSkills().list)[groupIndex];
    if (!group) return;
    group.skills.forEach((skill) => {
      if (checked) state.skillSelected.add(skill.id);
      else state.skillSelected.delete(skill.id);
    });
    syncSkillSelectionControls();
  }
  function toggleAllSkills(checked) {
    state.skillSelected.clear();
    if (checked) state.skillLib.forEach((skill) => state.skillSelected.add(skill.id));
    syncSkillSelectionControls();
  }
  async function deleteSelectedSkills() {
    const ids = [...state.skillSelected];
    if (!ids.length) return toast("\u5148\u52FE\u9009\u8981\u5220\u9664\u7684\u6280\u80FD", true);
    if (!confirm(`\u5220\u9664\u9009\u4E2D\u7684 ${ids.length} \u4E2A\u6280\u80FD\uFF1F\u5C06\u540C\u65F6\u79FB\u9664\u5DE5\u4F5C\u76EE\u5F55\u4E2D\u7684\u526F\u672C\uFF0C\u5DF2\u5F15\u7528\u5B83\u4EEC\u7684\u89D2\u8272\u914D\u7F6E\u4F1A\u5931\u6548\u3002`)) return;
    try {
      const result = await api("/api/skills", { method: "DELETE", body: JSON.stringify({ ids }) });
      if (state.skillDetail && ids.includes(state.skillDetail.id)) {
        hideSkillDetail();
        if (/^#\/skill\/\d+/.test(location.hash)) location.hash = "#/";
      }
      state.skillSelected.clear();
      await loadSkillLib();
      renderSkillLib();
      toast(`\u5DF2\u5220\u9664 ${result.count ?? ids.length} \u4E2A\u6280\u80FD`);
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  function toggleSkillTagsEditor(id) {
    const editor = document.getElementById(`skill-tag-editor-${id}`);
    if (!editor) return;
    const opening = editor.classList.contains("hidden");
    editor.classList.toggle("hidden", !opening);
    document.querySelector(`[data-skill-tags-toggle="${id}"]`)?.setAttribute("aria-expanded", String(opening));
    if (opening) {
      const input = document.getElementById(`skill-tags-${id}`);
      requestAnimationFrame(() => {
        input?.focus();
        input?.select();
      });
    }
  }
  async function persistSkillTags(id, tags) {
    const updated = await api(`/api/skills/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ tags })
    });
    const index = state.skillLib.findIndex((item) => item.id === id);
    if (index >= 0) state.skillLib[index] = { ...state.skillLib[index], ...updated };
    if (state.skillDetail?.id === id) state.skillDetail = { ...state.skillDetail, ...updated };
    syncSkillTagFilter();
    return updated;
  }
  async function saveSkillTagsInline(id, source) {
    const input = document.getElementById(`skill-tags-${id}`);
    if (!input) return;
    const editor = input.closest(".skill-tag-editor");
    const button = source?.tagName === "BUTTON" ? source : editor?.querySelector("button");
    const tags = parseTagInput(input.value);
    if (button) {
      button.disabled = true;
      button.textContent = "\u4FDD\u5B58\u4E2D\u2026";
    }
    try {
      await persistSkillTags(id, tags);
      renderSkillLib();
      toast(tags.length ? "\u6807\u7B7E\u5DF2\u4FDD\u5B58" : "\u5DF2\u6E05\u9664\u6807\u7B7E");
    } catch (e5) {
      if (button?.isConnected) {
        button.disabled = false;
        button.textContent = "\u4FDD\u5B58";
      }
      toast(e5.message, true);
    }
  }
  function formatSkillBytes(size) {
    const n6 = Number(size);
    if (!Number.isFinite(n6) || n6 < 0) return "-";
    if (n6 < 1024) return `${n6} B`;
    if (n6 < 1024 * 1024) return `${(n6 / 1024).toFixed(1)} KB`;
    return `${(n6 / (1024 * 1024)).toFixed(1)} MB`;
  }
  function skillDetailSideHTML(skill) {
    return `
    <section class="side-panel">
      <div class="side-heading">\u6280\u80FD\u4FE1\u606F</div>
      <div class="prop-row"><span class="k">\u540D\u79F0</span><span class="v" title="${esc(skill.name)}">${esc(skill.name)}</span></div>
      <div class="prop-row"><span class="k">\u6807\u7B7E</span><span class="skill-tags">${skillTagsHTML(skill)}</span></div>
      <div class="prop-row"><span class="k">\u6280\u80FD\u76EE\u5F55</span><code class="prop-mono" title="${esc(skill.dir)}">${esc(skill.dir)}</code></div>
      <div class="prop-row"><span class="k">\u6765\u6E90\u8DEF\u5F84</span><code class="prop-mono" title="${esc(skill.source_path || "-")}">${esc(skill.source_path || "-")}</code></div>
      <div class="prop-row"><span class="k">\u521B\u5EFA\u65F6\u95F4</span><span class="v">${esc((skill.created_at || "").slice(0, 16).replace("T", " ") || "-")}</span></div>
      <div class="prop-row"><span class="k">\u8BF4\u660E\u6587\u4EF6</span><span class="v">SKILL.md${skill.size_bytes !== void 0 ? ` \xB7 ${formatSkillBytes(skill.size_bytes)}` : ""}</span></div>
    </section>
    <div class="side-actions">
      <div class="side-heading">\u6807\u7B7E\u7BA1\u7406</div>
      <input id="sdTags" class="skill-tags-input" value="${esc(skillTags(skill).join(", "))}" placeholder="\u5982\uFF1A\u7F16\u7A0B, \u6587\u6863, \u4EE3\u7801\u5BA1\u67E5">
      <div class="field-help">\u591A\u4E2A\u6807\u7B7E\u7528\u9017\u53F7\u5206\u9694\uFF0C\u4FDD\u5B58\u540E\u53EF\u5728\u89D2\u8272\u521B\u5EFA\u65F6\u6309\u6807\u7B7E\u7B5B\u9009\u3002</div>
      <button class="btn sm primary" onclick="saveSkillTags()">\u4FDD\u5B58\u6807\u7B7E</button>
    </div>
    <div class="side-actions">
      <div class="side-heading">\u64CD\u4F5C</div>
      <div class="detail-actions">
        <button class="btn" onclick="copySkillContent()">${icon("copy")}\u590D\u5236 SKILL.md</button>
        <button class="btn danger" onclick="deleteSkillFromDetail()">${icon("trash")}\u5220\u9664\u6280\u80FD</button>
      </div>
    </div>`;
  }
  function renderSkillDetailShell(skill) {
    const main = document.getElementById("sdMain");
    const side = document.getElementById("sdSide");
    if (!main || !side) return;
    document.getElementById("sdCrumb").innerHTML = `\u6280\u80FD / <b>${esc(skill.name)}</b>`;
    document.getElementById("sdBadge").innerHTML = `<span class="badge" style="--st-color:var(--brand)">SKILL.md</span>`;
    main.innerHTML = `
    <section class="skill-hero">
      <span class="avatar lg skill-avatar">${esc((skill.name || "?").slice(0, 1))}</span>
      <div class="skill-hero-copy">
        <div class="detail-id">\u6280\u80FD\u8BF4\u660E \xB7 Markdown</div>
        <h2>${esc(skill.name)}</h2>
        ${skill.description ? `<div class="skill-hero-desc">${esc(skill.description)}</div>` : ""}
        <div id="sdTagsDisplay" class="skill-tags skill-hero-tags">${skillTagsHTML(skill)}</div>
      </div>
    </section>
    <div class="skill-doc-head">
      <div>
        <div class="section-title">SKILL.md</div>
        <div class="section-sub" id="sdDocMeta">\u6B63\u5728\u8BFB\u53D6\u6280\u80FD\u8BF4\u660E\u2026</div>
      </div>
      <button class="btn ghost xs" onclick="copySkillContent()">${icon("copy")}\u590D\u5236</button>
    </div>
    <pre class="skill-doc" id="sdDoc">\u52A0\u8F7D\u4E2D\u2026</pre>`;
    side.innerHTML = skillDetailSideHTML(skill);
  }
  function renderSkillDocument(detail) {
    const doc = document.getElementById("sdDoc");
    const meta = document.getElementById("sdDocMeta");
    if (!doc || !meta) return;
    const content = String(detail.content || "");
    doc.textContent = content || "\uFF08SKILL.md \u4E3A\u7A7A\uFF09";
    doc.classList.toggle("is-empty", !content);
    meta.textContent = content ? `${formatSkillBytes(detail.size_bytes ?? content.length)} \xB7 ${content.split("\n").length} \u884C` : "\u7A7A\u6587\u4EF6";
    const side = document.getElementById("sdSide");
    if (side) side.innerHTML = skillDetailSideHTML(detail);
  }
  function openSkillDetail(id) {
    location.hash = "#/skill/" + id;
  }
  function closeSkillDetail() {
    location.hash = "#/";
  }
  function hideSkillDetail() {
    document.getElementById("skillDetailShell")?.classList.add("hidden");
    document.getElementById("skillShell")?.classList.remove("hidden");
    state.skillDetail = null;
    document.getElementById("skillDisplaySeg")?.classList.remove("hidden");
    document.getElementById("skillFilterControls")?.classList.remove("hidden");
    document.getElementById("skillManageControls")?.classList.remove("hidden");
  }
  async function showSkillDetail(id) {
    let skill = state.skillLib.find((x2) => x2.id === id);
    if (!skill) {
      await loadSkillLib();
      renderSkillLib();
      skill = state.skillLib.find((x2) => x2.id === id);
    }
    if (!skill) {
      toast("\u6280\u80FD\u4E0D\u5B58\u5728\u6216\u5DF2\u88AB\u5220\u9664", true);
      return;
    }
    state.skillDetail = skill;
    document.getElementById("skillShell")?.classList.add("hidden");
    document.getElementById("skillDetailShell")?.classList.remove("hidden");
    document.getElementById("skillDisplaySeg")?.classList.add("hidden");
    document.getElementById("skillFilterControls")?.classList.add("hidden");
    document.getElementById("skillManageControls")?.classList.add("hidden");
    renderSkillDetailShell(skill);
    try {
      const detail = await api(`/api/skills/${id}`);
      if (state.skillDetail?.id !== id) return;
      state.skillDetail = detail;
      renderSkillDocument(detail);
    } catch (e5) {
      if (state.skillDetail?.id !== id) return;
      const doc = document.getElementById("sdDoc");
      const meta = document.getElementById("sdDocMeta");
      if (doc) {
        doc.textContent = `\u8BFB\u53D6\u5931\u8D25\uFF1A${e5.message}`;
        doc.classList.add("is-error");
      }
      if (meta) meta.textContent = "\u65E0\u6CD5\u8BFB\u53D6 SKILL.md";
    }
  }
  async function copySkillContent() {
    const content = state.skillDetail?.content;
    if (content === void 0) return toast("\u6280\u80FD\u8BF4\u660E\u8FD8\u5728\u52A0\u8F7D\u4E2D", true);
    try {
      await navigator.clipboard.writeText(content);
      toast("\u5DF2\u590D\u5236 SKILL.md");
    } catch (_2) {
      toast("\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u9009\u62E9\u5185\u5BB9", true);
    }
  }
  async function saveSkillTags() {
    const skill = state.skillDetail;
    if (!skill) return;
    const input = document.getElementById("sdTags");
    const tags = parseTagInput(input?.value || "");
    try {
      await persistSkillTags(skill.id, tags);
      const side = document.getElementById("sdSide");
      if (side) side.innerHTML = skillDetailSideHTML(state.skillDetail);
      const display = document.getElementById("sdTagsDisplay");
      if (display) display.innerHTML = skillTagsHTML(state.skillDetail);
      toast(tags.length ? "\u6807\u7B7E\u5DF2\u4FDD\u5B58" : "\u5DF2\u6E05\u9664\u6807\u7B7E");
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  function deleteSkillFromDetail() {
    const id = state.skillDetail?.id;
    if (id !== void 0) deleteSkill(id);
  }
  function openSkillModal() {
    document.getElementById("sSkillPath").value = "";
    document.getElementById("sSkillTags").value = "";
    loadProjDatalist();
    openModal("skillModal");
  }
  async function submitSkill() {
    const path = document.getElementById("sSkillPath").value.trim();
    if (!path) return toast("\u9700\u8981\u6280\u80FD\u76EE\u5F55\u8DEF\u5F84", true);
    const tags = parseTagInput(document.getElementById("sSkillTags")?.value || "");
    try {
      const sk = await api("/api/skills", { method: "POST", body: JSON.stringify({ source_path: path, tags }) });
      closeModal("skillModal");
      toast(`\u5DF2\u5BFC\u5165 skill: ${sk.name}`);
      await loadSkillLib();
      renderSkillLib();
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  async function scanSkills() {
    const path = document.getElementById("sSkillPath").value.trim();
    if (!path) return toast("\u9700\u8981\u626B\u63CF\u6839\u76EE\u5F55\u8DEF\u5F84", true);
    const tags = parseTagInput(document.getElementById("sSkillTags")?.value || "");
    try {
      const result = await api("/api/skills/scan", { method: "POST", body: JSON.stringify({ source_path: path, tags }) });
      closeModal("skillModal");
      const imported = (result.imported || []).length;
      const skipped = (result.skipped || []).length;
      const failed = (result.errors || []).length;
      let summary = `\u53D1\u73B0 ${result.found || 0} \u4E2A skill\uFF0C\u5DF2\u5BFC\u5165 ${imported} \u4E2A`;
      if (skipped) summary += `\uFF0C\u8DF3\u8FC7\u5DF2\u5BFC\u5165 ${skipped} \u4E2A`;
      if (failed) summary += `\uFF0C\u5931\u8D25 ${failed} \u4E2A`;
      toast(summary, failed > 0);
      await loadSkillLib();
      renderSkillLib();
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  async function deleteSkill(id) {
    const s5 = state.skillLib.find((x2) => x2.id === id);
    if (!confirm(`\u5220\u9664 skill\u300C${s5 ? s5.name : id}\u300D\uFF1F\u5C06\u540C\u65F6\u79FB\u9664\u5DE5\u4F5C\u76EE\u5F55\u4E2D\u7684\u526F\u672C\uFF0C\u5DF2\u5F15\u7528\u5B83\u7684\u89D2\u8272\u914D\u7F6E\u4F1A\u5931\u6548\u3002`)) return;
    try {
      await api(`/api/skills/${id}`, { method: "DELETE" });
      toast("\u5DF2\u5220\u9664");
      state.skillSelected.delete(id);
      await loadSkillLib();
      renderSkillLib();
      if (state.skillDetail?.id === id) {
        hideSkillDetail();
        if (/^#\/skill\/\d+/.test(location.hash)) location.hash = "#/";
      }
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  async function loadTemplates() {
    try {
      state.templates = await api("/api/templates");
    } catch (_2) {
      return;
    }
    const sel = document.getElementById("tTemplate");
    if (sel) sel.innerHTML = `<option value="">\u2014</option>` + state.templates.map((t5) => `<option value="${t5.id}">${esc(t5.name)}</option>`).join("");
    renderTemplateList();
  }
  function renderTemplateList() {
    const body = document.getElementById("templateList");
    if (!body) return;
    body.innerHTML = state.templates.map((t5) => `
    <tr>
      <td><b>${esc(t5.name)}</b></td>
      <td style="font-size:12px;color:var(--fg-muted);max-width:480px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc((t5.body || "").slice(0, 90))}</td>
      <td>${esc(t5.agent_name || "-")}</td>
      <td class="num">${(t5.created_at || "").slice(0, 16).replace("T", " ")}</td>
      <td><button class="btn xs danger" onclick="deleteTemplate(${t5.id})">${icon("trash")}\u5220\u9664</button></td>
    </tr>`).join("");
    const empty = document.getElementById("templateEmpty");
    if (empty) empty.classList.toggle("hidden", state.templates.length > 0);
  }
  async function deleteTemplate(id) {
    if (!confirm("\u5220\u9664\u8BE5\u6A21\u677F\uFF1F")) return;
    try {
      await api(`/api/templates/${id}`, { method: "DELETE" });
      await loadTemplates();
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  var init_skills = __esm({
    "internal/web/static/src/skills.js"() {
      init_core();
      init_projects();
    }
  });

  // internal/web/static/src/terminal.js
  function terminalFontFamily() {
    return getComputedStyle(document.documentElement).getPropertyValue("--font-terminal").trim() || TERMINAL_FONT_FALLBACK;
  }
  function terminalOptions(interactive = false, running = false, size = null) {
    return {
      ...interactive ? { cols: size?.cols ?? INTERACTIVE_TERM_COLS, rows: size?.rows ?? INTERACTIVE_TERM_ROWS } : {},
      // OMP and other TUIs use Nerd Fonts private-use glyphs. Keep the normal
      // monospace stack for text and use the bundled Symbols font as fallback.
      fontFamily: terminalFontFamily(),
      fontSize: 12.5,
      lineHeight: 1.35,
      convertEol: true,
      scrollback: interactive ? 3e3 : 1e4,
      cursorBlink: interactive && running,
      disableStdin: !(interactive && running),
      theme: TERM_THEME
    };
  }
  function interactiveTaskRunning(taskID) {
    const task = state.tasks.find((t5) => t5.id === taskID);
    return task?.run_mode === "interactive" && task?.status === "running";
  }
  function reportTerminalGeometry(taskID, cols, rows) {
    if (!taskID || !cols || !rows) return;
    clearTimeout(geometryReportTimer);
    geometryReportTimer = setTimeout(() => {
      api(`/api/tasks/${taskID}/resize`, {
        method: "POST",
        body: JSON.stringify({ cols, rows })
      }).catch(() => {
      });
    }, 150);
  }
  async function flushTerminalKeystrokes(taskID, queue) {
    queue.sending = true;
    try {
      while (queue.pending) {
        let end = Math.min(queue.pending.length, 4096);
        if (end < queue.pending.length && /[\uD800-\uDBFF]/.test(queue.pending[end - 1])) end--;
        const keys = queue.pending.slice(0, end);
        queue.pending = queue.pending.slice(end);
        try {
          await api(`/api/tasks/${taskID}/input`, {
            method: "POST",
            body: JSON.stringify({ keys })
          });
        } catch (e5) {
          queue.pending = "";
          if (interactiveTaskRunning(taskID)) toast(`\u7EC8\u7AEF\u8F93\u5165\u53D1\u9001\u5931\u8D25\uFF1A${e5.message}`, true);
          break;
        }
      }
    } finally {
      queue.sending = false;
      if (!queue.pending && terminalKeyQueues.get(taskID) === queue) terminalKeyQueues.delete(taskID);
    }
  }
  function queueTerminalKeystrokes(taskID, keys) {
    if (!keys || !interactiveTaskRunning(taskID)) return;
    let queue = terminalKeyQueues.get(taskID);
    if (!queue) {
      queue = { pending: "", sending: false };
      terminalKeyQueues.set(taskID, queue);
    }
    queue.pending += keys;
    if (!queue.sending) void flushTerminalKeystrokes(taskID, queue);
  }
  function configureTerminalInput(target, enabled) {
    if (!target) return;
    target.options.disableStdin = !enabled;
    target.options.cursorBlink = enabled;
    target.element?.classList.toggle("terminal-writable", enabled);
    if (target.textarea) {
      target.textarea.setAttribute("aria-label", enabled ? "Agent \u4EA4\u4E92\u5F0F\u7EC8\u7AEF\u8F93\u5165" : "\u53EA\u8BFB\u7EC8\u7AEF\u8F93\u51FA");
      target.textarea.setAttribute("aria-disabled", String(!enabled));
    }
    if (!enabled) target.blur();
  }
  function terminalRenderableLog(l3) {
    return l3?.stream === "term" || l3?.stream === "out" || !l3?.stream;
  }
  function writeTerminalLog(target, l3, callback) {
    if (!target || !terminalRenderableLog(l3)) return;
    const content = String(l3.content ?? "");
    target.write(l3.stream === "term" ? content : content + "\r\n", callback);
  }
  function writeTerminalLogs(target, logs, emptyMessage = "\uFF08\u6682\u65E0\u8F93\u51FA\uFF09") {
    if (!target) return;
    const renderable = logs.filter(terminalRenderableLog);
    if (!renderable.length) {
      target.write(`\x1B[90m${emptyMessage}\x1B[0m\r
`);
      return;
    }
    renderable.forEach((l3, index) => {
      writeTerminalLog(target, l3, index === renderable.length - 1 ? () => target.scrollToBottom() : void 0);
    });
  }
  function scaleTerminalToContainer(term2, host) {
    const el = term2?.element;
    if (!el || !host) return;
    const rowsEl = el.querySelector(".xterm-rows");
    const natW = rowsEl?.offsetWidth || el.offsetWidth;
    const natH = rowsEl?.offsetHeight || el.offsetHeight;
    const style = getComputedStyle(el);
    const px = (value) => Number.parseFloat(value) || 0;
    const padW = px(style.paddingLeft) + px(style.paddingRight) + el.offsetWidth - el.clientWidth;
    const padH = px(style.paddingTop) + px(style.paddingBottom) + el.offsetHeight - el.clientHeight;
    const cw = host.clientWidth, ch = host.clientHeight;
    if (!natW || !natH || !cw || !ch) return;
    const visW = natW + padW, visH = natH + padH;
    const s5 = Math.min(cw / visW, ch / visH);
    el.style.transformOrigin = "0 0";
    el.style.transform = `scale(${s5}) translate(${(cw - visW * s5) / 2 / s5}px, ${(ch - visH * s5) / 2 / s5}px)`;
  }
  function scaleTaskTerminalToContainer() {
    const host = document.getElementById("taskTermX");
    if (!taskTerm || !host) return;
    scaleTerminalToContainer(taskTerm, host);
  }
  function scheduleRepeatedScale(fn) {
    for (const ms of [80, 250, 600]) setTimeout(fn, ms);
  }
  function syncFullscreenTerminalGeometry() {
    if (!term) return;
    const host = document.getElementById("termX");
    if (!host || host.clientWidth <= 0 || host.clientHeight <= 0) return;
    try {
      if (termMode === "replay") {
        scaleTerminalToContainer(term, host);
        return;
      }
      termFit?.fit();
      if (termMode === "live" && state.termTask) {
        reportTerminalGeometry(state.termTask, term.cols, term.rows);
      }
    } catch (_2) {
    }
  }
  function observeFullscreenTerminalGeometry() {
    const host = document.getElementById("termX");
    if (!host || termGeometryObserver) return;
    termGeometryObserver = new ResizeObserver(() => {
      requestAnimationFrame(syncFullscreenTerminalGeometry);
    });
    termGeometryObserver.observe(host);
    termViewportResizeHandler = () => requestAnimationFrame(syncFullscreenTerminalGeometry);
    window.addEventListener("resize", termViewportResizeHandler, { passive: true });
    window.visualViewport?.addEventListener("resize", termViewportResizeHandler, { passive: true });
  }
  function initTerm() {
    if (term) return;
    term = new Terminal(terminalOptions(termInteractive, false));
    termFit = new FitAddon.FitAddon();
    term.loadAddon(termFit);
    term.open(document.getElementById("termX"));
    term.onData((keys) => {
      if (state.termTask && termInteractive) queueTerminalKeystrokes(state.termTask, keys);
    });
    term.onScroll((event) => {
      if (event.position === 0 && !ignoreTopScroll) loadOlderTerminalLogs();
    });
    observeFullscreenTerminalGeometry();
    syncFullscreenTerminalGeometry();
  }
  function termAppendLog(l3) {
    if (state.termTask !== l3.task_id || !term) return;
    if (!terminalRenderableLog(l3)) return;
    if (termLogs.some((existing) => existing.id === l3.id)) return;
    termLogs.push(l3);
    writeTerminalLog(term, l3, () => term?.scrollToBottom());
  }
  function renderTerminalWindow() {
    if (!term) return;
    syncFullscreenTerminalGeometry();
    term.reset();
    writeTerminalLogs(term, termLogs);
  }
  async function loadOlderTerminalLogs() {
    if (!state.termTask || !termHasMore || termLoading || !termOldestSeq) return;
    const id = state.termTask;
    termLoading = true;
    try {
      const page = await fetchTaskLogs(id, { before: termOldestSeq, limit: 200 });
      if (state.termTask !== id) return;
      const existing = new Set(termLogs.map((l3) => l3.id));
      const older = page.logs.filter((l3) => terminalRenderableLog(l3) && !existing.has(l3.id));
      if (!older.length) {
        termHasMore = false;
        return;
      }
      termLogs = [...older, ...termLogs];
      termHasMore = page.has_more;
      termOldestSeq = termLogs[0]?.seq || 0;
      ignoreTopScroll = true;
      const previousRows = term.buffer.active.length;
      renderTerminalWindow();
      term.scrollToTop();
      term.scrollLines(Math.max(1, term.buffer.active.length - previousRows));
      setTimeout(() => {
        ignoreTopScroll = false;
      }, 0);
    } catch (_2) {
    } finally {
      termLoading = false;
    }
  }
  function openTerminal(id) {
    const t5 = state.tasks.find((x2) => x2.id === id) || {};
    termInteractive = t5.run_mode === "interactive";
    termMode = termInteractive ? t5.status === "running" ? "live" : "replay" : "logs";
    document.getElementById("termTitle").textContent = `${t5.agent_name || ""} \xB7 #${id} \u5BF9\u8BDD`;
    document.getElementById("termModal")?.classList.toggle("interactive-terminal-modal", termInteractive);
    document.getElementById("termX")?.classList.toggle("interactive-term-body", termInteractive);
    document.getElementById("termX")?.classList.toggle("interactive-term-replay", termMode === "replay");
    openModal("termModal");
    initTerm();
    if (termMode === "replay") {
      term.resize(t5.terminal_cols || INTERACTIVE_TERM_COLS, t5.terminal_rows || INTERACTIVE_TERM_ROWS);
      scheduleRepeatedScale(() => syncFullscreenTerminalGeometry());
    }
    setTimeout(syncFullscreenTerminalGeometry, 30);
    state.termTask = id;
    termLogs = [];
    termHasMore = false;
    termOldestSeq = 0;
    termLoading = false;
    ignoreTopScroll = true;
    term.reset();
    term.write("\x1B[90m# loading latest logs...\x1B[0m\r\n");
    syncTerminalInput(t5);
    fetchTaskLogs(id, { limit: 200 }).then((page) => {
      if (state.termTask !== id) return;
      const byID = new Map(page.logs.filter(terminalRenderableLog).map((l3) => [l3.id, l3]));
      for (const l3 of termLogs) if (!byID.has(l3.id)) byID.set(l3.id, l3);
      termLogs = [...byID.values()].sort((a3, b3) => a3.seq - b3.seq);
      termHasMore = page.has_more;
      termOldestSeq = termLogs[0]?.seq || 0;
      renderTerminalWindow();
      term.scrollToBottom();
      setTimeout(() => {
        ignoreTopScroll = false;
      }, 0);
    }).catch(() => {
      term.write("\x1B[31m\u65E5\u5FD7\u52A0\u8F7D\u5931\u8D25\x1B[0m\r\n");
    });
  }
  function closeTerminal() {
    clearTimeout(geometryReportTimer);
    configureTerminalInput(term, false);
    state.termTask = null;
    termLogs = [];
    termHasMore = false;
    termOldestSeq = 0;
    const bar = document.getElementById("termInputBar");
    if (bar) bar.classList.add("hidden");
    closeModal("termModal");
    document.getElementById("termModal")?.classList.remove("interactive-terminal-modal");
    document.getElementById("termX")?.classList.remove("interactive-term-body", "interactive-term-replay");
    termInteractive = false;
    termMode = "logs";
    requestAnimationFrame(syncTaskTerminalGeometry);
  }
  function syncTaskTerminalGeometry() {
    const host = document.getElementById("taskTermX");
    if (!taskTerm || !host || host.clientWidth <= 0 || host.clientHeight <= 0) return;
    if (taskTermMode === "replay") {
      scaleTaskTerminalToContainer();
      return;
    }
    if (!taskTermFit) return;
    try {
      taskTermFit.fit();
    } catch (_2) {
      return;
    }
    const modal = document.getElementById("termModal");
    if (termMode === "live" && state.termTask === taskTermTask && modal && !modal.classList.contains("hidden")) return;
    reportTerminalGeometry(taskTermTask, taskTerm.cols, taskTerm.rows);
  }
  function observeTaskTerminalGeometry() {
    const host = document.getElementById("taskTermX");
    if (!host || taskTermResizeObserver) return;
    taskTermResizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(syncTaskTerminalGeometry);
    });
    taskTermResizeObserver.observe(host);
  }
  function closeTaskTerminal() {
    const old = taskTerm;
    taskTermResizeObserver?.disconnect();
    taskTermResizeObserver = null;
    taskTermFit = null;
    taskTerm = null;
    taskTermTask = null;
    taskTermLogs = [];
    taskTermMode = "logs";
    document.getElementById("logBox")?.classList.remove("interactive-term-replay");
    if (old) setTimeout(() => {
      try {
        old.dispose();
      } catch (_2) {
      }
    }, 0);
  }
  function openTaskTerminal(id, logs = [], running = false) {
    const host = document.getElementById("taskTermX");
    if (!host) return;
    const t5 = state.tasks.find((x2) => x2.id === id) || {};
    closeTaskTerminal();
    taskTermTask = id;
    taskTermLogs = logs.filter(terminalRenderableLog);
    taskTermMode = running ? "live" : "replay";
    taskTerm = new Terminal(terminalOptions(true, running, running ? null : {
      cols: t5.terminal_cols || INTERACTIVE_TERM_COLS,
      rows: t5.terminal_rows || INTERACTIVE_TERM_ROWS
    }));
    taskTerm.open(host);
    if (running) {
      taskTermFit = new FitAddon.FitAddon();
      taskTerm.loadAddon(taskTermFit);
      taskTermFit.fit();
      reportTerminalGeometry(id, taskTerm.cols, taskTerm.rows);
    }
    taskTerm.onData((keys) => queueTerminalKeystrokes(id, keys));
    configureTerminalInput(taskTerm, running);
    observeTaskTerminalGeometry();
    document.getElementById("logBox")?.classList.toggle("interactive-term-replay", !running);
    if (!running) {
      scaleTaskTerminalToContainer();
      scheduleRepeatedScale(scaleTaskTerminalToContainer);
    }
    writeTerminalLogs(taskTerm, taskTermLogs, "\uFF08\u4EA4\u4E92\u7EC8\u7AEF\u7B49\u5F85\u8F93\u51FA\uFF09");
  }
  function focusTaskTerminal() {
    taskTerm?.focus();
  }
  function taskTermAppendLog(l3) {
    if (!taskTerm || taskTermTask !== l3.task_id) return;
    if (!terminalRenderableLog(l3)) return;
    if (taskTermLogs.some((existing) => existing.id === l3.id)) return;
    taskTermLogs.push(l3);
    writeTerminalLog(taskTerm, l3, () => taskTerm?.scrollToBottom());
  }
  function taskTerminalText() {
    if (!taskTerm) return "";
    const buffer = taskTerm.buffer.active;
    const start = buffer.viewportY;
    const end = Math.min(buffer.length, start + taskTerm.rows);
    const lines = [];
    for (let row = start; row < end; row++) {
      lines.push(buffer.getLine(row)?.translateToString(true) || "");
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.join("\n");
  }
  function syncTerminalInput(t5) {
    const bar = document.getElementById("termInputBar");
    const enabled = t5?.run_mode === "interactive" && t5?.status === "running";
    bar?.classList.toggle("hidden", !enabled);
    configureTerminalInput(term, enabled);
    if (t5) {
      const agent = state.agents.find((a3) => a3.id === t5.agent_id);
      const exitCmd = agent?.cli === "pi" ? "/quit" : "/exit";
      const help = document.getElementById("termInputHelp");
      if (help) help.innerHTML = `\u70B9\u51FB\u7EC8\u7AEF\u76F4\u63A5\u8F93\u5165 \xB7 Tab / \u2191 / \u2193 \u7531\u5F53\u524D CLI \u5904\u7406 \xB7 <code>${exitCmd}</code> \u7ED3\u675F`;
    }
  }
  function focusFullscreenTerminal() {
    term?.focus();
  }
  var term, termFit, termLogs, termHasMore, termOldestSeq, termLoading, ignoreTopScroll, termInteractive, termGeometryObserver, termViewportResizeHandler, termMode, taskTerm, taskTermTask, taskTermLogs, taskTermMode, terminalKeyQueues, INTERACTIVE_TERM_COLS, INTERACTIVE_TERM_ROWS, TERM_THEME, TERMINAL_FONT_FALLBACK, geometryReportTimer, taskTermFit, taskTermResizeObserver;
  var init_terminal = __esm({
    "internal/web/static/src/terminal.js"() {
      init_core();
      term = null;
      termFit = null;
      termLogs = [];
      termHasMore = false;
      termOldestSeq = 0;
      termLoading = false;
      ignoreTopScroll = false;
      termInteractive = false;
      termGeometryObserver = null;
      termViewportResizeHandler = null;
      termMode = "logs";
      taskTerm = null;
      taskTermTask = null;
      taskTermLogs = [];
      taskTermMode = "logs";
      terminalKeyQueues = /* @__PURE__ */ new Map();
      INTERACTIVE_TERM_COLS = 80;
      INTERACTIVE_TERM_ROWS = 24;
      TERM_THEME = {
        background: "#070a08",
        foreground: "#c9d4e5",
        cursor: "#c7f36a",
        selectionBackground: "rgba(199, 243, 106, .24)",
        black: "#0b1019",
        red: "#f87171",
        green: "#34d399",
        yellow: "#fbbf24",
        blue: "#38bdf8",
        magenta: "#a78bfa",
        cyan: "#22d3ee",
        white: "#c9d4e5",
        brightBlack: "#5d6b84",
        brightRed: "#fca5a5",
        brightGreen: "#6ee7b7",
        brightYellow: "#fde047",
        brightBlue: "#7dd3fc",
        brightMagenta: "#c4b5fd",
        brightCyan: "#67e8f9",
        brightWhite: "#f1f5f9"
      };
      TERMINAL_FONT_FALLBACK = '"Geist Mono", "JetBrains Mono", "Cascadia Code", ui-monospace, Consolas, monospace, "Symbols Nerd Font Mono"';
      geometryReportTimer = null;
      taskTermFit = null;
      taskTermResizeObserver = null;
    }
  });

  // internal/web/static/src/task.js
  function currentFilters() {
    return {
      agent: Number(document.getElementById("fAgent")?.value) || null,
      project: Number(document.getElementById("fProject")?.value) || null,
      status: document.getElementById("fStatus")?.value || ""
    };
  }
  function filteredTasks() {
    const f4 = currentFilters();
    return state.tasks.filter((t5) => {
      if (f4.agent && t5.agent_id !== f4.agent) return false;
      if (f4.project && t5.project_id !== f4.project) return false;
      if (f4.status && t5.status !== f4.status) return false;
      return true;
    });
  }
  function isMergeTask(t5) {
    return t5?.merge_of !== null && t5?.merge_of !== void 0;
  }
  function mergeTaskFor(source) {
    if (!source || isMergeTask(source)) return null;
    return state.tasks.find((t5) => isMergeTask(t5) && t5.merge_of === source.id) || null;
  }
  function mergeBlockReason(t5) {
    if (!isMergeTask(t5) || t5.status !== "queued") return "";
    if (!t5.agent_id) return "\u672A\u6307\u6D3E\u89D2\u8272";
    const agent = state.agents.find((a3) => a3.id === t5.agent_id);
    if (!agent) return "\u89D2\u8272\u4E0D\u53EF\u7528";
    return agent.enabled ? "" : "\u89D2\u8272\u5DF2\u505C\u7528";
  }
  function taskKindChip(t5) {
    return isMergeTask(t5) ? `<span class="chip merge" title="\u7531\u6E90\u4EFB\u52A1 #${t5.merge_of} \u81EA\u52A8\u521B\u5EFA">\u4EE3\u7801\u5408\u5E76 \xB7 #${t5.merge_of}</span>` : `<span class="chip task-kind">\u5B9E\u73B0</span>`;
  }
  function sourceMergeChip(t5) {
    if (isMergeTask(t5)) return "";
    const merge = mergeTaskFor(t5);
    if (!merge) {
      return t5.status === "succeeded" && t5.worktree_branch ? `<span class="chip merge-pending">\u6B63\u5728\u521B\u5EFA\u5408\u5E76</span>` : "";
    }
    return `<span class="chip merge-state ${merge.status}" title="\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1 #${merge.id}">\u5408\u5E76\uFF1A${STATUS_LABEL[merge.status] || merge.status}</span>`;
  }
  function sourceDeliveryInfo(source) {
    if (!source) return { state: "missing", reason: "\u524D\u7F6E\u4EFB\u52A1\u5DF2\u4E0D\u5B58\u5728" };
    if (isMergeTask(source)) return { state: "failed", reason: `\u4EFB\u52A1 #${source.id} \u662F\u5408\u5E76\u4EFB\u52A1\uFF0C\u4E0D\u80FD\u4F5C\u4E3A\u524D\u7F6E` };
    switch (source.status) {
      case "queued":
      case "claimed":
      case "running":
        return { state: "pending", reason: `\u4EFB\u52A1 #${source.id} \u6B63\u5728\u6267\u884C` };
      case "awaiting_review":
        return { state: "pending", reason: `\u4EFB\u52A1 #${source.id} \u7B49\u5F85\u5BA1\u6279` };
      case "failed":
        return { state: "failed", reason: `\u4EFB\u52A1 #${source.id} \u6267\u884C\u5931\u8D25` };
      case "cancelled":
        return { state: "failed", reason: `\u4EFB\u52A1 #${source.id} \u5DF2\u53D6\u6D88` };
      case "succeeded": {
        const merge = mergeTaskFor(source);
        if (!merge) {
          return source.worktree_branch ? { state: "pending", reason: `\u4EFB\u52A1 #${source.id} \u6B63\u5728\u521B\u5EFA\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1` } : { state: "succeeded", reason: `\u4EFB\u52A1 #${source.id} \u5DF2\u5B8C\u6210` };
        }
        if (merge.status === "succeeded") return { state: "succeeded", reason: `\u5408\u5E76\u4EFB\u52A1 #${merge.id} \u5DF2\u5B8C\u6210` };
        if (merge.status === "failed") return { state: "failed", reason: `\u5408\u5E76\u4EFB\u52A1 #${merge.id} \u5931\u8D25` };
        if (merge.status === "cancelled") return { state: "failed", reason: `\u5408\u5E76\u4EFB\u52A1 #${merge.id} \u5DF2\u53D6\u6D88` };
        return { state: "pending", reason: `\u5408\u5E76\u4EFB\u52A1 #${merge.id} \u6B63\u5728\u5904\u7406` };
      }
      default:
        return { state: "pending", reason: `\u4EFB\u52A1 #${source.id} \u72B6\u6001\u672A\u77E5` };
    }
  }
  function dependencyInfo(t5) {
    if (isMergeTask(t5)) return { mode: "system", state: "ready", label: "\u7CFB\u7EDF\u5408\u5E76" };
    const mode = t5.dependency_mode || "none";
    if (mode === "none") return { mode, state: "ready", label: "\u72EC\u7ACB\u4EFB\u52A1", reason: "\u4E0D\u7B49\u5F85\u9879\u76EE\u4E2D\u7684\u5176\u4ED6\u4EA4\u4ED8" };
    if (mode === "weak" && !t5.depends_on) {
      return { mode, state: "ready", label: "\u81EA\u52A8\u987A\u5E8F \xB7 \u9996\u9879", reason: "\u5F53\u524D\u9879\u76EE\u6267\u884C\u987A\u5E8F\u4E2D\u7684\u7B2C\u4E00\u9879" };
    }
    const source = state.tasks.find((x2) => x2.id === t5.depends_on);
    const prefix = mode === "strong" ? "\u5F3A\u4F9D\u8D56" : "\u81EA\u52A8\u987A\u5E8F";
    const label = `${prefix} \xB7 #${t5.depends_on || "?"}`;
    if (!source) {
      if (mode === "weak") return { mode, state: "skipped", label, reason: `\u524D\u5E8F\u4EFB\u52A1 #${t5.depends_on} \u5DF2\u5220\u9664\uFF0C\u5DF2\u8DF3\u8FC7`, stateLabel: "\u524D\u5E8F\u5DF2\u8DF3\u8FC7" };
      return { mode, state: "blocked", label, reason: `\u660E\u786E\u4F9D\u8D56\u7684\u4EFB\u52A1 #${t5.depends_on} \u5DF2\u5220\u9664`, stateLabel: "\u524D\u5E8F\u4E0D\u5B58\u5728" };
    }
    const delivery = sourceDeliveryInfo(source);
    if (mode === "strong") {
      if (delivery.state === "succeeded") return { mode, state: "ready", label, reason: delivery.reason };
      return { mode, state: "blocked", label, reason: `\u660E\u786E\u4F9D\u8D56\u672A\u6210\u529F\uFF1A${delivery.reason}`, stateLabel: `\u7B49\u5F85 #${source.id}` };
    }
    if (delivery.state === "succeeded") return { mode, state: "ready", label, reason: delivery.reason };
    if (delivery.state === "failed" || delivery.state === "missing") {
      if (!source.block_on_failure) {
        return { mode, state: "skipped", label, reason: `\u524D\u5E8F\u5931\u8D25\uFF0C\u5DF2\u8DF3\u8FC7\uFF1A${delivery.reason}`, stateLabel: `#${source.id} \u5931\u8D25\u5DF2\u8DF3\u8FC7` };
      }
      return { mode, state: "blocked", label, reason: `\u524D\u5E8F\u963B\u585E\u4EFB\u52A1\u672A\u5B8C\u6210\uFF1A${delivery.reason}`, stateLabel: `#${source.id} \u5931\u8D25\u963B\u585E` };
    }
    return { mode, state: "blocked", label, reason: `\u7B49\u5F85\u524D\u5E8F\u4EA4\u4ED8\uFF1A${delivery.reason}`, stateLabel: `\u7B49\u5F85 #${source.id}` };
  }
  function dependencyChip(t5) {
    const info = dependencyInfo(t5);
    if (info.mode === "system") return "";
    const kind = info.mode === "strong" ? "strong" : info.mode === "weak" ? "weak" : "none";
    return `<span class="chip dependency ${kind}" title="${esc(info.reason || info.label)}">${esc(info.label)}</span>`;
  }
  function dependencyStateChip(t5) {
    if (t5.status !== "queued") return "";
    const info = dependencyInfo(t5);
    if (info.state === "blocked") return `<span class="chip dependency blocked" title="${esc(info.reason)}">${esc(info.stateLabel || "\u7B49\u5F85\u524D\u5E8F")}</span>`;
    if (info.state === "skipped") return `<span class="chip dependency skipped" title="${esc(info.reason)}">${esc(info.stateLabel || "\u524D\u5E8F\u5DF2\u8DF3\u8FC7")}</span>`;
    return "";
  }
  function boardColumnsHTML(tasks, mergeSection) {
    const columns = mergeSection ? [...BOARD_COLS, ["merge-attention", "\u9700\u5904\u7406", ["failed", "cancelled"]]] : BOARD_COLS;
    return columns.map(([key, label, statuses]) => {
      const items = tasks.filter((t5) => statuses.includes(t5.status));
      return `<div class="board-col" style="--st-color:${ST_COLOR[statuses[0]]}">
      <div class="board-col-head">
        <span class="st-dot"></span><span>${label}</span>
        <span class="count">${items.length}</span>
      </div>
      <div class="board-col-body">
        ${items.map(cardHTML).join("") || `<div class="empty">\u2014</div>`}
      </div>
    </div>`;
    }).join("");
  }
  function boardSectionHTML(kind, title, note, tasks) {
    const blocked = tasks.filter((t5) => mergeBlockReason(t5)).length;
    const empty = kind === "merge" ? "\u8FD8\u6CA1\u6709\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1\uFF1B\u5B9E\u73B0\u4EFB\u52A1\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u51FA\u73B0\u5728\u8FD9\u91CC\u3002" : "\u6CA1\u6709\u7B26\u5408\u6761\u4EF6\u7684\u5B9E\u73B0\u4EFB\u52A1\u3002";
    return `<section class="board-section ${kind === "merge" ? "merge-section" : "source-section"}">
    <div class="board-section-head">
      <div><h2>${title}</h2><p>${note}</p></div>
      <div class="board-section-counts">
        <span>${tasks.length} \u4E2A</span>
        ${blocked ? `<span class="chip merge-blocked">${blocked} \u4E2A\u89D2\u8272\u4E0D\u53EF\u7528</span>` : ""}
      </div>
    </div>
    <div class="board-section-lanes">${tasks.length ? boardColumnsHTML(tasks, kind === "merge") : `<div class="board-section-empty">${empty}</div>`}</div>
  </section>`;
  }
  function renderBoard() {
    const el = document.getElementById("boardView");
    if (!el) return;
    const tasks = filteredTasks();
    const sourceTasks = tasks.filter((t5) => !isMergeTask(t5));
    const mergeTasks = tasks.filter(isMergeTask);
    el.innerHTML = boardSectionHTML("source", "\u5B9E\u73B0\u4EFB\u52A1", "\u9879\u76EE\u4EFB\u52A1\u9ED8\u8BA4\u6309\u521B\u5EFA\u65F6\u95F4\u987A\u5E8F\u4EA4\u4ED8\uFF0C\u4E5F\u53EF\u5728\u9879\u76EE\u9875\u8C03\u6574\uFF1B\u6BCF\u9879\u5B8C\u6210\u540E\u4F1A\u5148\u5904\u7406\u81EA\u5DF1\u7684\u4EE3\u7801\u5408\u5E76\u3002", sourceTasks) + boardSectionHTML("merge", "\u4EE3\u7801\u5408\u5E76", "\u4F7F\u7528\u65B0\u7684\u72EC\u7ACB worktree \u9A8C\u8BC1\u3001\u89E3\u51B3\u51B2\u7A81\u5E76\u81EA\u52A8\u5199\u5165\u4E3B\u5206\u652F\u3002", mergeTasks);
    const c5 = document.getElementById("viewCount");
    if (c5) c5.textContent = `${sourceTasks.length} \u4E2A\u5B9E\u73B0 \xB7 ${mergeTasks.length} \u4E2A\u5408\u5E76`;
  }
  function cardHTML(t5) {
    const blocked = mergeBlockReason(t5);
    return `<article class="card" onclick="openTask(${t5.id})" style="--st-color:${ST_COLOR[t5.status]}">
    <div class="c-top">
      <span class="st-dot"></span><span class="c-id">#${t5.id}</span>
      <span class="c-time">${(t5.created_at || "").slice(5, 16).replace("T", " ")}</span>
      ${taskKindChip(t5)}
      ${dependencyChip(t5)}
      ${dependencyStateChip(t5)}
      ${sourceMergeChip(t5)}
      ${blocked ? `<span class="chip merge-blocked">${blocked}</span>` : ""}
      ${t5.perm === "review" ? `<span class="chip review">\u5BA1\u6279</span>` : ""}
      ${t5.run_mode === "interactive" ? `<span class="chip">\u4EA4\u4E92</span>` : ""}
      ${t5.concurrent ? `<span class="chip">\u5E76\u53D1</span>` : ""}
      ${t5.review_rounds > 0 ? `<span class="chip">\u7B2C${t5.review_rounds}\u8F6E</span>` : ""}
    </div>
    <a class="c-title card-primary-action" href="#/issue/${t5.id}" onclick="event.stopPropagation();openTask(${t5.id});return false">${esc(t5.title)}</a>
    ${t5.body ? `<div class="c-desc">${esc(t5.body)}</div>` : ""}
    <div class="c-meta">
      ${t5.project_id && t5.project_name ? `<a class="chip chip-link" href="/projects#/project/${t5.project_id}" title="\u6253\u5F00\u9879\u76EE\u9875" onclick="event.stopPropagation()">${esc(t5.project_name)}</a>` : ""}
      <span class="c-foot">
        ${t5.agent_name ? `<span class="c-agent"><span class="avatar sm">${esc((t5.agent_name || "?").slice(0, 1))}</span>${esc(t5.agent_name)}</span>` : `<span class="c-agent" style="color:var(--fg-faint)">\u672A\u6307\u6D3E</span>`}
        ${t5.error ? `<span style="color:var(--danger)">\u2717</span>` : ""}
      </span>
    </div>
  </article>`;
  }
  function renderList() {
    const el = document.getElementById("listBody");
    if (!el) return;
    const tasks = filteredTasks();
    el.innerHTML = tasks.map(taskListRowHTML).join("");
    const empty = document.getElementById("listEmpty");
    if (empty) empty.classList.toggle("hidden", tasks.length > 0);
    const c5 = document.getElementById("viewCount");
    if (c5) c5.textContent = `${tasks.filter((t5) => !isMergeTask(t5)).length} \u4E2A\u5B9E\u73B0 \xB7 ${tasks.filter(isMergeTask).length} \u4E2A\u5408\u5E76`;
  }
  function taskListRowHTML(t5) {
    const blocked = mergeBlockReason(t5);
    const title = esc(t5.title);
    const agent = esc(t5.agent_name || "-");
    const project = esc(t5.project_name || "-");
    const created = (t5.created_at || "").slice(5, 16).replace("T", " ") || "\u2014";
    const finished = (t5.finished_at || "").slice(5, 16).replace("T", " ") || "\u2014";
    const rounds = t5.review_rounds || "\u2014";
    const chips = `${taskKindChip(t5)}${dependencyChip(t5)}${dependencyStateChip(t5)}${blocked ? `<span class="chip merge-blocked">${esc(blocked)}</span>` : ""}`;
    const status = STATUS_LABEL[t5.status] || t5.status || "\u672A\u77E5";
    return `
    <tr class="task-list-row" tabindex="0" aria-label="\u6253\u5F00\u4EFB\u52A1 #${t5.id}\uFF1A${title}"
      onclick="openTask(${t5.id})"
      onkeydown="if (event.target !== this) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openTask(${t5.id}); }">
      <td class="task-list-id num" data-label="ID">#${t5.id}</td>
      <td class="task-list-title t-title" data-label="\u6807\u9898">
        <a class="table-primary-action" href="#/issue/${t5.id}" title="${title}" onclick="event.stopPropagation();openTask(${t5.id});return false">${title}</a>
      </td>
      <td class="task-list-type" data-label="\u7C7B\u578B"><span class="task-list-chips">${chips}</span></td>
      <td class="task-list-agent" data-label="\u89D2\u8272"><span class="task-list-text" title="${agent}">${agent}</span></td>
      <td class="task-list-project" data-label="\u9879\u76EE">${t5.project_id ? `<a class="t-link task-list-text" href="/projects#/project/${t5.project_id}" title="${project}" onclick="event.stopPropagation()">${project}</a>` : `<span class="task-list-text" title="${project}">${project}</span>`}</td>
      <td class="task-list-status" data-label="\u72B6\u6001"><span class="badge ${esc(t5.status || "unknown")}" style="--st-color:${ST_COLOR[t5.status] || "var(--fg-faint)"}"><span class="st-dot"></span>${esc(status)}</span></td>
      <td class="task-list-rounds" data-label="\u8F6E\u6B21">${esc(rounds)}</td>
      <td class="task-list-date task-list-created num" data-label="\u521B\u5EFA"><time>${esc(created)}</time></td>
      <td class="task-list-date task-list-finished num" data-label="\u7ED3\u675F"><time>${esc(finished)}</time></td>
      <td class="task-list-actions" data-label="\u64CD\u4F5C">
        <span class="ops">
          <button type="button" class="btn xs" title="\u6253\u5F00\u4EFB\u52A1\u8BE6\u60C5" aria-label="\u6253\u5F00\u4EFB\u52A1\u8BE6\u60C5" onclick="event.stopPropagation();openTask(${t5.id})">${icon("expand")}<span class="task-list-action-label">\u8BE6\u60C5</span></button>
          ${canRetryTask(t5) ? `<button type="button" class="btn xs" title="${esc(retryTaskLabel(t5))}" aria-label="${esc(retryTaskLabel(t5))}" onclick="event.stopPropagation();setTaskStatus(${t5.id},'queued')">${icon("retry")}<span class="task-list-action-label">${esc(retryTaskLabel(t5))}</span></button>` : ""}
          ${canDeleteTask(t5) ? `<button type="button" class="btn xs danger" title="\u5220\u9664\u4EFB\u52A1" aria-label="\u5220\u9664\u4EFB\u52A1" onclick="event.stopPropagation();deleteTask(${t5.id})">${icon("trash")}<span class="task-list-action-label">\u5220\u9664</span></button>` : ""}
        </span>
      </td>
      <td class="task-list-mobile-meta" colspan="3" aria-label="\u4EFB\u52A1\u65F6\u95F4\u4E0E\u8F6E\u6B21">
        <span><small>\u8F6E\u6B21</small><b>${esc(rounds)}</b></span>
        <span><small>\u521B\u5EFA</small><b>${esc(created)}</b></span>
        <span><small>\u7ED3\u675F</small><b>${esc(finished)}</b></span>
      </td>
    </tr>`;
  }
  function setView(v2) {
    state.view = v2;
    document.getElementById("segBoard").classList.toggle("active", v2 === "board");
    document.getElementById("segList").classList.toggle("active", v2 === "list");
    document.getElementById("boardView").classList.toggle("hidden", v2 !== "board");
    document.getElementById("listView").classList.toggle("hidden", v2 !== "list");
    if (v2 === "list") renderList();
    else renderBoard();
  }
  function applyFilters() {
    const pl = document.getElementById("fProjectLink");
    const pv = Number(document.getElementById("fProject")?.value) || null;
    if (pl) {
      if (pv) {
        pl.href = `/projects#/project/${pv}`;
        pl.style.display = "";
      } else pl.style.display = "none";
    }
    state.view === "list" ? renderList() : renderBoard();
  }
  function openTask(id) {
    if (!/^#\/issue\/\d+$/.test(location.hash)) detailReturnHash = location.hash || "#/";
    location.hash = "#/issue/" + id;
  }
  function closeDetail() {
    const back = detailReturnHash || "#/";
    detailReturnHash = "#/";
    location.hash = back;
  }
  function showDetail(id) {
    const changed = state.selected !== id;
    state.selected = id;
    if (changed) {
      state.logsTask = id;
      state.logs = [];
      state.logsHasMore = false;
      state.logsLoading = false;
      state.logsOldestSeq = 0;
      state.logsTotal = 0;
    }
    const main = document.querySelector(".main");
    const detailShell = document.getElementById("detailShell");
    if (!detailShell) return;
    if (detailBackground === null) {
      detailBackground = [];
      for (const child of main?.children || []) {
        if (child === detailShell || child.classList.contains("hidden")) continue;
        child.classList.add("hidden");
        detailBackground.push(child);
      }
    }
    detailShell.classList.remove("hidden");
    const t5 = state.tasks.find((x2) => x2.id === id);
    if (t5) {
      document.getElementById("dCrumb").innerHTML = `\u4EFB\u52A1 / <b>#${t5.id}</b>`;
      document.getElementById("dBadge").innerHTML = `<span class="badge ${t5.status}" style="--st-color:${ST_COLOR[t5.status]}"><span class="st-dot"></span>${STATUS_LABEL[t5.status]}</span>`;
    }
    refreshDetail(changed);
  }
  function hideDetail() {
    closeTaskTerminal();
    document.getElementById("detailShell")?.classList.add("hidden");
    for (const child of detailBackground || []) child.classList.remove("hidden");
    detailBackground = null;
    state.selected = null;
    state.logsTask = null;
    state.logs = [];
    state.logsHasMore = false;
    state.logsOldestSeq = 0;
    state.logsTotal = 0;
  }
  async function refreshDetail(reloadLogs = false) {
    if (!state.selected) return;
    const id = state.selected;
    const shouldLoadLogs = reloadLogs || state.logsTask !== id;
    const liveLogs = shouldLoadLogs ? state.logs : [];
    try {
      const [task, page] = await Promise.all([
        api(`/api/tasks/${id}`),
        shouldLoadLogs ? fetchTaskLogs(id, { limit: 200 }) : Promise.resolve(null)
      ]);
      if (state.selected !== id) return;
      const i6 = state.tasks.findIndex((x2) => x2.id === task.id);
      if (i6 >= 0) state.tasks[i6] = task;
      else state.tasks.unshift(task);
      if (page) {
        const byID = new Map(page.logs.map((l3) => [l3.id, l3]));
        for (const l3 of liveLogs) if (!byID.has(l3.id)) byID.set(l3.id, l3);
        const merged = [...byID.values()].sort((a3, b3) => a3.seq - b3.seq);
        state.logsTask = id;
        state.logs = merged;
        state.logsHasMore = page.has_more;
        state.logsOldestSeq = merged.length ? merged[0].seq : 0;
        state.logsTotal = Math.max(page.total, merged.length);
      }
      renderDetail(task);
    } catch (_2) {
    }
  }
  function renderDetail(t5) {
    const main = document.getElementById("dMain");
    if (!main) return;
    const mergeTask = isMergeTask(t5);
    const mergeSource2 = mergeTask ? state.tasks.find((x2) => x2.id === t5.merge_of) : null;
    const dependency = dependencyInfo(t5);
    const interactive = t5.run_mode === "interactive";
    const isInteractive = interactive && t5.status === "running";
    const isLive = ["claimed", "running"].includes(t5.status);
    const agent = state.agents.find((a3) => a3.id === t5.agent_id);
    const agentName = t5.agent_name || "\u672A\u6307\u6D3E";
    const agentCli = agent?.cli || "";
    const runMode = t5.run_mode === "interactive" ? "\u4EA4\u4E92\u5F0F" : "\u6279\u5904\u7406";
    const bodyLength = (t5.body || "").length;
    const createdAt = (t5.created_at || "").slice(0, 16).replace("T", " ");
    const { visible: visibleLogs, errors: logErrors } = logStats();
    const logMeta = interactive ? isLive ? "\u5B9E\u65F6\u753B\u9762 \xB7 \u8DDF\u968F\u6D4F\u89C8\u5668\u5C3A\u5BF8" : `\u5DF2\u5F52\u6863\u753B\u9762 \xB7 ${t5.terminal_cols || INTERACTIVE_TERM_COLS} \xD7 ${t5.terminal_rows || INTERACTIVE_TERM_ROWS}` : state.logsHasMore ? `\u5DF2\u52A0\u8F7D ${visibleLogs}/${state.logsTotal} \u6761` : `${visibleLogs} \u6761`;
    const dependencyAlert = !mergeTask && t5.status === "queued" && dependency.state !== "ready" ? `<div class="task-alert"><span class="task-alert-title">${dependency.state === "skipped" ? "\u524D\u5E8F\u4EA4\u4ED8\u5DF2\u8DF3\u8FC7" : "\u7B49\u5F85\u524D\u7F6E\u4EA4\u4ED8"}</span><span>${esc(dependency.reason || "\u7B49\u5F85\u8C03\u5EA6")}</span></div>` : "";
    const input = isInteractive ? `<div class="term-input detail-input terminal-input-help">
      <span>\u70B9\u51FB\u7EC8\u7AEF\u76F4\u63A5\u8F93\u5165 \xB7 Tab / \u2191 / \u2193 \u7531\u5F53\u524D CLI \u5904\u7406 \xB7 <code>${agent?.cli === "pi" ? "/quit" : "/exit"}</code> \u7ED3\u675F</span>
      <button class="btn sm" onclick="focusTaskTerminal()">\u805A\u7126\u8F93\u5165</button>
    </div>` : "";
    main.innerHTML = `
    <section class="task-hero">
      <div class="task-kicker"><span>${mergeTask ? `\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1 \xB7 \u6765\u6E90 #${t5.merge_of}` : `\u5B9E\u73B0\u4EFB\u52A1 #${t5.id}`}</span><span>\u521B\u5EFA\u4E8E ${esc(createdAt)}</span></div>
      <h2>${esc(t5.title)}</h2>
      <div class="task-meta">
        <span class="task-meta-item"><span class="avatar sm${agentCli ? ` av-${esc(agentCli)}` : ""}">${esc(agentName.slice(0, 1))}</span>${esc(agentName)}</span>
        ${t5.project_name ? `<span class="task-meta-item">${esc(t5.project_name)}</span>` : ""}
        <span class="task-meta-item">${runMode}</span>
        ${mergeTask ? "" : dependencyChip(t5)}
        ${!mergeTask && dependencyStateChip(t5)}
        ${mergeTask ? `<span class="task-meta-item task-meta-accent">${mergeSource2 ? `\u6E90\u4EFB\u52A1\uFF1A#${mergeSource2.id}` : `\u6E90\u4EFB\u52A1\uFF1A#${t5.merge_of}`}</span>` : sourceMergeChip(t5)}
        ${t5.resume_of ? `<span class="task-meta-item task-meta-accent">\u7EED\u8DD1\u81EA #${t5.resume_of}</span>` : ""}
      </div>
    </section>
    ${t5.body ? `<details class="task-section task-prompt"${bodyLength <= 160 ? " open" : ""}>
      <summary><span>\u4EFB\u52A1\u8BF4\u660E</span><span class="section-meta">${bodyLength} \u5B57</span></summary>
      ${renderBodyWithTimeline(t5.body)}
    </details>` : ""}
    ${dependencyAlert}
    ${t5.error ? `<div class="task-alert"><span class="task-alert-title">${mergeTask ? "\u4EE3\u7801\u5408\u5E76\u5931\u8D25" : "\u4EFB\u52A1\u5931\u8D25"}</span><span>${esc(t5.error)}</span></div>` : ""}
    <div id="childrenBox"></div>
    <details class="task-section task-diff"${t5.status === "awaiting_review" || t5.status === "running" ? " open" : ""}>
      <summary><span>\u4EE3\u7801\u6539\u52A8</span><span class="section-meta">${t5.status === "awaiting_review" ? "\u7B49\u5F85\u5BA1\u6279" : "git diff"}</span></summary>
      <div id="diffBox"><div class="empty">\u52A0\u8F7D\u6539\u52A8\u4E2D...</div></div>
    </details>
    <details class="task-section task-log-section${interactive ? " interactive-task-log" : ""}"${isLive ? " open" : ""}>
      <summary><span>${interactive ? "\u4EA4\u4E92\u7EC8\u7AEF" : "\u6267\u884C\u8BB0\u5F55"}</span><span class="section-meta" id="logMeta">${logMeta}${logErrors && !interactive ? ` \xB7 ${logErrors} \u4E2A\u9519\u8BEF` : ""}</span></summary>
      <div class="section-head">
        <div class="section-sub">${esc(agentName)} \xB7 ${runMode}</div>
        <div class="section-tools">
          ${interactive ? "" : `<button class="btn ghost xs ${state.logFilter === "err" ? "active-filter" : ""}" id="logFilterBtn" onclick="toggleLogFilter()">${state.logFilter === "err" ? "\u2713 " : ""}\u53EA\u770B\u9519\u8BEF</button>`}
          <button class="btn ghost xs" onclick="copyLogs()">${icon("copy")}${interactive ? "\u590D\u5236\u753B\u9762" : "\u590D\u5236"}</button>
          <button class="btn ghost xs" onclick="openTerminal(${t5.id})">${icon("expand")}\u5168\u5C4F</button>
        </div>
      </div>
      <div class="term">
      <div class="term-head">
        <span class="term-dots"><i></i><i></i><i></i></span>
        <span class="t-title" title="${esc(t5.project_dir || "")}">${esc(agentName)} \xB7 ${runMode}</span>
      </div>
      ${interactive ? `<div class="term-body interactive-term-body" id="logBox" role="region" aria-label="${esc(agentName)} \u4EA4\u4E92\u5F0F\u7EC8\u7AEF\u753B\u9762"><div class="interactive-term-canvas" id="taskTermX"></div></div>` : `<div class="term-body" id="logBox">${logsHTML()}</div>`}
      ${input}
      </div>
    </details>
    <details class="task-section task-workspace">
      <summary><span>\u5DE5\u4F5C\u7A7A\u95F4</span><span class="section-meta">Git / worktree \u4FE1\u606F</span></summary>
      <div id="wsBox"><div class="empty">\u52A0\u8F7D\u4E2D...</div></div>
    </details>`;
    const box = document.getElementById("logBox");
    const logSection = main.querySelector(".task-log-section");
    const mountInteractiveTerminal = () => {
      if (interactive && logSection?.open) openTaskTerminal(t5.id, state.logs, t5.status === "running");
      else closeTaskTerminal();
    };
    if (interactive) {
      mountInteractiveTerminal();
      logSection?.addEventListener("toggle", mountInteractiveTerminal);
    } else if (box) {
      closeTaskTerminal();
      box.scrollTop = box.scrollHeight;
      box.addEventListener("scroll", () => {
        if (box.scrollTop <= 64) loadOlderLogs(box, t5.id);
      }, { passive: true });
    }
    loadDiff(t5.id);
    loadChildren(t5.id);
    loadWorkspace(t5.id);
    renderSide(t5);
  }
  async function loadWorkspace(id) {
    const box = document.getElementById("wsBox");
    if (!box) return;
    try {
      const w2 = await api(`/api/workspace/${id}`);
      const t5 = state.tasks.find((x2) => x2.id === id) || {};
      const done = ["succeeded", "failed", "cancelled"].includes(t5.status);
      const mergeTask = isMergeTask(t5);
      const sourceMerge = mergeTaskFor(t5);
      const sourceAwaitingMerge = !mergeTask && t5.status === "succeeded";
      if (!w2.is_git) {
        box.innerHTML = `<div class="ws-row"><span class="ws-label">\u9694\u79BB</span><span class="ws-val">\u9879\u76EE\u975E git \u4ED3\u5E93\uFF0C\u4EFB\u52A1\u76F4\u63A5\u5728\u9879\u76EE\u76EE\u5F55\u6267\u884C</span><button class="btn xs" onclick="gitInitProject('${esc(w2.path)}', ${id})">git init</button></div>`;
        return;
      }
      if (!w2.is_worktree) {
        box.innerHTML = `<div class="ws-row"><span class="ws-label">\u9694\u79BB</span><span class="ws-val">${esc(w2.note || "\u65E0\u72EC\u7ACB\u5DE5\u4F5C\u7A7A\u95F4")}</span></div>`;
        return;
      }
      box.innerHTML = `
      <div class="ws-row"><span class="ws-label">\u5206\u652F</span><span class="ws-val mono">${esc(w2.branch)}</span></div>
      <div class="ws-row"><span class="ws-label">HEAD</span><span class="ws-val mono">${esc(w2.head || "-")}` + (w2.dirty ? ` <span class="ws-tag dirty">dirty</span>` : "") + (w2.ahead > 0 ? ` <span class="ws-tag ahead">+${w2.ahead}</span>` : "") + `</span></div>
      <div class="ws-row"><span class="ws-label">\u8DEF\u5F84</span><span class="ws-val mono" title="${esc(w2.path)}">${esc(w2.path)}</span></div>` + (done ? workspaceActionsHTML(t5, sourceMerge, sourceAwaitingMerge, id) : "");
    } catch (_2) {
      box.innerHTML = `<div class="empty">\u5DE5\u4F5C\u7A7A\u95F4\u4FE1\u606F\u4E0D\u53EF\u7528</div>`;
    }
  }
  function workspaceActionsHTML(t5, sourceMerge, sourceAwaitingMerge, id) {
    if (isMergeTask(t5)) {
      if (t5.status === "succeeded") {
        return `<div class="ws-actions"><span class="ws-val">\u4EE3\u7801\u5DF2\u7531\u672C\u5408\u5E76\u4EFB\u52A1\u81EA\u52A8\u5199\u5165\u4E3B\u5206\u652F</span><button class="btn sm danger" onclick="wsDiscard(${id})">\u6E05\u7406\u5DE5\u4F5C\u7A7A\u95F4</button></div>`;
      }
      const action = t5.status === "failed" || t5.status === "cancelled" ? "\u8BF7\u4F7F\u7528\u201C\u91CD\u8BD5\u5408\u5E76\u201D\u7EE7\u7EED\u5904\u7406\u3002" : "\u4EE3\u7801\u5C06\u7531\u672C\u5408\u5E76\u4EFB\u52A1\u6210\u529F\u7ED3\u7B97\u65F6\u81EA\u52A8\u5199\u5165\u4E3B\u5206\u652F\u3002";
      return `<div class="ws-actions"><span class="ws-val">${action}</span></div>`;
    }
    if (sourceAwaitingMerge) {
      if (sourceMerge) {
        return `<div class="ws-actions"><span class="ws-val">\u4EE3\u7801\u7531\u5408\u5E76\u4EFB\u52A1 #${sourceMerge.id}\uFF08${STATUS_LABEL[sourceMerge.status] || sourceMerge.status}\uFF09\u5904\u7406</span></div>`;
      }
      return `<div class="ws-actions"><span class="ws-val">\u4EE3\u7801\u5DF2\u5B8C\u6210\uFF0C\u7CFB\u7EDF\u6B63\u5728\u8865\u5EFA\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1</span></div>`;
    }
    return `<div class="ws-actions"><button class="btn sm danger" onclick="wsDiscard(${id})">\u4E22\u5F03</button></div>`;
  }
  async function wsDiscard(id) {
    if (!confirm(`\u4E22\u5F03\u4EFB\u52A1 #${id} \u7684\u5DE5\u4F5C\u7A7A\u95F4\uFF1F\u5206\u652F\u4E0E worktree \u5C06\u5220\u9664\uFF0C\u6539\u52A8\u4E0D\u53EF\u6062\u590D\u3002`)) return;
    try {
      await api(`/api/workspace/${id}/discard`, { method: "POST" });
      toast("\u5DF2\u4E22\u5F03");
      loadWorkspace(id);
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  async function gitInitProject(path, id) {
    if (!confirm(`\u5728 ${path} \u521D\u59CB\u5316 git \u4ED3\u5E93\uFF1F\u4E4B\u540E\u7684\u4EFB\u52A1\u5C06\u83B7\u5F97\u72EC\u7ACB worktree\u3002`)) return;
    try {
      await api("/api/workspace/git-init", { method: "POST", body: JSON.stringify({ path }) });
      toast("\u5DF2\u521D\u59CB\u5316");
      loadWorkspace(id);
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  function renderSide(t5) {
    const side = document.getElementById("dSide");
    if (!side) return;
    const mergeTask = isMergeTask(t5);
    const dependency = dependencyInfo(t5);
    const mergeBlocked = mergeBlockReason(t5);
    const statusOpts = Object.keys(STATUS_LABEL).map((s5) => `<option value="${s5}" ${s5 === t5.status ? "selected" : ""}>${STATUS_LABEL[s5]}</option>`).join("");
    const agentOpts = `<option value="">\u4E0D\u6307\u6D3E</option>` + state.agents.filter((a3) => a3.enabled || a3.id === t5.agent_id).map((a3) => `<option value="${a3.id}" ${a3.id === t5.agent_id ? "selected" : ""}>${esc(a3.name)}</option>`).join("");
    const pOpts = `<option value="">\u65E0\u9879\u76EE</option>` + state.projects.map((p3) => `<option value="${p3.id}" ${t5.project_id === p3.id ? "selected" : ""}>${esc(p3.name)}</option>`).join("");
    const canMoveProject = t5.dependency_mode === "none" && !t5.depends_on;
    let primaryActions = "";
    let secondaryActions = "";
    if (["queued", "claimed", "running"].includes(t5.status)) {
      primaryActions += `<button class="btn sm danger" onclick="setTaskStatus(${t5.id},'cancelled')">${icon("x")}\u53D6\u6D88\u4EFB\u52A1</button>`;
    }
    if (t5.run_mode === "interactive" && t5.status === "running") {
      primaryActions += `<button class="btn sm" onclick="endInteractiveTask(${t5.id})">${icon("terminal")}\u7ED3\u675F\u4F1A\u8BDD</button>`;
    }
    if (t5.status === "awaiting_review") {
      primaryActions += `<button class="btn sm brand" onclick="setTaskStatus(${t5.id},'succeeded')">${icon("check")}\u901A\u8FC7\u5E76\u6D3E\u53D1\u5408\u5E76</button>`;
      primaryActions += `<button class="btn sm" onclick="rejectTask(${t5.id})">${icon("retry")}\u9A73\u56DE\u91CD\u505A</button>`;
      primaryActions += `<button class="btn sm danger" onclick="setTaskStatus(${t5.id},'cancelled')">${icon("x")}\u53D6\u6D88</button>`;
    }
    if (canRetryTask(t5)) {
      primaryActions += `<button class="btn sm" onclick="setTaskStatus(${t5.id},'queued')">${icon("retry")}${retryTaskLabel(t5)}</button>`;
      if (!mergeTask) secondaryActions += `<button class="btn sm" onclick="resumeTask(${t5.id})">${icon("terminal")}\u7EE7\u7EED\u5BF9\u8BDD</button>`;
    }
    if (mergeTask) {
      if (mergeBlocked) primaryActions += `<span class="side-muted">${mergeBlocked}\uFF1B\u542F\u7528\u539F\u89D2\u8272\u540E\u5C06\u81EA\u52A8\u6267\u884C\u3002</span>`;
      secondaryActions += `<button class="btn sm" onclick="openTask(${t5.merge_of})">${icon("back")}\u6253\u5F00\u6E90\u4EFB\u52A1 #${t5.merge_of}</button>`;
    } else {
      secondaryActions += `<button class="btn sm" onclick="openSubTask(${t5.id})">${icon("plus")}\u62C6\u5206\u5B50\u4EFB\u52A1</button>`;
      if (t5.body) secondaryActions += `<button class="btn sm" onclick="saveAsTemplate(${t5.id})">${icon("bookmark")}\u4FDD\u5B58\u4E3A\u6A21\u677F</button>`;
      secondaryActions += `<button class="btn sm danger" onclick="deleteTask(${t5.id})">${icon("trash")}\u5220\u9664\u4EFB\u52A1</button>`;
    }
    const runInfo = `
    <div class="prop-row"><span class="k">\u6267\u884C\u5668</span><span class="v">tmux \xB7 ${["claimed", "running"].includes(t5.status) ? `paihuo:task-${t5.id}` : "\u65E5\u5FD7\u5DF2\u5F52\u6863"}</span></div>
    <div class="prop-row"><span class="k">\u76EE\u5F55</span><span class="v prop-mono" title="${esc(t5.project_dir || "")}">${esc(t5.project_dir || "-")}</span></div>
    <div class="prop-row"><span class="k">\u5BA1\u6279\u8F6E\u6B21</span><span class="v">${t5.review_rounds || "-"}</span></div>
    <div class="prop-row"><span class="k">\u5F00\u59CB</span><span class="v">${esc((t5.started_at || "-").slice(0, 16).replace("T", " "))}</span></div>
    <div class="prop-row"><span class="k">\u7ED3\u675F</span><span class="v">${esc((t5.finished_at || "-").slice(0, 16).replace("T", " "))}</span></div>`;
    const properties = mergeTask ? `
    <details class="side-collapse side-properties" open>
      <summary><span>\u5408\u5E76\u4EFB\u52A1\u5C5E\u6027</span><span class="section-meta">\u7CFB\u7EDF\u7BA1\u7406</span></summary>
      <div class="side-collapse-body">
        <div class="prop-row"><span class="k">\u6765\u6E90</span><span class="v"><button class="btn xs" onclick="openTask(${t5.merge_of})">\u4EFB\u52A1 #${t5.merge_of}</button></span></div>
        <div class="prop-row"><span class="k">\u72B6\u6001</span><span class="v">${STATUS_LABEL[t5.status] || t5.status}</span></div>
        <div class="prop-row"><span class="k">\u89D2\u8272</span><span class="v">${esc(t5.agent_name || "\u672A\u6307\u6D3E")}${mergeBlocked ? ` \xB7 ${mergeBlocked}` : ""}</span></div>
        <div class="prop-row"><span class="k">\u7B56\u7565</span><span class="v">\u72EC\u7ACB worktree \xB7 \u4E32\u884C \xB7 \u81EA\u52A8\u5199\u5165\u4E3B\u5206\u652F${mergeSource?.block_on_failure ? " \xB7 \u5931\u8D25\u963B\u585E\u540E\u7EED\u81EA\u52A8\u4EFB\u52A1" : " \xB7 \u5931\u8D25\u53EF\u8DF3\u8FC7"}</span></div>
      </div>
    </details>` : `
    <details class="side-collapse side-properties">
      <summary><span>\u4EFB\u52A1\u5C5E\u6027</span><span class="section-meta">\u53EF\u7F16\u8F91</span></summary>
      <div class="side-collapse-body">
        <div class="prop-row"><span class="k">\u72B6\u6001</span>
          <span class="v"><select onchange="patchTask(${t5.id},{status:this.value})">${statusOpts}</select></span></div>
        <div class="prop-row"><span class="k">\u9879\u76EE</span>
          <span class="v"><select ${canMoveProject ? "" : 'disabled title="\u6709\u524D\u7F6E\u4F9D\u8D56\u7684\u4EFB\u52A1\u4E0D\u80FD\u6539\u9879\u76EE"'} onchange="patchTask(${t5.id},{project_id:this.value||null})">${pOpts}</select></span></div>
        <div class="prop-row"><span class="k">\u89D2\u8272</span>
          <span class="v"><select aria-label="\u4EFB\u52A1\u89D2\u8272" onchange="patchTask(${t5.id},{agent_id:Number(this.value)||null})">${agentOpts}</select></span></div>
        <div class="prop-row"><span class="k">\u6743\u9650</span><span class="v">${t5.perm === "full" ? "\u81EA\u52A8\u5408\u5E76" : "\u5BA1\u6279\u540E\u5408\u5E76"}</span></div>
        <div class="prop-row"><span class="k">\u65B9\u5F0F</span><span class="v">${t5.run_mode === "interactive" ? "\u4EA4\u4E92\u5F0F" : "\u6279\u5904\u7406"}</span></div>
        <div class="prop-row"><span class="k">\u524D\u7F6E\u4EA4\u4ED8</span><span class="v">${dependencyChip(t5)}${dependency.state !== "ready" ? ` <span title="${esc(dependency.reason || "")}">${esc(dependency.stateLabel || dependency.reason || "\u7B49\u5F85")}</span>` : ""}</span></div>
        <div class="prop-row"><span class="k">\u5931\u8D25\u540E</span>
          <span class="v"><select onchange="patchTask(${t5.id},{block_on_failure:this.value==='1'})">
            <option value="0" ${t5.block_on_failure ? "" : "selected"}>\u540E\u7EED\u5F31\u4F9D\u8D56\u53EF\u8DF3\u8FC7</option>
            <option value="1" ${t5.block_on_failure ? "selected" : ""}>\u963B\u585E\u540E\u7EED\u5F31\u4F9D\u8D56</option>
          </select></span></div>
        <div class="prop-row"><span class="k">\u5E76\u53D1</span>
          <span class="v"><select onchange="patchTask(${t5.id},{concurrent:this.value==='1'})">
            <option value="0" ${t5.concurrent ? "" : "selected"}>\u4E0D\u91CD\u53E0\u6267\u884C\uFF08\u9ED8\u8BA4\uFF09</option>
            <option value="1" ${t5.concurrent ? "selected" : ""}>\u5141\u8BB8\u8D44\u6E90\u5E76\u53D1</option>
          </select></span></div>
      </div>
    </details>`;
    side.innerHTML = `
    ${properties}
    <details class="side-collapse">
      <summary><span>\u8FD0\u884C\u4FE1\u606F</span><span class="section-meta">\u6280\u672F\u7EC6\u8282</span></summary>
      <div class="side-collapse-body">${runInfo}</div>
    </details>
    <section class="side-actions">
      <div class="side-heading">\u4E0B\u4E00\u6B65</div>
      <div class="detail-actions">${primaryActions || `<span class="side-muted">\u6682\u65E0\u9700\u8981\u5904\u7406\u7684\u64CD\u4F5C</span>`}</div>
      ${secondaryActions ? `<details class="side-more-actions">
        <summary>\u66F4\u591A\u64CD\u4F5C</summary>
        <div class="detail-actions">${secondaryActions}</div>
      </details>` : ""}
    </section>`;
  }
  async function patchTask(id, set) {
    try {
      const task = await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(set) });
      const i6 = state.tasks.findIndex((t5) => t5.id === task.id);
      if (i6 >= 0) state.tasks[i6] = task;
      else state.tasks.unshift(task);
      if (state.selected === id) renderDetail(task);
      if (location.pathname === "/board") {
        state.view === "list" ? renderList() : renderBoard();
      } else if (location.pathname === "/") {
        loadDashboard();
      } else if (location.pathname === "/history") {
        loadHistory();
      } else if (location.pathname === "/projects" && state.projectView) {
        refreshProjectDetail();
      }
      toast("\u5DF2\u66F4\u65B0");
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  async function setTaskStatus(id, status) {
    try {
      await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      if (status === "succeeded") toast("\u5DF2\u5BA1\u6279\uFF0C\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1\u5DF2\u6D3E\u53D1");
      if (status === "queued" && location.pathname === "/history") {
        location.href = "/";
        return;
      }
      await loadAll();
      const p3 = location.pathname;
      if (p3 === "/" || p3 === "/board") {
        if (state.selected === id && location.hash.startsWith("#/issue/")) showDetail(id);
        if (p3 === "/") loadDashboard();
      } else if (p3 === "/history") {
        loadHistory();
      } else if (p3 === "/projects" && state.projectView) {
        refreshProjectDetail();
      }
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  async function endInteractiveTask(id) {
    if (!confirm("\u7ED3\u675F\u4EA4\u4E92\u4F1A\u8BDD\uFF1F\u5C06\u5411\u7EC8\u7AEF\u53D1\u9001\u8BE5 CLI \u7684\u9000\u51FA\u547D\u4EE4\uFF08pi \u4E3A /quit\uFF09\uFF0Cagent \u6536\u5C3E\u540E\u4EFB\u52A1\u6309\u6B63\u5E38\u9000\u51FA\u7ED3\u679C\u7ED3\u7B97\u3002")) return;
    try {
      const res = await api(`/api/tasks/${id}/end-session`, { method: "POST" });
      toast(`\u5DF2\u53D1\u9001 ${res.sent}\uFF0C\u7B49\u5F85 agent \u9000\u51FA`);
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  async function rejectTask(id) {
    const note = prompt("\u9A73\u56DE\u539F\u56E0 / \u4FEE\u6539\u610F\u89C1\uFF08\u5C06\u8FFD\u52A0\u5230\u4EFB\u52A1\u63D0\u793A\u8BCD\uFF0C\u91CD\u65B0\u6267\u884C\uFF09");
    if (note === null) return;
    try {
      await api(`/api/tasks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "queued", review_note: note })
      });
      toast("\u5DF2\u9A73\u56DE\uFF0C\u4EFB\u52A1\u91CD\u65B0\u6267\u884C");
      await loadAll();
      showDetail(id);
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  async function deleteTask(id) {
    const task = state.tasks.find((t5) => t5.id === id);
    if (isMergeTask(task)) return toast("\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1\u4E0D\u80FD\u5355\u72EC\u5220\u9664\uFF1B\u8BF7\u91CD\u8BD5\u5B83\uFF0C\u6216\u5220\u9664\u6E90\u4EFB\u52A1\u4EE5\u653E\u5F03\u6574\u7EC4\u4EE3\u7801", true);
    if (!confirm(`\u5220\u9664\u4EFB\u52A1 #${id}\uFF1F\u6267\u884C\u65E5\u5FD7\u3001worktree\u3001\u4EFB\u52A1\u5206\u652F\u53CA\u5176\u5408\u5E76\u5B50\u4EFB\u52A1\u5C06\u4E00\u5E76\u5220\u9664\u3002`)) return;
    try {
      await api(`/api/tasks/${id}`, { method: "DELETE" });
      toast("\u5DF2\u5220\u9664");
      await loadAll();
      const p3 = location.pathname;
      if (state.selected === id) closeDetail();
      if (p3 === "/history") loadHistory();
      if (p3 === "/projects" && state.projectView) refreshProjectDetail();
      if (p3 === "/") loadDashboard();
      if (p3 === "/board") {
        renderBoard();
        renderList();
      }
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  function canRetryTask(t5) {
    if (!["succeeded", "failed", "cancelled"].includes(t5.status)) return false;
    if (isMergeTask(t5)) return ["failed", "cancelled"].includes(t5.status);
    return !(t5.status === "succeeded" && (t5.worktree_branch || mergeTaskFor(t5)));
  }
  function retryTaskLabel(t5) {
    return isMergeTask(t5) ? "\u91CD\u8BD5\u5408\u5E76" : "\u91CD\u8BD5";
  }
  function canDeleteTask(t5) {
    return !isMergeTask(t5);
  }
  async function loadChildren(id) {
    try {
      const kids = await api(`/api/tasks/${id}/children`);
      const box = document.getElementById("childrenBox");
      if (!box || !kids.length) return;
      const sourceKids = kids.filter((k2) => !isMergeTask(k2));
      const mergeKids = kids.filter(isMergeTask);
      const section = (title, items, open, merge) => {
        if (!items.length) return "";
        const done = items.filter((k2) => ["succeeded", "failed", "cancelled"].includes(k2.status)).length;
        return `<details class="task-section task-subtasks ${merge ? "task-merge-children" : ""}"${open ? " open" : ""}>
        <summary><span>${title}</span><span class="section-meta">${done}/${items.length} \u5DF2\u7ED3\u675F</span></summary>
        <div class="task-subtask-list">` + items.map((k2) => `<div class="task-subtask" onclick="openTask(${k2.id})">
          <a class="c-title card-primary-action" href="#/issue/${k2.id}" onclick="event.stopPropagation();openTask(${k2.id});return false">#${k2.id} ${esc(k2.title)}</a>
          <div class="c-meta">${isMergeTask(k2) ? `<span class="chip merge">\u4EE3\u7801\u5408\u5E76</span>` : ""}<span class="badge ${k2.status}" style="--st-color:${ST_COLOR[k2.status]}"><span class="st-dot"></span>${STATUS_LABEL[k2.status]}</span>
          <span style="font-size:11px;color:var(--fg-faint)">${esc(k2.agent_name || "")}</span></div>
        </div>`).join("") + `</div></details>`;
      };
      const sourceActive = sourceKids.some((k2) => ["queued", "claimed", "running", "awaiting_review"].includes(k2.status));
      const mergeActive = mergeKids.some((k2) => ["queued", "claimed", "running", "awaiting_review"].includes(k2.status));
      box.innerHTML = section("\u5B50\u4EFB\u52A1", sourceKids, sourceActive, false) + section("\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1", mergeKids, mergeActive, true);
    } catch (_2) {
    }
  }
  function openSubTask(parentId) {
    fillSelects();
    const t5 = state.tasks.find((x2) => x2.id === parentId);
    document.getElementById("tTitle").value = "";
    document.getElementById("tBody").value = "";
    document.getElementById("tPerm").value = t5 ? t5.perm : "full";
    document.getElementById("tRunMode").value = "batch";
    document.getElementById("tConcurrent").checked = false;
    document.getElementById("tProject").value = t5 && t5.project_id ? t5.project_id : "";
    document.getElementById("tDependencyMode").value = t5 && t5.project_id ? "weak" : "none";
    document.getElementById("tBlockOnFailure").checked = false;
    document.getElementById("tParentId").value = parentId;
    document.getElementById("taskModalTitle").textContent = "\u62C6\u5206\u5B50\u4EFB\u52A1";
    syncTaskRunMode();
    syncTaskDependency();
    openModal("taskModal");
  }
  async function resumeTask(id) {
    if (!confirm(`\u7EE7\u7EED\u4EFB\u52A1 #${id}\uFF1F\u5C06\u4FDD\u7559\u4EFB\u52A1\u7F16\u53F7\u3001\u4EFB\u52A1\u4F1A\u8BDD\u76EE\u5F55\u3001\u5DE5\u4F5C\u7A7A\u95F4\u548C\u5386\u53F2\u8BB0\u5F55\uFF0C\u91CD\u65B0\u6392\u961F\u6267\u884C\u3002`)) return;
    try {
      const t5 = await api(`/api/tasks/${id}/resume`, { method: "POST" });
      toast(`\u4EFB\u52A1 #${t5.id} \u5DF2\u5728\u539F\u4EFB\u52A1\u4E2D\u91CD\u65B0\u6392\u961F`);
      await loadAll();
      openTask(t5.id);
      if (state.selected === t5.id) showDetail(t5.id);
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  async function loadDiff(id) {
    try {
      const d3 = await api(`/api/tasks/${id}/diff`);
      const box = document.getElementById("diffBox");
      if (!box) return;
      if (!d3.stat && !d3.diff) {
        box.innerHTML = `<div class="detail-desc">\u65E0\u6587\u4EF6\u6539\u52A8\u6216\u975E git \u4ED3\u5E93${d3.note ? "\uFF08" + esc(d3.note) + "\uFF09" : ""}</div>`;
        return;
      }
      const node = mountTaskDiff(box, id, state.tasks.find((t5) => t5.id === id)?.status);
      if (node) node.requestUpdate();
    } catch (_2) {
    }
  }
  function splitReviewRounds(body) {
    const rounds = [];
    let intro = String(body || "");
    let m2;
    let lastIdx = 0;
    const parts = [];
    while ((m2 = REVIEW_RE.exec(intro)) !== null) {
      const note = intro.slice(m2.index + m2[0].length).split(/\n\n|【修改意见/)[0].trim();
      rounds.push({ round: +m2[1], time: (m2[2] || "").trim(), note });
      parts.push(intro.slice(lastIdx, m2.index));
      lastIdx = m2.index + m2[0].length;
    }
    if (parts.length) {
      intro = parts.join("");
    }
    return { intro: intro.trim(), rounds };
  }
  function renderBodyWithTimeline(body) {
    if (!body) return "";
    const { intro, rounds } = splitReviewRounds(body);
    if (!rounds.length) return `<div class="task-prompt-body">${md(body)}</div>`;
    const list = rounds.map((r6) => `
    <div class="review-round">
      <div class="review-round-head"><span class="review-round-badge">\u7B2C ${r6.round} \u8F6E\u610F\u89C1</span><span class="review-round-time">${esc(r6.time || "")}</span></div>
      <div class="review-round-body">${md(r6.note)}</div>
    </div>`).join("");
    return `<div class="task-prompt-body">${intro ? md(intro) : ""}</div><div class="review-timeline"><div class="review-timeline-title">\u9A73\u56DE\u610F\u89C1\u65F6\u95F4\u7EBF\uFF08${rounds.length} \u8F6E\uFF09</div>${list}</div>`;
  }
  function tsOf(l3) {
    const m2 = /T(\d{2}:\d{2}:\d{2})/.exec(l3.created_at || "");
    return m2 ? m2[1] : "";
  }
  function cleanLogContent(content) {
    let text = String(content ?? "").replace(ANSI_OSC_RE, "").replace(ANSI_CSI_RE, "").replace(ANSI_CHAR_RE, "").replace(ANSI_RE, "").replace(/\u0000/g, "");
    text = text.split("\n").map((line) => {
      const parts = line.split("\r");
      for (let i6 = parts.length - 1; i6 >= 0; i6--) {
        if (parts[i6] !== "") return parts[i6];
      }
      return "";
    }).join("\n");
    return text;
  }
  function logStats() {
    let visible = 0;
    let errors = 0;
    for (const l3 of state.logs) {
      if (cleanLogContent(l3.content).trim()) visible++;
      if (l3.stream === "err") errors++;
    }
    return { visible, errors };
  }
  function updateLogMeta() {
    const meta = document.getElementById("logMeta");
    if (!meta) return;
    const task = state.tasks.find((t5) => t5.id === state.selected);
    if (task?.run_mode === "interactive") {
      const live = ["claimed", "running"].includes(task.status);
      meta.textContent = live ? "\u5B9E\u65F6\u753B\u9762 \xB7 \u8DDF\u968F\u6D4F\u89C8\u5668\u5C3A\u5BF8" : `\u5DF2\u5F52\u6863\u753B\u9762 \xB7 ${task.terminal_cols || INTERACTIVE_TERM_COLS} \xD7 ${task.terminal_rows || INTERACTIVE_TERM_ROWS}`;
      return;
    }
    const { visible, errors } = logStats();
    const count = state.logsHasMore ? `\u5DF2\u52A0\u8F7D ${visible}/${state.logsTotal} \u6761` : `${visible} \u6761`;
    meta.textContent = count + (errors ? ` \xB7 ${errors} \u4E2A\u9519\u8BEF` : "");
  }
  async function loadOlderLogs(box, id) {
    if (state.selected !== id || state.logsTask !== id || !state.logsHasMore || state.logsLoading) return;
    const before = state.logsOldestSeq;
    if (!before) return;
    state.logsLoading = true;
    try {
      const page = await fetchTaskLogs(id, { before, limit: 200 });
      if (state.selected !== id || !box.isConnected) return;
      const existing = new Set(state.logs.map((l3) => l3.id));
      const older = page.logs.filter((l3) => !existing.has(l3.id));
      if (!older.length) {
        state.logsHasMore = false;
        updateLogMeta();
        return;
      }
      const height = box.scrollHeight;
      const top = box.scrollTop;
      state.logs = [...older, ...state.logs];
      state.logsHasMore = page.has_more;
      state.logsOldestSeq = state.logs[0]?.seq || 0;
      state.logsTotal = page.total;
      box.insertAdjacentHTML("afterbegin", older.map(logLineHTML).filter(Boolean).join(""));
      requestAnimationFrame(() => {
        box.scrollTop = top + box.scrollHeight - height;
      });
      updateLogMeta();
    } catch (_2) {
    } finally {
      state.logsLoading = false;
    }
  }
  function logLineHTML(l3) {
    const content = cleanLogContent(l3.content);
    if (!content.trim() && l3.stream !== "sys") return "";
    return `<div class="line"><span class="ts">${tsOf(l3)}</span><span class="c ${l3.stream}">${esc(content)}</span></div>`;
  }
  function toggleLogFilter() {
    setLogFilter(state.logFilter === "err" ? "all" : "err");
    const btn = document.getElementById("logFilterBtn");
    if (btn) btn.textContent = state.logFilter === "err" ? "\u2713 \u53EA\u770B\u9519\u8BEF" : "\u53EA\u770B\u9519\u8BEF";
    updateLogMeta();
  }
  function setLogFilter(mode) {
    state.logFilter = mode;
    const box = document.getElementById("logBox");
    if (box) {
      box.innerHTML = logsHTML();
      box.scrollTop = box.scrollHeight;
    }
  }
  function logsHTML() {
    const onlyErr = state.logFilter === "err";
    const rows = state.logs.map(logLineHTML).filter(Boolean);
    if (!onlyErr) return rows.join("");
    const out = [];
    for (let i6 = 0; i6 < rows.length; i6++) {
      const l3 = state.logs[i6];
      if (l3.stream === "err") {
        if (out.length && !out[out.length - 1].startsWith("err-row")) out.push(`<div class="err-divider"></div>`);
        out.push(`err-row:${rows[i6]}`);
      }
    }
    return out.map((r6) => r6.startsWith("err-row:") ? r6.slice(8) : r6).join("");
  }
  function appendLog(l3) {
    if (state.selected === l3.task_id) {
      if (state.logs.some((existing) => existing.id === l3.id)) return;
      state.logs.push(l3);
      state.logsTotal = Math.max(state.logsTotal + 1, state.logs.length);
      const box = document.getElementById("logBox");
      if (box) {
        const task = state.tasks.find((t5) => t5.id === l3.task_id);
        if (task?.run_mode === "interactive") {
          taskTermAppendLog(l3);
        } else {
          const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 32;
          if (state.logFilter !== "err" || l3.stream === "err") {
            box.insertAdjacentHTML("beforeend", logLineHTML(l3));
          }
          if (atBottom) box.scrollTop = box.scrollHeight;
        }
        updateLogMeta();
      }
    }
    termAppendLog(l3);
  }
  async function copyLogs() {
    try {
      if (!state.selected) return;
      const task = state.tasks.find((t5) => t5.id === state.selected);
      const terminalView = task?.run_mode === "interactive" ? taskTerminalText() : "";
      if (terminalView.trim()) {
        await navigator.clipboard.writeText(terminalView);
        toast("\u5DF2\u590D\u5236\u5F53\u524D\u7EC8\u7AEF\u753B\u9762");
        return;
      }
      const page = await fetchTaskLogs(state.selected, { all: true });
      await navigator.clipboard.writeText(page.logs.map((l3) => cleanLogContent(l3.content)).filter(Boolean).join("\n"));
      toast("\u5DF2\u590D\u5236\u5BF9\u8BDD\u5185\u5BB9");
    } catch (_2) {
      toast("\u590D\u5236\u5931\u8D25", true);
    }
  }
  function openNewTask() {
    fillSelects();
    document.getElementById("tTitle").value = "";
    document.getElementById("tBody").value = "";
    document.getElementById("tPerm").value = "full";
    document.getElementById("tRunMode").value = "batch";
    document.getElementById("tConcurrent").checked = false;
    document.getElementById("tProject").value = "";
    document.getElementById("tDependencyMode").value = "none";
    document.getElementById("tBlockOnFailure").checked = false;
    document.getElementById("tParentId").value = "";
    document.getElementById("taskModalTitle").textContent = "\u65B0\u5EFA\u4EFB\u52A1";
    syncTaskRunMode();
    syncTaskDependency();
    openModal("taskModal");
  }
  function openProjectTask(projectId) {
    const p3 = state.projects.find((x2) => x2.id === projectId);
    fillSelects();
    document.getElementById("tTitle").value = "";
    document.getElementById("tBody").value = "";
    document.getElementById("tPerm").value = "full";
    document.getElementById("tRunMode").value = "batch";
    document.getElementById("tConcurrent").checked = false;
    document.getElementById("tProject").value = projectId;
    document.getElementById("tDependencyMode").value = "weak";
    document.getElementById("tBlockOnFailure").checked = false;
    document.getElementById("tParentId").value = "";
    document.getElementById("taskModalTitle").textContent = p3 ? `\u65B0\u5EFA\u4EFB\u52A1 \xB7 ${esc(p3.name)}` : "\u65B0\u5EFA\u4EFB\u52A1";
    syncTaskRunMode();
    syncTaskDependency();
    openModal("taskModal");
  }
  function syncTaskRunMode() {
    const agentID = Number(document.getElementById("tAgent")?.value) || 0;
    const agent = state.agents.find((a3) => a3.id === agentID);
    const select = document.getElementById("tRunMode");
    const help = document.getElementById("tRunModeHelp");
    if (!select) return;
    const interactive = select.querySelector('option[value="interactive"]');
    if (interactive) interactive.disabled = !agent;
    if (!agent && select.value === "interactive") select.value = "batch";
    if (help) {
      if (select.value === "session") {
        help.textContent = "\u521B\u5EFA\u5E38\u9A7B\u4F1A\u8BDD\uFF1A\u590D\u6742\u95EE\u9898\u4E0E agent \u591A\u8F6E\u534F\u4F5C\uFF08worktree \u9694\u79BB\uFF09\uFF0C\u5B8C\u6210\u65F6\u70B9\u300C\u4EA4\u4ED8\u300D\u8F6C\u4E3A\u4EFB\u52A1\u8D70\u5BA1\u6279\u5408\u5E76\u6D41\u7A0B\u3002";
      } else {
        help.textContent = agent ? `\u6279\u5904\u7406\u4F1A\u81EA\u52A8\u7ED3\u7B97\uFF1B\u4EA4\u4E92\u5F0F\u4F1A\u4FDD\u7559 ${agent.name} \u7684\u539F\u751F\u7EC8\u7AEF\uFF0C\u76F4\u5230\u4F60\u53D1\u9001 ${agent.cli === "pi" ? "/quit" : "/exit"}\u3002` : "\u6279\u5904\u7406\u4F1A\u81EA\u52A8\u7ED3\u7B97\uFF1B\u9009\u62E9\u89D2\u8272\u540E\u53EF\u542F\u7528\u5176\u4EA4\u4E92\u5F0F\u7EC8\u7AEF\u3002";
      }
    }
  }
  function syncTaskDependency() {
    const projectID = Number(document.getElementById("tProject")?.value) || null;
    const modeEl = document.getElementById("tDependencyMode");
    const dependsEl = document.getElementById("tDependsOn");
    const row = document.getElementById("tDependsOnRow");
    const help = document.getElementById("tDependencyHelp");
    if (!modeEl || !dependsEl || !row) return;
    if (!projectID) modeEl.value = "none";
    let mode = modeEl.value || (projectID ? "weak" : "none");
    if (!["none", "weak", "strong"].includes(mode)) mode = projectID ? "weak" : "none";
    if (!projectID && mode !== "none") mode = "none";
    modeEl.value = mode;
    const selected = Number(dependsEl.value) || null;
    const candidates = projectID ? state.tasks.filter((t5) => t5.project_id === projectID && !isMergeTask(t5)).sort((a3, b3) => b3.id - a3.id) : [];
    dependsEl.innerHTML = `<option value="">\u9009\u62E9\u524D\u7F6E\u5B9E\u73B0\u4EFB\u52A1</option>` + candidates.map((t5) => `<option value="${t5.id}">#${t5.id} \xB7 ${esc(t5.title)}</option>`).join("");
    if (selected && candidates.some((t5) => t5.id === selected)) dependsEl.value = selected;
    const strong = projectID && mode === "strong";
    row.classList.toggle("hidden", !strong);
    dependsEl.disabled = !strong;
    if (help) {
      if (!projectID) {
        help.textContent = "\u65E0\u9879\u76EE\u4EFB\u52A1\u9ED8\u8BA4\u72EC\u7ACB\u6267\u884C\uFF1B\u5982\u9700\u6309\u4EE3\u7801\u57FA\u7EBF\u987A\u5E8F\uFF0C\u8BF7\u5148\u9009\u62E9\u9879\u76EE\u3002";
      } else if (mode === "strong") {
        help.textContent = "\u660E\u786E\u524D\u7F6E\u662F\u5F3A\u4F9D\u8D56\uFF1A\u65E0\u8BBA\u524D\u7F6E\u662F\u5426\u8BBE\u7F6E\u5931\u8D25\u53EF\u8DF3\u8FC7\uFF0C\u672C\u4EFB\u52A1\u90FD\u5FC5\u987B\u7B49\u5B83\u548C\u5176\u5408\u5E76\u4EFB\u52A1\u6210\u529F\u3002";
      } else if (mode === "none") {
        help.textContent = "\u72EC\u7ACB\u4EFB\u52A1\u4E0D\u7B49\u5F85\u6B64\u524D\u4EA4\u4ED8\uFF1B\u540E\u7EED\u9ED8\u8BA4\u4EFB\u52A1\u4ECD\u4F1A\u6309\u9879\u76EE\u6267\u884C\u987A\u5E8F\u4EE5\u672C\u4EFB\u52A1\u4E3A\u524D\u5E8F\u3002";
      } else {
        help.textContent = "\u81EA\u52A8\u5F31\u4F9D\u8D56\uFF1A\u7B49\u5F85\u5F53\u524D\u9879\u76EE\u6B64\u524D\u987A\u5E8F\u4E2D\u7684\u4EA4\u4ED8\uFF1B\u82E5\u524D\u5E8F\u5931\u8D25\u4E14\u672A\u8BBE\u7F6E\u963B\u585E\uFF0C\u4F1A\u8DF3\u8FC7\u5B83\u7EE7\u7EED\u6267\u884C\u3002";
      }
    }
  }
  function syncTaskConcurrency() {
    const concurrent = document.getElementById("tConcurrent")?.checked;
    const modeEl = document.getElementById("tDependencyMode");
    if (concurrent && modeEl?.value === "weak") modeEl.value = "none";
    syncTaskDependency();
  }
  async function submitTask() {
    const title = document.getElementById("tTitle").value.trim();
    if (!title) return toast("\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A", true);
    const runMode = document.getElementById("tRunMode").value;
    if (runMode === "session") {
      const agentId = Number(document.getElementById("tAgent").value) || 0;
      const projectId2 = Number(document.getElementById("tProject").value) || 0;
      closeModal("taskModal");
      const params = new URLSearchParams();
      if (agentId) params.set("agent", agentId);
      if (projectId2) params.set("project", projectId2);
      if (title) params.set("title", title);
      location.href = "/sessions" + (params.toString() ? "?" + params.toString() : "");
      return;
    }
    const parentId = Number(document.getElementById("tParentId").value) || null;
    const projectId = Number(document.getElementById("tProject").value) || null;
    let dependencyMode = document.getElementById("tDependencyMode").value || "none";
    if (!projectId) dependencyMode = "none";
    const dependsOn = dependencyMode === "strong" ? Number(document.getElementById("tDependsOn").value) || null : null;
    if (dependencyMode === "strong" && !dependsOn) return toast("\u8BF7\u9009\u62E9\u660E\u786E\u524D\u7F6E\u4EFB\u52A1", true);
    try {
      await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          title,
          body: document.getElementById("tBody").value,
          agent_id: Number(document.getElementById("tAgent").value) || null,
          project_id: projectId,
          perm: document.getElementById("tPerm").value,
          run_mode: runMode,
          concurrent: document.getElementById("tConcurrent").checked,
          dependency_mode: dependencyMode,
          depends_on: dependsOn,
          block_on_failure: document.getElementById("tBlockOnFailure").checked,
          parent_id: parentId
        })
      });
      closeModal("taskModal");
      toast("\u4EFB\u52A1\u5DF2\u521B\u5EFA");
      await loadAll();
      renderBoard();
      renderList();
      refreshOverview();
      if (location.pathname === "/projects" && state.projectView) refreshProjectDetail();
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  function applyTemplate() {
    const t5 = state.templates.find((x2) => x2.id === Number(document.getElementById("tTemplate").value));
    if (!t5) return;
    document.getElementById("tBody").value = t5.body || "";
    if (t5.agent_id) document.getElementById("tAgent").value = t5.agent_id;
    syncTaskRunMode();
  }
  async function saveAsTemplate(taskId) {
    let t5;
    try {
      t5 = await api(`/api/tasks/${taskId}`);
    } catch (_2) {
      return;
    }
    const name = prompt("\u6A21\u677F\u540D\u79F0\uFF08\u7528\u4E8E\u590D\u7528\u8BE5\u4EFB\u52A1\u7684\u63D0\u793A\u8BCD\uFF09", t5.title);
    if (!name) return;
    try {
      await api("/api/templates", { method: "POST", body: JSON.stringify({ name, body: t5.body, agent_id: t5.agent_id }) });
      toast("\u5DF2\u4FDD\u5B58\u4E3A\u6A21\u677F");
      loadTemplates();
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  var detailBackground, detailReturnHash, REVIEW_RE, ANSI_OSC_RE, ANSI_CSI_RE, ANSI_CHAR_RE, ANSI_RE;
  var init_task = __esm({
    "internal/web/static/src/task.js"() {
      init_core();
      init_sessions();
      init_task_diff();
      init_dashboard();
      init_history();
      init_main();
      init_projects();
      init_skills();
      init_terminal();
      detailBackground = null;
      detailReturnHash = "#/";
      REVIEW_RE = /【修改意见\s*第\s*(\d+)\s*轮\s*(\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2})?[^】]*】/g;
      ANSI_OSC_RE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
      ANSI_CSI_RE = /\u001b\[[0-?]*[ -\/]*[@-~]/g;
      ANSI_CHAR_RE = /\u001b[()][0-2A-Z]/g;
      ANSI_RE = /\u001b[@-_]/g;
    }
  });

  // internal/web/static/src/projects.js
  function renderProjectList() {
    const grid = document.getElementById("projectGrid");
    if (!grid) return;
    const q = (document.getElementById("pSearch")?.value || "").trim().toLowerCase();
    const list = state.projects.filter((p3) => !q || p3.name.toLowerCase().includes(q));
    grid.innerHTML = list.map((p3) => {
      const ts = state.tasks.filter((t5) => t5.project_id === p3.id);
      const sourceTasks = ts.filter((t5) => !isMergeTask(t5));
      const mergeTasks = ts.filter(isMergeTask);
      const done = sourceTasks.filter((t5) => t5.status === "succeeded").length;
      const pct = sourceTasks.length ? done / sourceTasks.length * 100 : 0;
      const agents = new Set(ts.map((t5) => t5.agent_name).filter(Boolean));
      return `<a class="project-card" href="/projects#/project/${p3.id}">
      <div class="pc-top">
        <b>${esc(p3.name)}</b>
        ${p3.is_git ? `<span class="chip git-chip" title="git \u4ED3\u5E93\uFF0C\u4EFB\u52A1\u5C06\u83B7\u5F97\u72EC\u7ACB worktree">git</span>` : `<span class="chip" title="\u975E git \u4ED3\u5E93\uFF0C\u4EFB\u52A1\u76F4\u63A5\u5728\u9879\u76EE\u76EE\u5F55\u6267\u884C">\u975E git</span>`}
        <span class="badge ${p3.status === "active" ? "running" : "cancelled"}">${p3.status === "active" ? "\u8FDB\u884C\u4E2D" : "\u5DF2\u5F52\u6863"}</span>
      </div>
      ${p3.description ? `<div class="pc-desc">${esc(p3.description)}</div>` : ""}
      <div class="pc-progress"><div class="pp-bar"><div style="width:${pct}%"></div></div>
        <span class="pc-pct">${fmtPct(pct)}</span></div>
      <div class="pc-meta">
        ${p3.project_dir ? `<span class="pc-dir" title="${esc(p3.project_dir)}">${esc(p3.project_dir)}</span>` : ""}
        <span>${sourceTasks.length} \u4EFB\u52A1</span>
        ${mergeTasks.length ? `<span>${mergeTasks.length} \u5408\u5E76</span>` : ""}
        <span>${done} \u5B9E\u73B0\u5B8C\u6210</span>
        <span>${agents.size} \u89D2\u8272</span>
        <span class="spacer"></span>
        <span class="pc-date">${(p3.updated_at || p3.created_at || "").slice(5, 16).replace("T", " ")}</span>
      </div>
    </a>`;
    }).join("");
    const empty = document.getElementById("projectEmpty");
    if (empty) empty.classList.toggle("hidden", list.length > 0);
    const cnt = document.getElementById("projectCount");
    if (cnt) cnt.textContent = `${list.length} \u4E2A\u9879\u76EE`;
  }
  function openProject(id) {
    location.hash = "#/project/" + id;
  }
  function closeProjectDetail() {
    location.hash = "#/";
  }
  function showProjectDetail(id) {
    state.projectView = id;
    document.getElementById("projectListShell").classList.add("hidden");
    document.getElementById("projectDetailShell").classList.remove("hidden");
    refreshProjectDetail();
  }
  function hideProjectDetail() {
    document.getElementById("projectDetailShell").classList.add("hidden");
    document.getElementById("projectListShell").classList.remove("hidden");
    state.projectView = null;
  }
  async function refreshProjectDetail() {
    if (!state.projectView) return;
    const id = state.projectView;
    const p3 = state.projects.find((x2) => x2.id === id);
    if (!p3) return;
    document.getElementById("pdCrumb").innerHTML = `\u9879\u76EE / <b>${esc(p3.name)}</b>`;
    document.getElementById("pdBadge").innerHTML = `<span class="badge ${p3.status === "active" ? "running" : "cancelled"}">${p3.status === "active" ? "\u8FDB\u884C\u4E2D" : "\u5DF2\u5F52\u6863"}</span>`;
    try {
      const [stats, tasks] = await Promise.all([
        api(`/api/stats/project/${id}`),
        api(`/api/tasks?project_id=${id}`)
      ]);
      state.projectStats[id] = stats;
      renderProjectDetail(p3, stats, tasks);
    } catch (_2) {
    }
  }
  function projectTaskOrder(a3, b3) {
    const ao = Number(a3.sort_order) || 0;
    const bo = Number(b3.sort_order) || 0;
    if (ao !== bo) return ao - bo;
    const ac = a3.created_at || "";
    const bc = b3.created_at || "";
    return ac === bc ? a3.id - b3.id : ac.localeCompare(bc);
  }
  function queuedProjectTaskIDs(tasks) {
    return tasks.filter((t5) => !isMergeTask(t5) && t5.status === "queued").sort(projectTaskOrder).map((t5) => t5.id);
  }
  async function persistProjectTaskOrder(projectID, taskIDs) {
    if (state.projectReorderBusy) return;
    state.projectReorderBusy = true;
    try {
      await api(`/api/projects/${projectID}/tasks/order`, {
        method: "PUT",
        body: JSON.stringify({ task_ids: taskIDs })
      });
      await loadAll();
      await refreshProjectDetail();
      toast("\u4EFB\u52A1\u987A\u5E8F\u5DF2\u66F4\u65B0");
    } catch (e5) {
      toast(e5.message, true);
      await refreshProjectDetail();
    } finally {
      state.projectReorderBusy = false;
    }
  }
  async function moveProjectTask(projectID, taskID, direction) {
    if (state.projectReorderBusy) return;
    try {
      const tasks = await api(`/api/tasks?project_id=${projectID}`);
      const ids = queuedProjectTaskIDs(tasks);
      const index = ids.indexOf(taskID);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= ids.length) return;
      [ids[index], ids[target]] = [ids[target], ids[index]];
      await persistProjectTaskOrder(projectID, ids);
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  function startProjectTaskDrag(event, projectID, taskID) {
    if (state.projectReorderBusy) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `${projectID}:${taskID}`);
    event.currentTarget.classList.add("dragging");
  }
  function allowProjectTaskDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    if (state.projectReorderBusy || event.currentTarget.dataset.reorderable !== "true") return;
    event.dataTransfer.dropEffect = "move";
    event.currentTarget.classList.add("drag-over");
  }
  async function dropProjectTask(event, projectID, targetID) {
    event.preventDefault();
    event.stopPropagation();
    document.querySelectorAll(".p-task-row.drag-over").forEach((el) => el.classList.remove("drag-over"));
    if (state.projectReorderBusy) return;
    const raw = event.dataTransfer.getData("text/plain") || "";
    const [sourceProject, sourceID] = raw.split(":").map(Number);
    if (sourceProject !== projectID || !sourceID || sourceID === targetID) return;
    const rows = [...document.querySelectorAll("#pdMain .p-task-row[data-reorderable='true']")];
    const ids = rows.map((row) => Number(row.dataset.taskId)).filter(Boolean);
    const from = ids.indexOf(sourceID);
    const target = ids.indexOf(targetID);
    if (from < 0 || target < 0) return;
    ids.splice(from, 1);
    const targetAfterMove = ids.indexOf(targetID);
    const rect = event.currentTarget.getBoundingClientRect();
    const insertAt = event.clientY < rect.top + rect.height / 2 ? targetAfterMove : targetAfterMove + 1;
    ids.splice(insertAt, 0, sourceID);
    await persistProjectTaskOrder(projectID, ids);
  }
  function endProjectTaskDrag(event) {
    event.currentTarget.classList.remove("dragging");
    document.querySelectorAll(".p-task-row.drag-over").forEach((el) => el.classList.remove("drag-over"));
  }
  function renderProjectDetail(p3, s5, tasks) {
    const main = document.getElementById("pdMain");
    const side = document.getElementById("pdSide");
    if (!main || !side) return;
    const counts = s5.status_counts || [];
    const review = counts.find((c5) => c5.status === "awaiting_review");
    const sourceTasks = tasks.filter((t5) => !isMergeTask(t5)).sort(projectTaskOrder);
    const mergeTasks = tasks.filter(isMergeTask);
    const rowHTML = (items, merge) => {
      const pendingItems = merge ? [] : items.filter((t5) => t5.status === "queued");
      const pendingIndex = new Map(pendingItems.map((t5, i6) => [t5.id, i6]));
      return items.map((t5) => {
        const reorderable = !merge && t5.status === "queued";
        const index = pendingIndex.get(t5.id);
        const orderActions = reorderable && pendingItems.length > 1 ? `
        <span class="task-order-actions" aria-label="\u8C03\u6574\u6267\u884C\u987A\u5E8F">
          <button type="button" class="icon-btn" title="\u4E0A\u79FB" aria-label="\u4E0A\u79FB\u4EFB\u52A1" ${index === 0 ? "disabled" : ""} onclick="event.stopPropagation();moveProjectTask(${p3.id},${t5.id},-1)">${icon("arrowUp")}</button>
          <button type="button" class="icon-btn" title="\u4E0B\u79FB" aria-label="\u4E0B\u79FB\u4EFB\u52A1" ${index === pendingItems.length - 1 ? "disabled" : ""} onclick="event.stopPropagation();moveProjectTask(${p3.id},${t5.id},1)">${icon("arrowDown")}</button>
        </span>` : "";
        return `
    <div class="p-task-row ${merge ? "merge-task-row" : ""} ${reorderable ? "sortable-task-row" : ""}"
      ${reorderable ? `data-task-id="${t5.id}" data-reorderable="true" draggable="true" ondragstart="startProjectTaskDrag(event,${p3.id},${t5.id})" ondragover="allowProjectTaskDrop(event)" ondrop="dropProjectTask(event,${p3.id},${t5.id})" ondragend="endProjectTaskDrag(event)"` : ""}
      onclick="openTask(${t5.id})">
      ${reorderable ? `<span class="task-drag-handle" title="\u62D6\u52A8\u8C03\u6574\u6267\u884C\u987A\u5E8F" aria-label="\u62D6\u52A8\u8C03\u6574\u6267\u884C\u987A\u5E8F">${icon("grip")}</span>` : ""}
      <span class="num">#${t5.id}</span>
      <a class="t card-primary-action" href="#/issue/${t5.id}" onclick="event.stopPropagation();openTask(${t5.id});return false">${esc(t5.title)}</a>
      <span class="task-row-tags">
        ${merge ? `<span class="chip merge">\u5408\u5E76 #${t5.merge_of}</span>` : ""}
        ${merge ? "" : dependencyChip(t5)}
        ${!merge && t5.status === "queued" && dependencyInfo(t5).state === "blocked" ? `<span class="chip dependency blocked" title="${esc(dependencyInfo(t5).reason)}">${esc(dependencyInfo(t5).stateLabel || "\u7B49\u5F85\u524D\u5E8F")}</span>` : ""}
      </span>
      <span class="a">${t5.agent_name ? `<span class="avatar sm">${esc(t5.agent_name.slice(0, 1))}</span>${esc(t5.agent_name)}` : "-"}</span>
      <span class="badge ${t5.status}" style="--st-color:${ST_COLOR[t5.status]}"><span class="st-dot"></span>${STATUS_LABEL[t5.status]}</span>
      ${orderActions}
      <span class="ops">
          ${canRetryTask(t5) ? `<button class="btn xs" onclick="event.stopPropagation();setTaskStatus(${t5.id},'queued')">${icon("retry")}${retryTaskLabel(t5)}</button>` : ""}
        ${canDeleteTask(t5) ? `<button class="btn xs danger" onclick="event.stopPropagation();deleteTask(${t5.id})">${icon("trash")}\u5220\u9664</button>` : ""}
      </span>
    </div>`;
      }).join("");
    };
    const agentsHTML = (s5.agents || []).map((a3) => `
    <tr>
      <td class="t-title"><span class="avatar sm">${esc((a3.agent_name || "?").slice(0, 1))}</span>
        <a class="t-link" href="/roles#/agent/${a3.agent_id}">${esc(a3.agent_name || "\u672A\u6307\u6D3E")}</a></td>
      <td class="num">${a3.total}</td>
      <td class="num" style="color:var(--success)">${a3.succeeded}</td>
      <td class="num" style="color:var(--danger)">${a3.failed}</td>
      <td class="num">${a3.reviews || 0}</td>
      <td class="num">${fmtPct(a3.success_rate)}</td>
      <td class="num">${fmtDur(a3.avg_duration)}</td>
    </tr>`).join("");
    main.innerHTML = `
    <h2>${esc(p3.name)}</h2>
    <div class="detail-id">\u521B\u5EFA\u4E8E ${esc((p3.created_at || "").slice(0, 16).replace("T", " "))}</div>
    ${p3.description ? `<div class="detail-desc">${esc(p3.description)}</div>` : ""}

    <div class="pd-stats">
      <div class="pd-ring">${ringHTML(s5.progress || 0, "\u5B8C\u6210\u5EA6")}</div>
      <div class="pd-chips">
        <div class="stat-chip"><span class="sc-dot" style="background:var(--st-running)"></span><b>${s5.in_flight || 0}</b><span>\u8FDB\u884C\u4E2D</span></div>
        <div class="stat-chip"><span class="sc-dot" style="background:var(--st-review)"></span><b>${review ? review.count : 0}</b><span>\u5F85\u5BA1\u6279</span></div>
        <div class="stat-chip"><span class="sc-dot" style="background:var(--st-done)"></span><b>${s5.succeeded}</b><span>\u5B8C\u6210</span></div>
        <div class="stat-chip"><span class="sc-dot" style="background:var(--st-failed)"></span><b>${s5.failed}</b><span>\u5931\u8D25</span></div>
        <div class="stat-chip"><span class="sc-dot" style="background:var(--fg-muted)"></span><b>${sourceTasks.length}</b><span>\u5B9E\u73B0\u4EFB\u52A1</span></div>
        <div class="stat-chip"><span class="sc-dot" style="background:var(--merge-accent)"></span><b>${mergeTasks.length}</b><span>\u5408\u5E76\u4EFB\u52A1</span></div>
      </div>
    </div>

    <div class="sec-title">\u8FD1 14 \u5929\u5B8C\u6210</div>
    ${dailyChartHTML(s5.daily, 14)}

    <div class="sec-title task-section-title">
      <span>\u4EFB\u52A1 ${sourceTasks.length}</span>
      <span class="section-note">\u5F85\u6267\u884C\u4EFB\u52A1\u53EF\u62D6\u52A8\u6216\u7528\u7BAD\u5934\u8C03\u6574\u987A\u5E8F\uFF0C\u9ED8\u8BA4\u6309\u521B\u5EFA\u65F6\u95F4</span>
      <button class="btn sm brand" onclick="openProjectTask(${p3.id})">${icon("plus")}\u65B0\u5EFA\u4EFB\u52A1</button>
    </div>
    <div class="p-task-list">
      ${rowHTML(sourceTasks, false) || `<div class="empty">\u8FD8\u6CA1\u6709\u4EFB\u52A1
        <button class="btn xs brand" style="margin-left:8px" onclick="openProjectTask(${p3.id})">${icon("plus")}\u6D3E\u6D3B</button></div>`}
    </div>

    <div class="sec-title task-section-title"><span>\u4EE3\u7801\u5408\u5E76 ${mergeTasks.length}</span><span class="section-note">\u7531\u5DF2\u5B8C\u6210\u4EFB\u52A1\u81EA\u52A8\u521B\u5EFA</span></div>
    <div class="p-task-list merge-task-list">
      ${rowHTML(mergeTasks, true) || `<div class="empty">\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1\u4F1A\u5728\u5B9E\u73B0\u4EFB\u52A1\u5B8C\u6210\u6216\u5BA1\u6279\u901A\u8FC7\u540E\u81EA\u52A8\u521B\u5EFA\u3002</div>`}
    </div>

    <div class="sec-title">\u6210\u5458\u7EDF\u8BA1\uFF08\u5728\u672C\u9879\u76EE\u4E0A\u5DE5\u4F5C\u7684 agent\uFF09</div>
    <div class="list-wrap" style="max-height:340px">
      <table class="list-grid">
        <thead><tr><th>\u89D2\u8272</th><th>\u4EFB\u52A1</th><th>\u5B8C\u6210</th><th>\u5931\u8D25</th><th>\u5BA1\u6279\u8F6E\u6B21</th><th>\u6210\u529F\u7387</th><th>\u5E73\u5747\u8017\u65F6</th></tr></thead>
        <tbody>${agentsHTML || `<tr><td colspan="7"><div class="empty">\u5C1A\u65E0\u4EA7\u51FA\u7EDF\u8BA1</div></td></tr>`}</tbody>
      </table>
    </div>`;
    side.innerHTML = `
    <div class="sec-title">\u5C5E\u6027</div>
    <div class="prop-row"><span class="k">\u72B6\u6001</span>
      <span class="v"><select onchange="patchProject(${p3.id},{status:this.value})">
        <option value="active" ${p3.status === "active" ? "selected" : ""}>\u8FDB\u884C\u4E2D</option>
        <option value="archived" ${p3.status === "archived" ? "selected" : ""}>\u5DF2\u5F52\u6863</option>
      </select></span></div>
    <div class="prop-row"><span class="k">\u5DE5\u4F5C\u76EE\u5F55</span><span class="v" style="font-size:12px;word-break:break-all">${esc(p3.project_dir || "-")}</span></div>
    <div class="prop-row"><span class="k">\u63CF\u8FF0</span><span class="v" style="font-size:12px;white-space:pre-wrap">${esc(p3.description || "-")}</span></div>
    <div class="prop-row"><span class="k">\u521B\u5EFA</span><span class="v">${esc((p3.created_at || "").slice(0, 16).replace("T", " "))}</span></div>
    <div class="sec-title">\u64CD\u4F5C</div>
    <div class="detail-actions">
      <button class="btn sm brand" onclick="openProjectTask(${p3.id})">${icon("plus")}\u65B0\u5EFA\u4EFB\u52A1</button>
      <button class="btn sm" onclick="openProjectModal(${p3.id})">\u7F16\u8F91</button>
      <button class="btn sm danger" onclick="deleteProject(${p3.id})">\u5220\u9664</button>
    </div>`;
  }
  function openProjectModal(id) {
    const p3 = id ? state.projects.find((x2) => x2.id === id) : null;
    document.getElementById("projectModalTitle").textContent = p3 ? "\u7F16\u8F91\u9879\u76EE" : "\u65B0\u5EFA\u9879\u76EE";
    document.getElementById("pId").value = p3 ? p3.id : "";
    document.getElementById("pName").value = p3 ? p3.name : "";
    document.getElementById("pDesc").value = p3 ? p3.description || "" : "";
    document.getElementById("pProjectDir").value = p3 ? p3.project_dir || "" : "";
    document.getElementById("pStatus").value = p3 ? p3.status || "active" : "active";
    loadProjDatalist();
    openModal("projectModal");
  }
  async function submitProject() {
    const id = document.getElementById("pId").value;
    const body = {
      name: document.getElementById("pName").value.trim(),
      description: document.getElementById("pDesc").value.trim(),
      project_dir: document.getElementById("pProjectDir").value.trim(),
      status: document.getElementById("pStatus").value
    };
    if (!body.name) return toast("\u9879\u76EE\u540D\u4E0D\u80FD\u4E3A\u7A7A", true);
    try {
      if (id) await api(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api("/api/projects", { method: "POST", body: JSON.stringify(body) });
      closeModal("projectModal");
      await loadAll();
      renderProjectList();
      if (state.projectView) refreshProjectDetail();
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  async function patchProject(id, set) {
    try {
      await api(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(set) });
      await loadAll();
      if (state.projectView === id) refreshProjectDetail();
      renderProjectList();
      toast("\u5DF2\u66F4\u65B0");
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  async function deleteProject(id) {
    if (!id) id = state.projectView;
    if (!id) return;
    if (!confirm("\u5220\u9664\u8BE5\u9879\u76EE\uFF1F\u9879\u76EE\u4E0B\u7684\u4EFB\u52A1\u5C06\u4FDD\u7559\uFF08\u8F6C\u4E3A\u65E0\u9879\u76EE\uFF09\uFF0C\u9879\u76EE\u7EDF\u8BA1\u968F\u4E4B\u6D88\u5931\u3002")) return;
    try {
      await api(`/api/projects/${id}`, { method: "DELETE" });
      toast("\u5DF2\u5220\u9664");
      await loadAll();
      if (state.projectView === id) {
        closeProjectDetail();
      }
      renderProjectList();
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  function dailyChartHTML(daily, days) {
    days = days || 14;
    const map = {};
    (daily || []).forEach((d3) => map[d3.date] = d3.count);
    const vals = Object.values(map);
    const max = Math.max(1, ...vals);
    const out = [];
    for (let i6 = days - 1; i6 >= 0; i6--) {
      const d3 = new Date(Date.now() - i6 * 864e5);
      const key = d3.toISOString().slice(0, 10);
      const c5 = map[key] || 0;
      const today = i6 === 0;
      out.push(`<div class="bc-col ${today ? "today" : ""}" title="${key}: ${c5} \u4E2A\u5B8C\u6210">
      <div class="bc-bar" style="height:${Math.round(c5 / max * 100)}%;${c5 === 0 ? "opacity:.22" : ""}"></div>
      <div class="bc-day">${i6 % 2 === 0 ? key.slice(5) : ""}</div>
    </div>`);
    }
    return `<div class="bar-chart">${out.join("")}</div>`;
  }
  function ringHTML(pct, label) {
    const deg = Math.round(Math.min(100, pct) * 3.6);
    return `<div class="ring" style="background:conic-gradient(var(--brand) ${deg}deg, rgba(255,255,255,.09) 0)">
    <div class="ring-inner"><b>${fmtPct(pct)}</b><span>${label}</span></div>
  </div>`;
  }
  function statusBarHTML(counts) {
    const order = ["queued", "claimed", "running", "awaiting_review", "succeeded", "failed", "cancelled"];
    const total = (counts || []).reduce((a3, c5) => a3 + c5.count, 0);
    if (!total) return `<div class="status-bar"><div class="sb-empty"></div></div>`;
    const segs = [...counts || []].sort((a3, b3) => order.indexOf(a3.status) - order.indexOf(b3.status)).filter((c5) => c5.count > 0).map((c5) => `<div class="sb-seg" title="${STATUS_LABEL[c5.status]}: ${c5.count}" style="width:${c5.count / total * 100}%;background:${ST_COLOR[c5.status]}"></div>`).join("");
    return `<div class="status-bar">${segs}</div>`;
  }
  async function dirLoad(path) {
    try {
      const d3 = await api(`/api/fs/dirs?path=${encodeURIComponent(path || "")}`);
      dirState.path = d3.path;
      const el = document.getElementById("dirCrumb");
      const segs = d3.path.split("/").filter(Boolean);
      let html = `<button type="button" class="crumb-seg" data-p="/" aria-label="\u8FD4\u56DE\u6839\u76EE\u5F55">/</button>`;
      let cur = "";
      segs.forEach((s5, i6) => {
        cur += "/" + s5;
        const last = i6 === segs.length - 1;
        html += `<span class="crumb-sep">/</span>` + (last ? `<span class="crumb-seg cur" aria-current="location">${esc(s5)}</span>` : `<button type="button" class="crumb-seg" data-p="${esc(cur)}">${esc(s5)}</button>`);
      });
      el.innerHTML = html;
      const list = document.getElementById("dirList");
      list.innerHTML = "";
      if (d3.parent !== d3.path) {
        const up = document.createElement("button");
        up.type = "button";
        up.className = "dir-row up";
        up.dataset.path = d3.parent;
        up.innerHTML = icon("back") + `<span>\u4E0A\u4E00\u7EA7</span>`;
        list.appendChild(up);
      }
      d3.dirs.forEach((n6) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "dir-row";
        row.dataset.path = d3.path.replace(/\/+$/, "") + "/" + n6;
        row.innerHTML = icon("folder") + `<span class="dr-name">${esc(n6)}</span>`;
        list.appendChild(row);
      });
      if (!d3.dirs.length) list.innerHTML = `<div class="empty">\u7A7A\u76EE\u5F55</div>`;
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  function openDirPicker(inputId) {
    dirState.inputId = inputId;
    const cur = (document.getElementById(inputId).value || "").trim();
    document.getElementById("dirNewName").value = "";
    dirLoad(cur || "");
    openModal("dirModal");
  }
  function pickDir() {
    const input = document.getElementById(dirState.inputId);
    if (input) input.value = dirState.path;
    closeModal("dirModal");
    toast("\u5DF2\u9009\u62E9\u76EE\u5F55");
  }
  async function mkdirCurrent() {
    const name = document.getElementById("dirNewName").value.trim();
    if (!name) return toast("\u5148\u8F93\u5165\u76EE\u5F55\u540D", true);
    const p3 = dirState.path.replace(/\/+$/, "") + "/" + name;
    try {
      await api("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ path: p3 }) });
      document.getElementById("dirNewName").value = "";
      toast("\u5DF2\u521B\u5EFA");
      dirLoad(dirState.path);
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  async function loadProjDatalist() {
    for (const id of ["dlistProj", "dlistSkill"]) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = "";
    }
    try {
      const d3 = await api("/api/fs/dirs");
      const opts = d3.dirs.map((n6) => `<option value="${esc(d3.path.replace(/\/+$/, "") + "/" + n6)}">`).join("");
      for (const id of ["dlistProj", "dlistSkill"]) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = opts;
      }
    } catch (_2) {
    }
  }
  var dirState;
  var init_projects = __esm({
    "internal/web/static/src/projects.js"() {
      init_core();
      init_main();
      init_task();
      dirState = { inputId: null, path: "" };
    }
  });

  // internal/web/static/src/agents.js
  function normalizeAgentSort(sort) {
    return AGENT_SORT_OPTIONS.some(([value]) => value === sort) ? sort : "name-asc";
  }
  function compareText(a3, b3) {
    return String(a3 || "").localeCompare(String(b3 || ""), "zh-CN", {
      numeric: true,
      sensitivity: "base"
    });
  }
  function compareAgentValues(a3, b3, sort, stats) {
    switch (sort) {
      case "name-asc":
        return compareText(a3.name, b3.name);
      case "name-desc":
        return compareText(b3.name, a3.name);
      case "created-desc":
        return compareText(b3.created_at, a3.created_at);
      case "created-asc":
        return compareText(a3.created_at, b3.created_at);
      case "cli-asc":
        return compareText(a3.cli, b3.cli);
      case "model-asc":
        return compareText(a3.role_config?.model, b3.role_config?.model);
      case "concurrency-desc":
        return (b3.max_concurrency || 1) - (a3.max_concurrency || 1);
      case "concurrency-asc":
        return (a3.max_concurrency || 1) - (b3.max_concurrency || 1);
      case "tasks-desc":
        return stats(b3).total - stats(a3).total;
      case "tasks-asc":
        return stats(a3).total - stats(b3).total;
      case "status-enabled":
        return Number(b3.enabled) - Number(a3.enabled);
      default:
        return 0;
    }
  }
  function sortAgents(list, sort = state.agentSort) {
    const normalized = normalizeAgentSort(sort);
    const stats = /* @__PURE__ */ new Map();
    const getStats = (a3) => {
      if (!stats.has(a3.id)) stats.set(a3.id, agentTaskStats(a3));
      return stats.get(a3.id);
    };
    return [...list].sort((a3, b3) => compareAgentValues(a3, b3, normalized, getStats) || compareText(a3.name, b3.name) || Number(a3.id || 0) - Number(b3.id || 0));
  }
  function setAgentSort(sort) {
    state.agentSort = normalizeAgentSort(sort);
    const select = document.getElementById("agentSort");
    if (select && select.value !== state.agentSort) select.value = state.agentSort;
    try {
      localStorage.setItem("paihuo.agentSort", state.agentSort);
    } catch (_2) {
    }
    renderAgentList();
  }
  function setAgentView(v2) {
    state.agentView = v2;
    const g2 = document.getElementById("segGrid"), t5 = document.getElementById("segTable");
    if (g2) g2.classList.toggle("active", v2 === "grid");
    if (t5) t5.classList.toggle("active", v2 === "table");
    const grid = document.getElementById("agentGrid");
    const wrap = document.getElementById("agentTableWrap");
    if (grid) grid.classList.toggle("hidden", v2 !== "grid");
    if (wrap) wrap.classList.toggle("hidden", v2 !== "table");
    try {
      localStorage.setItem("paihuo.agentView", v2);
    } catch (_2) {
    }
    renderAgentList();
  }
  function agentTaskStats(a3) {
    const ts = state.tasks.filter((t5) => t5.agent_id === a3.id);
    return {
      total: ts.length,
      inFlight: ts.filter((t5) => ["queued", "claimed", "running", "awaiting_review"].includes(t5.status)).length,
      review: ts.filter((t5) => t5.status === "awaiting_review").length
    };
  }
  function filteredAgents() {
    const q = (document.getElementById("aSearch")?.value || "").trim().toLowerCase();
    const list = state.agents.filter((a3) => {
      if (!q) return true;
      const rc = a3.role_config || {};
      return [a3.name, a3.description, a3.cli, rc.model].some((value) => String(value || "").toLowerCase().includes(q));
    });
    return { list: sortAgents(list), query: q };
  }
  function renderAgentEmpty(list, query) {
    const empty = document.getElementById("agentEmpty");
    if (!empty) return;
    if (!list.length) {
      empty.innerHTML = query ? `<b class="empty-title">\u6CA1\u6709\u7B26\u5408\u6761\u4EF6\u7684\u89D2\u8272</b>
        <span class="empty-copy">\u5C1D\u8BD5\u6E05\u9664\u641C\u7D22\u8BCD\uFF0C\u67E5\u770B\u5168\u90E8\u4EFB\u52A1\u89D2\u8272\u3002</span>
        <button type="button" class="btn sm" onclick="document.getElementById('aSearch').value='';renderAgentList()">\u6E05\u9664\u641C\u7D22</button>` : `<b class="empty-title">\u521B\u5EFA\u7B2C\u4E00\u4E2A\u4EFB\u52A1\u89D2\u8272</b>
        <span class="empty-copy">\u89D2\u8272\u628A\u4E00\u4E2A\u672C\u673A CLI\u3001\u6A21\u578B\u3001\u6280\u80FD\u4E0E\u5E76\u53D1\u7B56\u7565\u7EC4\u5408\u4E3A\u53EF\u590D\u7528\u7684\u6267\u884C\u914D\u7F6E\u3002</span>
        <button type="button" class="btn brand sm" onclick="openRoleStudio()">\u521B\u5EFA\u89D2\u8272</button>`;
    }
    empty.classList.toggle("hidden", list.length > 0);
  }
  function agentActionsHTML(a3) {
    return `
    <button class="btn xs" title="\u6253\u5F00\u552F\u4E00\u89D2\u8272\u7F16\u8F91\u5668\uFF0C\u7F16\u8F91\u914D\u7F6E\u5E76\u6D4B\u8BD5\u89D2\u8272" onclick="event.stopPropagation();openRoleStudio(${a3.id})">\u7F16\u8F91</button>
    <button class="btn xs" title="\u590D\u5236\u6B64\u89D2\u8272\u7684\u914D\u7F6E\uFF0C\u521B\u5EFA\u4E00\u4E2A\u65B0\u89D2\u8272" aria-label="\u590D\u5236\u89D2\u8272 ${esc(a3.name)}" onclick="event.stopPropagation();copyRole(${a3.id})">${icon("copy")}\u590D\u5236</button>
    <button class="btn xs" title="${a3.enabled ? "\u505C\u7528" : "\u542F\u7528"}\u89D2\u8272" onclick="event.stopPropagation();toggleAgent(${a3.id})">${a3.enabled ? "\u505C\u7528" : "\u542F\u7528"}</button>
    <button class="btn xs danger" title="\u5220\u9664\u89D2\u8272" aria-label="\u5220\u9664\u89D2\u8272 ${esc(a3.name)}" onclick="event.stopPropagation();deleteAgent(${a3.id})">${icon("trash")}</button>`;
  }
  function renderAgentGrid() {
    const grid = document.getElementById("agentGrid");
    if (!grid) return;
    const { list, query } = filteredAgents();
    grid.innerHTML = list.map((a3) => {
      const rc = a3.role_config || {};
      const st = agentTaskStats(a3);
      return `<article class="agent-card" data-agent-id="${a3.id}" tabindex="0" onclick="openAgentDetail(${a3.id})" onkeydown="if(event.target.closest('a,button'))return;if(event.key==='Enter'||event.key===' '){event.preventDefault();openAgentDetail(${a3.id})}">
      <div class="ac-top">
        <span class="avatar lg av-${esc(a3.cli)}">${esc((a3.name || "?").slice(0, 1))}</span>
        <div class="ac-id">
          <a class="ac-name card-primary-action" href="#/agent/${a3.id}" onclick="event.stopPropagation()">${esc(a3.name)}</a>
          <div class="ac-sub">${esc(a3.description || "\u672A\u8BBE\u7F6E\u63CF\u8FF0")}</div>
        </div>
        <span class="badge ${a3.enabled ? "succeeded" : "cancelled"}">${a3.enabled ? "\u542F\u7528" : "\u505C\u7528"}</span>
      </div>
      <div class="ac-meta">
        <span class="chip">${esc(a3.cli)}</span>
        <span class="chip" title="${esc(rc.model || "\u9ED8\u8BA4\u6A21\u578B")}">${esc(rc.model || "\u9ED8\u8BA4\u6A21\u578B")}</span>
        <span class="chip" title="\u540C\u4E00\u89D2\u8272\u6700\u591A\u540C\u65F6\u8FD0\u884C\u7684\u4EFB\u52A1\u6570">\u5E76\u53D1 ${esc(String(a3.max_concurrency || 1))}</span>
      </div>
      <div class="ac-stats">
        <span><b>${st.total}</b> \u4EFB\u52A1</span>
        <span><b style="color:var(--st-running)">${st.inFlight}</b> \u8FDB\u884C\u4E2D</span>
        <span><b style="color:var(--st-review)">${st.review}</b> \u5F85\u5BA1\u6279</span>
      </div>
      <div class="ac-ops">${agentActionsHTML(a3)}</div>
    </article>`;
    }).join("");
    renderAgentEmpty(list, query);
    const cnt = document.getElementById("agentCount");
    if (cnt) cnt.textContent = `${list.length} \u4E2A\u89D2\u8272`;
  }
  function renderAgentTable() {
    const body = document.getElementById("agentList");
    if (!body) return;
    const { list, query } = filteredAgents();
    body.innerHTML = list.map((a3) => {
      const rc = a3.role_config || {};
      return `<tr class="agent-list-row" tabindex="0" onclick="openAgentDetail(${a3.id})" onkeydown="if(event.target.closest('a,button'))return;if(event.key==='Enter'||event.key===' '){event.preventDefault();openAgentDetail(${a3.id})}">
      <td class="agent-list-identity">
        <span class="agent-list-main">
          <span class="avatar av-${esc(a3.cli)}">${esc((a3.name || "?").slice(0, 1))}</span>
          <span class="agent-list-copy">
            <a class="table-primary-action" href="#/agent/${a3.id}" onclick="event.stopPropagation()">${esc(a3.name)}</a>
            <span class="agent-list-description">${esc(a3.description || "\u672A\u8BBE\u7F6E\u63CF\u8FF0")}</span>
          </span>
        </span>
      </td>
      <td class="agent-list-cli" data-label="CLI"><span class="badge">${esc(a3.cli)}</span></td>
      <td class="agent-list-model" data-label="\u6A21\u578B">${esc(rc.model || "\u9ED8\u8BA4")}</td>
      <td class="agent-list-concurrency num" data-label="\u6700\u5927\u5E76\u53D1">${esc(String(a3.max_concurrency || 1))}</td>
      <td class="agent-list-status" data-label="\u72B6\u6001"><span class="badge ${a3.enabled ? "succeeded" : "cancelled"}">${a3.enabled ? "\u542F\u7528" : "\u505C\u7528"}</span></td>
      <td class="agent-list-actions" data-label="\u64CD\u4F5C">
        <span class="ops">${agentActionsHTML(a3)}</span>
      </td>
    </tr>`;
    }).join("");
    renderAgentEmpty(list, query);
    const cnt = document.getElementById("agentCount");
    if (cnt) cnt.textContent = `${list.length} \u4E2A\u89D2\u8272`;
  }
  function renderAgentList() {
    state.agentView === "grid" ? renderAgentGrid() : renderAgentTable();
  }
  async function refreshAgentCatalog() {
    const btn = document.getElementById("refreshAgentCatalog");
    const original = btn ? btn.innerHTML : "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "\u68C0\u6D4B\u4E2D\u2026";
    }
    try {
      await loadSchema(true);
      toast("\u5DF2\u4ECE Linux \u4E3B\u673A\u5237\u65B0\u6A21\u578B\u4E0E\u80FD\u529B\u76EE\u5F55");
    } catch (e5) {
      toast("\u5237\u65B0\u4E3B\u673A\u80FD\u529B\u5931\u8D25\uFF1A" + e5.message, true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = original;
      }
    }
  }
  async function toggleAgent(id) {
    const a3 = state.agents.find((x2) => x2.id === id);
    if (!a3) return;
    try {
      await api(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: !a3.enabled }) });
      await loadAll();
      renderAgentList();
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  function openAgentDetail(id) {
    location.hash = "#/agent/" + id;
  }
  function closeAgentDetail() {
    location.hash = "#/";
  }
  function showAgentDetail(id) {
    const a3 = state.agents.find((x2) => x2.id === id);
    if (!a3) return;
    state.agentEditing = a3;
    document.getElementById("agentListShell").classList.add("hidden");
    document.getElementById("agentDetailShell").classList.remove("hidden");
    document.getElementById("adCrumb").innerHTML = `\u89D2\u8272 / <b>${esc(a3.name)}</b>`;
    const docs = state.schema[a3.cli]?.docs;
    document.getElementById("adCliDocs").innerHTML = `<span class="badge">${esc(a3.cli)}</span> ${docs ? `<a class="t-link" target="_blank" rel="noreferrer" href="${esc(docs)}">\u5B98\u65B9\u6587\u6863 \u2197</a>` : ""}`;
    agentTab("overview");
  }
  function hideAgentDetail() {
    document.getElementById("agentDetailShell").classList.add("hidden");
    document.getElementById("agentListShell").classList.remove("hidden");
    state.agentEditing = null;
  }
  function agentTab(name) {
    if (name !== "overview" && name !== "stats") name = "overview";
    state.agentTab = name;
    document.querySelectorAll("#agentTabs button").forEach((b3) => b3.classList.toggle("active", b3.dataset.tab === name));
    const a3 = state.agentEditing;
    if (!a3) return;
    const form = document.getElementById("agentForm");
    if (name === "overview") renderAgentOverview(a3);
    else if (name === "stats") renderAgentStats(a3);
  }
  async function loadAgentStats(a3) {
    if (!state.agentStats[a3.id]) {
      try {
        state.agentStats[a3.id] = await api(`/api/stats/agent/${a3.id}`);
      } catch (_2) {
      }
    }
    return state.agentStats[a3.id];
  }
  async function renderAgentOverview(a3) {
    const form = document.getElementById("agentForm");
    if (!form) return;
    const st = await loadAgentStats(a3);
    if (state.agentTab !== "overview") return;
    form.innerHTML = `
    <div class="agent-hero">
      <span class="avatar lg av-${esc(a3.cli)}">${esc((a3.name || "?").slice(0, 1))}</span>
      <div>
        <div class="ah-name">${esc(a3.name)} <span class="badge">${esc(a3.cli)}</span>
          <span class="badge ${a3.enabled ? "succeeded" : "cancelled"}">${a3.enabled ? "\u542F\u7528" : "\u505C\u7528"}</span></div>
        ${a3.description ? `<div class="ah-desc">${esc(a3.description)}</div>` : ""}
        <div class="ah-sub">\u6267\u884C\u6C60\uFF1A
          <input id="aMaxConc" class="conc-input" type="number" min="1" step="1" inputmode="numeric"
            value="${esc(String(a3.max_concurrency || 1))}" aria-label="\u6700\u5927\u5E76\u53D1"
            onkeydown="if(event.key==='Enter'&&!event.isComposing){event.preventDefault();saveAgentConcurrency()}">
          \u4E2A\u4EFB\u52A1
          <button class="btn xs primary" onclick="saveAgentConcurrency()">\u66F4\u65B0\u5E76\u53D1</button>
          <span class="count-info">\u540C\u65F6\u6700\u591A\u8FD0\u884C\u7684\u4EFB\u52A1\u6570\uFF0C\u6BCF\u4E2A\u4EFB\u52A1\u72EC\u5360 tmux/\u4F1A\u8BDD/Git worktree</span>
        </div>
      </div>
    </div>
    ${st ? `
      <div class="pd-stats">
        <div class="pd-chips">
          <div class="stat-chip"><span class="sc-dot" style="background:var(--st-running)"></span><b>${st.in_flight}</b><span>\u8FDB\u884C\u4E2D</span></div>
          <div class="stat-chip"><span class="sc-dot" style="background:var(--st-done)"></span><b>${st.succeeded}</b><span>\u5B8C\u6210</span></div>
          <div class="stat-chip"><span class="sc-dot" style="background:var(--st-failed)"></span><b>${st.failed}</b><span>\u5931\u8D25</span></div>
          <div class="stat-chip"><span class="sc-dot" style="background:var(--st-cancel)"></span><b>${st.cancelled}</b><span>\u53D6\u6D88</span></div>
          <div class="stat-chip"><span class="sc-dot" style="background:var(--st-done)"></span><b>${fmtPct(st.success_rate)}</b><span>\u6210\u529F\u7387</span></div>
          <div class="stat-chip"><span class="sc-dot" style="background:var(--fg-muted)"></span><b>${fmtDur(st.avg_duration)}</b><span>\u5E73\u5747\u8017\u65F6</span></div>
        </div>
      </div>
      <div class="sec-title">\u8FD1 14 \u5929\u5B8C\u6210</div>
      ${dailyChartHTML(st.daily, 14)}
      ${st.projects && st.projects.length ? `
        <div class="sec-title">\u5206\u9879\u76EE\u4EA7\u51FA</div>
        <div class="list-wrap" style="max-height:260px">
          <table class="list-grid">
            <thead><tr><th>\u9879\u76EE</th><th>\u4EFB\u52A1</th><th>\u5B8C\u6210</th><th>\u5931\u8D25</th><th>\u5BA1\u6279\u8F6E\u6B21</th><th>\u6210\u529F\u7387</th><th>\u5E73\u5747\u8017\u65F6</th></tr></thead>
            <tbody>${st.projects.map((ps) => `
              <tr ${ps.project_id > 0 ? `onclick="openProject(${ps.project_id})"` : ""}>
                <td><a class="t-link" href="/projects#/project/${ps.project_id}">${esc(ps.project_name || "\u672A\u547D\u540D")}</a></td>
                <td class="num">${ps.total}</td>
                <td class="num" style="color:var(--success)">${ps.succeeded}</td>
                <td class="num" style="color:var(--danger)">${ps.failed}</td>
                <td class="num">${ps.reviews || 0}</td>
                <td class="num">${fmtPct(ps.success_rate)}</td>
                <td class="num">${fmtDur(ps.avg_duration)}</td>
              </tr>`).join("")}</tbody>
          </table>
        </div>` : ""}
    ` : `<div class="empty">\u6682\u65E0\u7EDF\u8BA1</div>`}
    <div class="sec-title">\u6700\u8FD1\u4EFB\u52A1</div>
    <div id="agentRecent"></div>`;
    try {
      const recent = await api(`/api/tasks?agent_id=${a3.id}&limit=8`);
      const box = document.getElementById("agentRecent");
      if (box) {
        box.innerHTML = recent.map((t5) => `
        <div class="p-task-row" onclick="openTask(${t5.id})">
          <span class="num">#${t5.id}</span>
          <a class="t card-primary-action" href="#/issue/${t5.id}" onclick="event.stopPropagation();openTask(${t5.id});return false">${esc(t5.title)}</a>
          <span class="a">${esc(t5.project_name || "-")}</span>
          <span class="badge ${t5.status}" style="--st-color:${ST_COLOR[t5.status]}"><span class="st-dot"></span>${STATUS_LABEL[t5.status]}</span>
        </div>`).join("") || `<div class="empty">\u8FD8\u6CA1\u6709\u4EFB\u52A1</div>`;
      }
    } catch (_2) {
    }
  }
  async function renderAgentStats(a3) {
    const form = document.getElementById("agentForm");
    if (!form) return;
    form.innerHTML = `<div class="empty">\u52A0\u8F7D\u7EDF\u8BA1\u4E2D...</div>`;
    const st = await loadAgentStats(a3);
    if (state.agentTab !== "stats") return;
    if (!st) {
      form.innerHTML = `<div class="empty">\u7EDF\u8BA1\u4E0D\u53EF\u7528</div>`;
      return;
    }
    form.innerHTML = `
    <div class="sec-title">\u72B6\u6001\u5206\u5E03\uFF08${st.total} \u4E2A\u4EFB\u52A1\uFF09</div>
    <div class="sb-wrap">${statusBarHTML(st.status_counts)}
      <div class="sb-legend">
        ${(st.status_counts || []).map((c5) => `<span class="sb-item"><i style="background:${ST_COLOR[c5.status]}"></i>${STATUS_LABEL[c5.status]} ${c5.count}</span>`).join("")}
      </div></div>
    <div class="sec-title">\u8FD1 14 \u5929\u5B8C\u6210</div>
    ${dailyChartHTML(st.daily, 14)}
    <div class="sec-title">\u5206\u9879\u76EE\u4EA7\u51FA\uFF08\u7EF4\u5EA6\u4E8C\uFF1Aagent \u7EDF\u8BA1\uFF09</div>
    <div class="list-wrap">
      <table class="list-grid">
        <thead><tr><th>\u9879\u76EE</th><th>\u4EFB\u52A1</th><th>\u5B8C\u6210</th><th>\u5931\u8D25</th><th>\u5BA1\u6279\u8F6E\u6B21</th><th>\u6210\u529F\u7387</th><th>\u5E73\u5747\u8017\u65F6</th></tr></thead>
        <tbody>${(st.projects || []).map((ps) => `
          <tr>
            <td><a class="t-link" href="/projects#/project/${ps.project_id}">${esc(ps.project_name || "\u672A\u547D\u540D")}</a></td>
            <td class="num">${ps.total}</td>
            <td class="num" style="color:var(--success)">${ps.succeeded}</td>
            <td class="num" style="color:var(--danger)">${ps.failed}</td>
            <td class="num">${ps.reviews || 0}</td>
            <td class="num">${fmtPct(ps.success_rate)}</td>
            <td class="num">${fmtDur(ps.avg_duration)}</td>
          </tr>`).join("") || `<tr><td colspan="7"><div class="empty">\u6682\u65E0\u4EA7\u51FA</div></td></tr>`}</tbody>
      </table>
    </div>`;
  }
  function fieldValue(f4, rc) {
    if (f4.builtin) {
      const v2 = rc[f4.key];
      if (f4.type === "list") return Array.isArray(v2) ? (v2 || []).join(",") : v2 ?? "";
      if (f4.type === "env") return Object.entries(v2 || {}).map(([k2, val]) => `${k2}=${val}`).join("\n");
      if (Array.isArray(v2)) return (v2 || []).join(" ");
      return v2 ?? f4.default ?? "";
    }
    return rc.custom && rc.custom[f4.key] != null ? rc.custom[f4.key] : f4.default ?? "";
  }
  function chipHTML(key, p3) {
    return `<span class="chip-item" data-v="${esc(p3)}"><span class="ci-text">${esc(p3)}</span><button type="button" class="chip-x" onclick="removeChip('${key}', this)" aria-label="\u79FB\u9664">\xD7</button></span>`;
  }
  function chipEditorValue(el) {
    const box = el.closest(".chip-editor");
    return { box, hidden: box.querySelector('input[type="hidden"]') };
  }
  function syncChips(box, key) {
    const h4 = box.querySelector('input[type="hidden"]');
    const items = h4.value ? h4.value.split(",") : [];
    const row = box.querySelector(".chips");
    if (row) row.innerHTML = items.map((p3) => chipHTML(key, p3)).join("");
    if (box.querySelector(".skill-opts")) {
      box.querySelectorAll(".skill-opts input[type=checkbox]").forEach((cb) => cb.checked = items.includes(cb.dataset.v));
    }
  }
  function addChip(key, input) {
    const v2 = (input.value || "").trim();
    if (!v2) return;
    const { box, hidden } = chipEditorValue(input);
    const items = hidden.value ? hidden.value.split(",") : [];
    if (!items.includes(v2)) {
      items.push(v2);
      hidden.value = items.join(",");
    }
    syncChips(box, key);
    input.value = "";
    input.focus();
  }
  function removeChip(key, btn) {
    const chip = btn.closest(".chip-item");
    if (!chip) return;
    const { box, hidden } = chipEditorValue(btn);
    const items = hidden.value ? hidden.value.split(",") : [];
    const i6 = items.indexOf(chip.dataset.v);
    if (i6 >= 0) items.splice(i6, 1);
    hidden.value = items.join(",");
    syncChips(box, key);
  }
  function toggleSkill(key, cb) {
    const { box, hidden } = chipEditorValue(cb);
    const items = hidden.value ? hidden.value.split(",") : [];
    const v2 = cb.dataset.v;
    if (cb.checked) {
      if (!items.includes(v2)) items.push(v2);
    } else {
      const i6 = items.indexOf(v2);
      if (i6 >= 0) items.splice(i6, 1);
    }
    hidden.value = items.join(",");
    syncChips(box, key);
  }
  function filterSkillOptions(control) {
    const box = control?.closest?.(".chip-editor");
    if (!box) return;
    const tag = box.querySelector("[data-skill-tag-filter]")?.value || "";
    const query = (box.querySelector("[data-skill-search]")?.value || "").trim().toLocaleLowerCase();
    box.querySelectorAll(".skill-opt").forEach((option) => {
      const tags = (option.dataset.tags || "").split("|").filter(Boolean);
      const text = option.dataset.search || "";
      const matchesTag = !tag || (tag === "__untagged__" ? tags.length === 0 : tags.includes(tag.toLocaleLowerCase()));
      option.hidden = !matchesTag || !!query && !text.includes(query);
    });
  }
  function selectVisibleSkills(key) {
    const box = document.querySelector(`.chip-editor [data-key="${key}"]`)?.closest(".chip-editor");
    if (!box) return;
    const hidden = /* @__PURE__ */ new Set();
    box.querySelectorAll(".skill-opt").forEach((o7) => {
      if (o7.hidden) hidden.add(o7.dataset.v);
    });
    const add = [...box.querySelectorAll(".skill-opt input:checked")].map((i6) => i6.dataset.v);
    box.querySelectorAll(".skill-opt").forEach((o7) => {
      if (!hidden.has(o7.dataset.v)) {
        const cb = o7.querySelector("input");
        if (cb && !cb.checked) {
          cb.checked = true;
          add.push(o7.dataset.v);
        }
      }
    });
    const input = box.querySelector("input[data-type=list]");
    if (input) input.value = [...new Set(add)].join(",");
  }
  function clearSkillSelection(key) {
    const box = document.querySelector(`.chip-editor [data-key="${key}"]`)?.closest(".chip-editor");
    if (!box) return;
    box.querySelectorAll(".skill-opt input:checked").forEach((cb) => cb.checked = false);
    const input = box.querySelector("input[data-type=list]");
    if (input) input.value = "";
  }
  function skillsControlHTML(f4, val) {
    const items = val ? String(val).split(",").map((s5) => s5.trim()).filter(Boolean) : [];
    const lib = state.skillLib || [];
    const tagMap = /* @__PURE__ */ new Map();
    lib.forEach((s5) => (Array.isArray(s5.tags) ? s5.tags : []).forEach((tag) => {
      const key = String(tag).trim().toLocaleLowerCase();
      if (key && !tagMap.has(key)) tagMap.set(key, String(tag).trim());
    }));
    const tagOptions = [...tagMap.entries()].sort((a3, b3) => a3[1].localeCompare(b3[1])).map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`).join("");
    const hasUntagged = lib.some((s5) => !(Array.isArray(s5.tags) && s5.tags.length));
    const opts = lib.map((s5) => {
      const on = items.includes(s5.dir);
      const rawTags = (Array.isArray(s5.tags) ? s5.tags : []).map(String).map((tag) => tag.trim()).filter(Boolean);
      const tags = rawTags.map((tag) => tag.toLocaleLowerCase());
      const search = [s5.name, s5.description, ...rawTags].join(" ").toLocaleLowerCase();
      return `<label class="skill-opt" data-tags="${esc(tags.join("|"))}" data-search="${esc(search)}"><input type="checkbox" data-v="${esc(s5.dir)}" ${on ? "checked" : ""} onchange="toggleSkill('${f4.key}', this)"><span class="skill-opt-copy" title="${esc(s5.description || s5.dir)}"><span class="skill-opt-name">${esc(s5.name)}</span>${rawTags.length ? `<small>${rawTags.map((tag) => esc(tag)).join(" \xB7 ")}</small>` : `<small>\u672A\u5206\u7C7B</small>`}</span></label>`;
    }).join("");
    return `<div class="chip-editor">
    <input type="hidden" data-key="${f4.key}" data-type="list" value="${esc(items.join(","))}">
    <div class="chips">${items.map((p3) => chipHTML(f4.key, p3)).join("")}</div>
    <div class="skill-filter-row">
      <label>\u6309\u6807\u7B7E
        <select data-skill-tag-filter onchange="filterSkillOptions(this)">
          <option value="">\u5168\u90E8\u6807\u7B7E</option>${tagOptions}${hasUntagged ? `<option value="__untagged__">\u672A\u5206\u7C7B</option>` : ""}
        </select>
      </label>
      <input data-skill-search placeholder="\u641C\u7D22\u6280\u80FD\u540D\u79F0\u6216\u8BF4\u660E" oninput="filterSkillOptions(this)">
    </div>
    <div class="skill-opts">${opts || `<div class="empty">\u6280\u80FD\u5E93\u4E3A\u7A7A\uFF1A\u5230 Skills \u9875\u6DFB\u52A0\u6280\u80FD\uFF08\u542B SKILL.md \u7684\u76EE\u5F55\uFF09</div>`}</div>
    <div class="chip-add">
      <button type="button" class="btn xs" onclick="selectVisibleSkills('${f4.key}')">\u5168\u9009\u5F53\u524D\u7B5B\u9009</button>
      <button type="button" class="btn xs" onclick="clearSkillSelection('${f4.key}')">\u6E05\u7A7A\u6280\u80FD</button>
    </div>
    <div class="chip-add">
      <input placeholder="\u81EA\u5B9A\u4E49\u6280\u80FD\u76EE\u5F55\u8DEF\u5F84\uFF0C\u56DE\u8F66\u6DFB\u52A0" onkeydown="if(event.key==='Enter'){event.preventDefault();addChip('${f4.key}', this)}">
      <button type="button" class="btn xs" onclick="addChip('${f4.key}', this.previousElementSibling)">\u6DFB\u52A0</button>
    </div>
  </div>`;
  }
  function chipsControlHTML(f4, val) {
    const items = val ? String(val).split(",").map((s5) => s5.trim()).filter(Boolean) : [];
    return `<div class="chip-editor">
    <input type="hidden" data-key="${f4.key}" data-type="list" value="${esc(items.join(","))}">
    <div class="chips">${items.map((p3) => chipHTML(f4.key, p3)).join("")}</div>
    <div class="chip-add">
      <input placeholder="${esc(f4.placeholder || "\u56DE\u8F66\u6DFB\u52A0")}" onkeydown="if(event.key==='Enter'){event.preventDefault();addChip('${f4.key}', this)}">
      <button type="button" class="btn xs" onclick="addChip('${f4.key}', this.previousElementSibling)">\u6DFB\u52A0</button>
    </div>
  </div>`;
  }
  function selectOptionsHTML(options, val) {
    const current = String(val ?? "");
    const values = Array.isArray(options) ? options.map(String) : [];
    const legacy = current !== "" && !values.includes(current);
    if (legacy) values.push(current);
    return values.map((o7) => {
      const label = o7 === "" ? "\u9ED8\u8BA4" : legacy && o7 === current ? `${o7}\uFF08\u5F53\u524D\u4FDD\u5B58\u503C\uFF09` : o7;
      return `<option value="${esc(o7)}" ${current === o7 ? "selected" : ""}>${esc(label)}</option>`;
    }).join("");
  }
  function syncModelThinking(input) {
    const scope = input.closest("#rsSchema");
    const select = scope && scope.querySelector('select[data-key="thinking"][data-thinking-options]');
    if (!select) return;
    let byModel = {}, fallback = [];
    try {
      byModel = JSON.parse(select.dataset.thinkingOptions || "{}");
    } catch (_2) {
    }
    try {
      fallback = JSON.parse(select.dataset.fallbackOptions || "[]");
    } catch (_2) {
    }
    const model = String(input.value || "").trim();
    const hasModel = Object.prototype.hasOwnProperty.call(byModel, model);
    let options = hasModel && Array.isArray(byModel[model]) ? byModel[model] : fallback;
    if (hasModel && Array.isArray(fallback) && fallback.includes("") && !options.includes("")) options = ["", ...options];
    const current = select.value;
    const next = Array.isArray(options) && options.map(String).includes(current) ? current : "";
    select.innerHTML = selectOptionsHTML(options, next);
  }
  function fieldControlHTML(f4, rc, selectedModel = "") {
    const val = fieldValue(f4, rc);
    let attrs = `data-key="${f4.key}" data-type="${f4.type}"`;
    const hasModelThinking = f4.key === "thinking" && f4.thinking_options_by_model;
    if (hasModelThinking) {
      attrs += ` data-thinking-options="${esc(JSON.stringify(f4.thinking_options_by_model))}"`;
      let fallbackOptions = f4.options || [];
      if (Array.isArray(f4.thinking_options_by_model[""])) {
        fallbackOptions = f4.thinking_options_by_model[""];
        if (Array.isArray(f4.options) && f4.options.includes("") && !fallbackOptions.includes("")) {
          fallbackOptions = ["", ...fallbackOptions];
        }
      }
      attrs += ` data-fallback-options="${esc(JSON.stringify(fallbackOptions))}"`;
    }
    let ctl = "";
    if (f4.type === "select") {
      let options = f4.options || [];
      if (hasModelThinking && Array.isArray(f4.thinking_options_by_model[selectedModel])) {
        options = f4.thinking_options_by_model[selectedModel];
        if ((f4.options || []).includes("") && !options.includes("")) options = ["", ...options];
      }
      ctl = `<select ${attrs}>${selectOptionsHTML(options, val)}</select>`;
    } else if (f4.type === "textarea") {
      ctl = `<textarea ${attrs} rows="5" placeholder="${esc(f4.placeholder || "")}">${esc(val)}</textarea>`;
    } else if (f4.type === "env") {
      ctl = `<textarea ${attrs} rows="6" placeholder="${esc(f4.placeholder || "")}">${esc(val)}</textarea>`;
    } else if (f4.type === "list" && f4.source === "skills") {
      ctl = skillsControlHTML(f4, val);
    } else if (f4.type === "list") {
      ctl = chipsControlHTML(f4, val);
    } else if (f4.suggestions && f4.suggestions.length) {
      const dl = "dl_" + ++dlSeq;
      const sync = f4.key === "model" ? ` oninput="syncModelThinking(this)" onchange="syncModelThinking(this)"` : "";
      ctl = `<input ${attrs} list="${dl}" value="${esc(val)}" placeholder="${esc(f4.placeholder || "")}"${sync}><datalist id="${dl}">${f4.suggestions.map((s5) => `<option value="${esc(s5)}">`).join("")}</datalist>`;
    } else {
      const sync = f4.key === "model" ? ` oninput="syncModelThinking(this)" onchange="syncModelThinking(this)"` : "";
      ctl = `<input ${attrs} value="${esc(val)}" placeholder="${esc(f4.placeholder || "")}"${sync}>`;
    }
    return `<div class="schema-field">
    <label class="field">${esc(f4.label)}${ctl}</label>
    ${f4.help ? `<div class="field-help">${esc(f4.help)}</div>` : ""}
  </div>`;
  }
  function schemaFormHTML(schema, rc) {
    const groups = {};
    const fields = schema.fields || [];
    const model = fields.find((f4) => f4.key === "model");
    const selectedModel = model ? String(fieldValue(model, rc) || "") : "";
    fields.forEach((f4) => {
      (groups[f4.group] = groups[f4.group] || []).push(f4);
    });
    return Object.entries(groups).map(([g2, fs]) => `
    <div class="schema-group">
      <div class="schema-group-title">${esc(g2)}</div>
      <div class="schema-group-body">${fs.map((f4) => fieldControlHTML(f4, rc, selectedModel)).join("")}</div>
    </div>`).join("");
  }
  function readConfigFrom(schema, container) {
    const cfg = { custom: {} };
    (schema.fields || []).forEach((f4) => {
      const el = container.querySelector(`[data-key="${f4.key}"]`);
      if (!el) return;
      const val = el.value;
      if (f4.type === "env") {
        if (f4.builtin) cfg.env = parseEnv(val);
        else cfg.custom[f4.key] = val;
        return;
      }
      if (f4.type === "list") {
        const arr = val.split(",").map((s5) => s5.trim()).filter(Boolean);
        if (f4.builtin) cfg[f4.key] = arr;
        else cfg.custom[f4.key] = arr.join(",");
        return;
      }
      if (f4.builtin && f4.key === "extra_args") {
        cfg.extra_args = val.split(/\s+/).filter(Boolean);
        return;
      }
      if (f4.builtin) cfg[f4.key] = val;
      else cfg.custom[f4.key] = val;
    });
    return cfg;
  }
  async function saveAgentConcurrency() {
    const a3 = state.agentEditing;
    if (!a3) return;
    const n6 = Number(document.getElementById("aMaxConc")?.value);
    if (!Number.isInteger(n6) || n6 < 1) return toast("\u6700\u5927\u5E76\u53D1\u5FC5\u987B\u662F\u81F3\u5C11\u4E3A 1 \u7684\u6574\u6570", true);
    if (n6 === (a3.max_concurrency || 1)) return;
    try {
      await api(`/api/agents/${a3.id}`, { method: "PATCH", body: JSON.stringify({ max_concurrency: n6 }) });
      toast(`\u5E76\u53D1\u5DF2\u66F4\u65B0\u4E3A ${n6}`);
      await loadAll();
      showAgentDetail(a3.id);
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  async function deleteAgent(id) {
    if (!id) id = state.agentEditing?.id;
    if (!id) return;
    if (!confirm("\u5220\u9664\u8BE5\u89D2\u8272\uFF1F\u672A\u5B8C\u6210\u4EFB\u52A1\u5C06\u5931\u53BB\u6307\u6D3E\uFF0C\u5386\u53F2\u4EFB\u52A1\u4FDD\u7559\u3002")) return;
    try {
      await api(`/api/agents/${id}`, { method: "DELETE" });
      await loadAll();
      renderAgentList();
      if (state.agentEditing && state.agentEditing.id === id) closeAgentDetail();
      toast("\u5DF2\u5220\u9664");
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  function parseEnv(text) {
    const env = {};
    text.split("\n").forEach((line) => {
      const i6 = line.indexOf("=");
      if (i6 > 0) env[line.slice(0, i6).trim()] = line.slice(i6 + 1).trim();
    });
    return env;
  }
  var dlSeq, AGENT_SORT_OPTIONS;
  var init_agents = __esm({
    "internal/web/static/src/agents.js"() {
      init_core();
      init_main();
      init_projects();
      init_task();
      dlSeq = 0;
      AGENT_SORT_OPTIONS = [
        ["name-asc", "\u540D\u79F0 A-Z"],
        ["name-desc", "\u540D\u79F0 Z-A"],
        ["created-desc", "\u6700\u8FD1\u521B\u5EFA"],
        ["created-asc", "\u6700\u65E9\u521B\u5EFA"],
        ["cli-asc", "CLI A-Z"],
        ["model-asc", "\u6A21\u578B A-Z"],
        ["concurrency-desc", "\u6700\u5927\u5E76\u53D1\uFF1A\u9AD8\u5230\u4F4E"],
        ["concurrency-asc", "\u6700\u5927\u5E76\u53D1\uFF1A\u4F4E\u5230\u9AD8"],
        ["tasks-desc", "\u4EFB\u52A1\u6570\uFF1A\u591A\u5230\u5C11"],
        ["tasks-asc", "\u4EFB\u52A1\u6570\uFF1A\u5C11\u5230\u591A"],
        ["status-enabled", "\u542F\u7528\u72B6\u6001\u4F18\u5148"]
      ];
    }
  });

  // internal/web/static/src/provision.js
  async function loadProvision() {
    try {
      provState.prov = await api("/api/provision");
    } catch (_2) {
      provState.prov = [];
    }
    renderProvGrid();
  }
  function renderProvGrid() {
    const grid = document.getElementById("provGrid");
    if (!grid) return;
    const empty = document.getElementById("provEmpty");
    if (empty) empty.classList.add("hidden");
    grid.innerHTML = provState.prov.map((p3) => `
    <div class="prov-card ${p3.installed ? "" : "not-installed"}">
      <div class="pc-top">
        <span class="avatar lg av-${esc(p3.id)}">${esc((p3.name || "?").slice(0, 1))}</span>
        <div class="ac-id">
          <div class="ac-name">${esc(p3.name)}</div>
          <div class="ac-sub">
            ${p3.installed ? `<span class="badge succeeded">\u5DF2\u5B89\u88C5</span>` : `<span class="badge cancelled">\u672A\u5B89\u88C5</span>`}
            ${p3.installed ? `<span class="badge ${p3.login ? "succeeded" : "awaiting_review"}">${p3.login ? "\u5DF2\u767B\u5F55" : "\u672A\u767B\u5F55"}</span>` : ""}
          </div>
        </div>
        ${p3.installed ? `<span class="prov-ver">${esc(p3.version)}</span>` : ""}
      </div>
      <div class="prov-body">
        ${!p3.installed ? `<div class="prov-cmd" title="\u5B98\u65B9\u5B89\u88C5\u547D\u4EE4">$ ${esc(p3.install_cmd || "\uFF08\u8BF7\u53C2\u8003\u5B98\u65B9\u6587\u6863\uFF09")}</div>` : p3.login ? `<div class="prov-login-ok">\u5DF2\u68C0\u6D4B\u5230\u767B\u5F55\u51ED\u636E \u2713</div>` : `<div class="prov-login-hint">${esc(p3.login_hint || "\u8BF7\u5728\u670D\u52A1\u5668\u7EC8\u7AEF\u5B8C\u6210\u767B\u5F55")}</div>`}
      </div>
      <div class="ac-stats prov-actions">
        ${!p3.installed ? `<button class="btn sm brand" onclick="installProvision('${p3.id}')">\u5B89\u88C5</button>` : `<button class="btn sm" onclick="installProvision('${p3.id}')">\u91CD\u88C5/\u66F4\u65B0</button>`}
        <a class="btn sm ghost" href="${esc(p3.docs)}" target="_blank" rel="noreferrer">\u5B98\u65B9\u6587\u6863 \u2197</a>
        ${p3.installed ? `<button class="btn sm" onclick="copyText('${esc(p3.login_hint || "")}')">\u590D\u5236\u767B\u5F55\u6307\u5F15</button>` : ""}
        ${p3.installed ? `<button class="btn sm" onclick="createDefaultRole('${p3.id}')">\u521B\u5EFA\u9ED8\u8BA4\u89D2\u8272</button>` : ""}
      </div>
    </div>`).join("");
    const cnt = document.getElementById("provCount");
    if (cnt) cnt.textContent = `\u5DF2\u5B89\u88C5 ${provState.prov.filter((p3) => p3.installed).length}/${provState.prov.length}`;
  }
  async function installProvision(cli) {
    provState.instCli = cli;
    const box = document.getElementById("instBox");
    const title = document.getElementById("instTitle");
    box.innerHTML = `<div class="empty">\u6B63\u5728\u542F\u52A8\u5B89\u88C5...</div>`;
    title.textContent = `\u5B89\u88C5 ${cli}`;
    openModal("instModal");
    try {
      const r6 = await api("/api/provision/install", { method: "POST", body: JSON.stringify({ cli }) });
      setTimeout(loadProvision, 3e3);
    } catch (e5) {
      box.innerHTML = `<div class="empty">${esc(e5.message)}</div>`;
      provState.instCli = null;
    }
  }
  function appendInstLine(line) {
    const box = document.getElementById("instBox");
    if (!box) return;
    const c5 = line.startsWith("$") ? "sys" : "out";
    box.insertAdjacentHTML("beforeend", `<div class="line"><span class="c ${c5}">${esc(line)}</span></div>`);
    box.scrollTop = box.scrollHeight;
  }
  function closeInstTerminal() {
    provState.instCli = null;
    closeModal("instModal");
  }
  function refreshProvision() {
    loadProvision();
  }
  function copyText(t5) {
    navigator.clipboard.writeText(t5).then(() => toast("\u5DF2\u590D\u5236")).catch(() => toast("\u590D\u5236\u5931\u8D25", true));
  }
  async function createDefaultRole(cli) {
    const name = prompt(`\u521B\u5EFA\u57FA\u4E8E ${cli} \u7684\u9ED8\u8BA4\u89D2\u8272\u540D\u79F0`, cli);
    if (!name) return;
    try {
      await api("/api/agents", { method: "POST", body: JSON.stringify({ name, cli, enabled: true }) });
      toast("\u5DF2\u521B\u5EFA\u89D2\u8272\uFF0C\u53EF\u5728\u89D2\u8272\u9875\u7EE7\u7EED\u5B9A\u5236");
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  var provState;
  var init_provision = __esm({
    "internal/web/static/src/provision.js"() {
      init_core();
      provState = { prov: [], instCli: null };
    }
  });

  // internal/web/static/src/role_studio.js
  function clone(value) {
    return JSON.parse(JSON.stringify(value ?? {}));
  }
  function firstEnabledAgent(excludeID = 0) {
    return state.agents.find((a3) => a3.enabled && a3.id !== excludeID) || state.agents.find((a3) => a3.enabled) || state.agents[0] || null;
  }
  function blankDraft() {
    const cli = Object.keys(state.schema || {})[0] || state.agents[0]?.cli || "";
    return { name: "", description: "", cli, max_concurrency: 1, role_config: {} };
  }
  function draftFromAgent(agent) {
    return {
      name: agent?.name || "",
      description: agent?.description || "",
      cli: agent?.cli || Object.keys(state.schema || {})[0] || "",
      max_concurrency: agent?.max_concurrency || 1,
      role_config: clone(agent?.role_config || {})
    };
  }
  function nextRoleCopyName(agent) {
    const source = String(agent?.name || "\u672A\u547D\u540D\u89D2\u8272").trim() || "\u672A\u547D\u540D\u89D2\u8272";
    const base = `${source}\uFF08\u526F\u672C\uFF09`;
    const names = new Set(state.agents.map((a3) => String(a3.name || "").trim()));
    if (!names.has(base)) return base;
    for (let n6 = 2; n6 < 1e4; n6++) {
      const candidate = `${source}\uFF08\u526F\u672C ${n6}\uFF09`;
      if (!names.has(candidate)) return candidate;
    }
    return `${source}\uFF08\u526F\u672C ${Date.now()}\uFF09`;
  }
  function createStudioState({ draft, agentID = 0, agentEnabled = true, excludeAgentID = 0, mode = "create", sourceAgentName = "" }) {
    const creator = firstEnabledAgent(excludeAgentID);
    return {
      agentID,
      agentEnabled,
      creatorAgentID: creator?.id || 0,
      draft,
      baseDraft: clone(draft),
      creatorMessages: [],
      testMessages: [],
      busy: false,
      testBusy: false,
      mode,
      sourceAgentName
    };
  }
  function studioState() {
    return state.roleStudio;
  }
  function currentDraftFromForm(options = {}) {
    const s5 = studioState();
    if (!s5) return null;
    const draft = clone(s5.draft);
    draft.name = String(document.getElementById("rsName")?.value || "").trim();
    draft.description = String(document.getElementById("rsDescription")?.value || "").trim();
    draft.cli = String(document.getElementById("rsCli")?.value || draft.cli || "");
    draft.max_concurrency = Number(document.getElementById("rsMaxConcurrency")?.value || 1);
    const schema = state.schema[options.formCLI || draft.cli];
    const form = document.getElementById("rsSchema");
    draft.role_config = schema && form ? readConfigFrom(schema, form) : clone(draft.role_config || {});
    if (!Number.isInteger(draft.max_concurrency) || draft.max_concurrency < 1) draft.max_concurrency = 1;
    return draft;
  }
  function roleStudioMessageHTML(message) {
    const role = message.role === "user" ? "user" : "assistant";
    return `<article class="rs-message ${role}">
    <div class="rs-message-label">${role === "user" ? "\u4F60" : "\u521B\u5EFA\u52A9\u624B"}</div>
    <div class="rs-message-body">${esc(message.content || "").replace(/\n/g, "<br>")}</div>
  </article>`;
  }
  function testMessageHTML(message) {
    const role = message.role === "user" ? "user" : "assistant";
    return `<article class="rs-message ${role}">
    <div class="rs-message-label">${role === "user" ? "\u6D4B\u8BD5\u8F93\u5165" : "\u88AB\u521B\u5EFA Agent"}</div>
    <div class="rs-message-body">${esc(message.content || "").replace(/\n/g, "<br>")}</div>
  </article>`;
  }
  function renderStudioMessages() {
    const s5 = studioState();
    if (!s5) return;
    const creator = document.getElementById("rsCreatorChat");
    const test = document.getElementById("rsTestChat");
    if (creator) {
      creator.innerHTML = s5.creatorMessages.length ? s5.creatorMessages.map(roleStudioMessageHTML).join("") : `<div class="rs-chat-empty"><span class="rs-empty-mark">\u2726</span><b>\u63CF\u8FF0\u4F60\u60F3\u521B\u5EFA\u7684\u89D2\u8272</b><span>\u521B\u5EFA\u52A9\u624B\u4F1A\u5206\u6790\u76EE\u6807\u3001\u63A8\u8350 Skills\uFF0C\u5E76\u628A\u53EF\u6D4B\u8BD5\u7684\u914D\u7F6E\u653E\u5230\u4E2D\u95F4\u3002</span></div>`;
      creator.scrollTop = creator.scrollHeight;
    }
    if (test) {
      test.innerHTML = s5.testMessages.length ? s5.testMessages.map(testMessageHTML).join("") : `<div class="rs-chat-empty"><span class="rs-empty-mark">\u25CC</span><b>\u5148\u7ED9\u89D2\u8272\u4E00\u4E2A\u5C0F\u4EFB\u52A1</b><span>\u6D4B\u8BD5\u7ED3\u679C\u4F1A\u4FDD\u7559\u5728\u8FD9\u91CC\uFF0C\u521B\u5EFA\u52A9\u624B\u53EF\u4EE5\u8BFB\u53D6\u5E76\u7EE7\u7EED\u8C03\u6574\u8349\u7A3F\u3002</span></div>`;
      test.scrollTop = test.scrollHeight;
    }
  }
  function renderCreatorSelect() {
    const s5 = studioState();
    const select = document.getElementById("rsCreatorAgent");
    if (!s5 || !select) return;
    const candidates = state.agents.filter((a3) => a3.enabled || a3.id === s5.creatorAgentID);
    select.innerHTML = candidates.length ? candidates.map((a3) => `<option value="${a3.id}" ${a3.id === s5.creatorAgentID ? "selected" : ""}>${esc(a3.name)} \xB7 ${esc(a3.cli)}</option>`).join("") : `<option value="">\u6682\u65E0\u53EF\u7528\u89D2\u8272</option>`;
    select.disabled = !candidates.length;
    select.onchange = () => {
      s5.creatorAgentID = Number(select.value) || 0;
    };
  }
  function renderStudioDiff() {
    const s5 = studioState();
    const box = document.getElementById("rsDiffBody");
    if (!s5 || !box) return;
    const now = JSON.stringify(s5.draft);
    const base = JSON.stringify(s5.baseDraft);
    if (now === base) {
      box.innerHTML = `<span class="rs-diff-empty">\u5C1A\u672A\u4FEE\u6539</span>`;
      return;
    }
    const rows = [];
    const fields = [
      ["name", "\u540D\u79F0"],
      ["description", "\u63CF\u8FF0"],
      ["cli", "CLI"],
      ["max_concurrency", "\u6700\u5927\u5E76\u53D1"]
    ];
    fields.forEach(([key, label]) => {
      const before = s5.baseDraft?.[key] ?? "";
      const after = s5.draft?.[key] ?? "";
      if (String(before) !== String(after)) rows.push(`<div><b>${label}</b><span class="old">${esc(String(before || "\u672A\u8BBE\u7F6E"))}</span><span class="arrow">\u2192</span><span class="new">${esc(String(after || "\u672A\u8BBE\u7F6E"))}</span></div>`);
    });
    const oldCfg = s5.baseDraft?.role_config || {};
    const newCfg = s5.draft?.role_config || {};
    ["model", "system_prompt", "instructions", "thinking", "skills"].forEach((key) => {
      if (JSON.stringify(oldCfg[key] ?? "") !== JSON.stringify(newCfg[key] ?? "")) {
        const oldValue = Array.isArray(oldCfg[key]) ? `${oldCfg[key].length} \u9879` : String(oldCfg[key] || "\u672A\u8BBE\u7F6E");
        const newValue = Array.isArray(newCfg[key]) ? `${newCfg[key].length} \u9879` : String(newCfg[key] || "\u672A\u8BBE\u7F6E");
        rows.push(`<div><b>${esc(key)}</b><span class="old">${esc(oldValue)}</span><span class="arrow">\u2192</span><span class="new">${esc(newValue)}</span></div>`);
      }
    });
    box.innerHTML = rows.length ? rows.join("") : `<span class="rs-diff-empty">\u914D\u7F6E\u6709\u53D8\u5316</span>`;
  }
  function renderStudioDraft() {
    const s5 = studioState();
    if (!s5) return;
    const d3 = s5.draft;
    const title = document.getElementById("roleStudioTitle");
    if (title) {
      title.textContent = s5.mode === "copy" ? `\u590D\u5236\uFF1A${s5.sourceAgentName || d3.name}` : s5.agentID ? `\u7F16\u8F91\uFF1A${d3.name}` : "\u521B\u5EFA\u89D2\u8272";
    }
    const status = document.getElementById("roleStudioStatus");
    if (status) status.textContent = s5.mode === "copy" ? "\u590D\u5236\u8349\u7A3F \xB7 \u672A\u4FDD\u5B58" : s5.agentID ? "\u7F16\u8F91\u8349\u7A3F \xB7 \u672A\u53D1\u5E03" : "\u65B0\u89D2\u8272\u8349\u7A3F \xB7 \u672A\u4FDD\u5B58";
    const name = document.getElementById("rsName");
    const desc = document.getElementById("rsDescription");
    const conc = document.getElementById("rsMaxConcurrency");
    if (name) name.value = d3.name || "";
    if (desc) desc.value = d3.description || "";
    if (conc) conc.value = d3.max_concurrency || 1;
    const cli = document.getElementById("rsCli");
    if (cli) {
      cli.innerHTML = Object.values(state.schema || {}).map((schema2) => `<option value="${esc(schema2.id)}">${esc(schema2.name)}</option>`).join("");
      cli.value = d3.cli;
    }
    const schema = state.schema[d3.cli];
    const schemaBox = document.getElementById("rsSchema");
    if (schemaBox) schemaBox.innerHTML = schema ? schemaFormHTML(schema, d3.role_config || {}) : `<div class="empty">CLI schema \u672A\u52A0\u8F7D</div>`;
    const badge = document.getElementById("rsDraftBadge");
    if (badge) badge.textContent = JSON.stringify(s5.baseDraft) === JSON.stringify(d3) ? "\u672A\u4FEE\u6539" : "\u6709\u672A\u4FDD\u5B58\u4FEE\u6539";
    const skillCount = Array.isArray(d3.role_config?.skills) ? d3.role_config.skills.length : 0;
    const note = document.getElementById("rsSkillNote");
    if (note) note.textContent = skillCount ? `\u8FD0\u884C\u65F6\u4F1A\u542F\u7528 ${skillCount} \u4E2A\u89D2\u8272 Skills` : "\u5C1A\u672A\u9009\u62E9\u89D2\u8272 Skills";
    const meta = document.getElementById("rsTestMeta");
    if (meta) meta.innerHTML = `<span class="avatar sm av-${esc(d3.cli)}">${esc((d3.name || "?").slice(0, 1))}</span><span><b>${esc(d3.name || "\u672A\u547D\u540D\u89D2\u8272")}</b><small>${esc(d3.cli || "\u672A\u9009\u62E9 CLI")} \xB7 \u4F7F\u7528\u5F53\u524D\u8349\u7A3F\u6D4B\u8BD5</small></span>`;
    renderStudioDiff();
    renderStudioMessages();
  }
  async function openRoleStudio(id) {
    const agent = id ? state.agents.find((a3) => a3.id === id) : null;
    if (id && !agent) return toast("\u89D2\u8272\u4E0D\u5B58\u5728", true);
    await loadSchema();
    await loadSkillLib();
    const existing = state.roleStudio;
    if (!existing || existing.agentID !== (agent?.id || 0)) {
      const draft = agent ? draftFromAgent(agent) : blankDraft();
      state.roleStudio = createStudioState({
        draft,
        agentID: agent?.id || 0,
        agentEnabled: agent?.enabled ?? true,
        excludeAgentID: agent?.id || 0,
        mode: agent ? "edit" : "create"
      });
    }
    renderCreatorSelect();
    renderStudioDraft();
    openModal("roleStudioModal");
  }
  async function copyRole(id) {
    const agent = state.agents.find((a3) => a3.id === id);
    if (!agent) return toast("\u89D2\u8272\u4E0D\u5B58\u5728", true);
    await loadSchema();
    await loadSkillLib();
    const draft = draftFromAgent(agent);
    draft.name = nextRoleCopyName(agent);
    state.roleStudio = createStudioState({
      draft,
      agentEnabled: true,
      excludeAgentID: agent.id,
      mode: "copy",
      sourceAgentName: agent.name
    });
    renderCreatorSelect();
    renderStudioDraft();
    openModal("roleStudioModal");
  }
  function openCurrentRoleEditor() {
    const id = state.agentEditing?.id;
    if (id) openRoleStudio(id);
  }
  function copyCurrentRole() {
    const id = state.agentEditing?.id;
    return id ? copyRole(id) : Promise.resolve();
  }
  function changeRoleStudioCli() {
    const s5 = studioState();
    if (!s5) return;
    const previousCLI = String(s5.draft?.cli || "");
    const nextCLI = String(document.getElementById("rsCli")?.value || "");
    const current = currentDraftFromForm({ formCLI: previousCLI });
    if (!current) return;
    const oldCfg = current.role_config || {};
    current.cli = nextCLI;
    if (!nextCLI || nextCLI === previousCLI) {
      s5.draft = current;
      renderStudioDraft();
      return;
    }
    current.role_config = {
      system_prompt: oldCfg.system_prompt || "",
      instructions: oldCfg.instructions || "",
      skills: Array.isArray(oldCfg.skills) ? oldCfg.skills : []
    };
    s5.draft = current;
    renderStudioDraft();
  }
  function roleStudioQuickAsk(message) {
    const input = document.getElementById("rsCreatorInput");
    if (!input) return;
    input.value = message;
    sendRoleStudioChat();
  }
  async function sendRoleStudioChat(event) {
    event?.preventDefault?.();
    const s5 = studioState();
    const input = document.getElementById("rsCreatorInput");
    const message = String(input?.value || "").trim();
    if (!s5 || !message || s5.busy) return;
    s5.draft = currentDraftFromForm();
    const creator = state.agents.find((a3) => a3.id === s5.creatorAgentID);
    if (!creator) return toast("\u8BF7\u5148\u521B\u5EFA\u5E76\u542F\u7528\u4E00\u4E2A\u89D2\u8272\u4F5C\u4E3A\u521B\u5EFA\u52A9\u624B", true);
    s5.creatorMessages.push({ role: "user", content: message });
    if (input) input.value = "";
    s5.busy = true;
    setStudioBusy("rsCreatorState", true, "\u5206\u6790\u4E2D\u2026");
    renderStudioMessages();
    try {
      const result = await api("/api/role-studio/chat", {
        method: "POST",
        body: JSON.stringify({
          creator_agent_id: s5.creatorAgentID,
          draft: s5.draft,
          message,
          creator_messages: s5.creatorMessages.slice(0, -1),
          test_messages: s5.testMessages
        })
      });
      if (result?.draft) {
        s5.draft = result.draft;
        renderStudioDraft();
      }
      s5.creatorMessages.push({ role: "assistant", content: result?.message || "\u521B\u5EFA\u52A9\u624B\u6CA1\u6709\u8FD4\u56DE\u8BF4\u660E\u3002" });
    } catch (e5) {
      s5.creatorMessages.push({ role: "assistant", content: `\u8C03\u7528\u521B\u5EFA\u52A9\u624B\u5931\u8D25\uFF1A${e5.message}` });
    } finally {
      s5.busy = false;
      setStudioBusy("rsCreatorState", false, "\u5F85\u547D");
      renderStudioMessages();
    }
  }
  async function sendRoleStudioTest(event) {
    event?.preventDefault?.();
    const s5 = studioState();
    const input = document.getElementById("rsTestInput");
    const message = String(input?.value || "").trim();
    if (!s5 || !message || s5.testBusy) return;
    s5.draft = currentDraftFromForm();
    if (!s5.draft.cli) return toast("\u8BF7\u5148\u9009\u62E9\u88AB\u521B\u5EFA Agent \u7684 CLI", true);
    s5.testMessages.push({ role: "user", content: message });
    if (input) input.value = "";
    s5.testBusy = true;
    setStudioBusy("rsTestState", true, "\u6267\u884C\u4E2D\u2026");
    renderStudioDraft();
    try {
      const result = await api("/api/role-studio/test", {
        method: "POST",
        body: JSON.stringify({ draft: s5.draft, message, test_messages: s5.testMessages.slice(0, -1) })
      });
      s5.testMessages.push({ role: "assistant", content: result?.output || "\u88AB\u521B\u5EFA Agent \u6CA1\u6709\u8FD4\u56DE\u5185\u5BB9\u3002" });
    } catch (e5) {
      s5.testMessages.push({ role: "assistant", content: `\u6D4B\u8BD5\u6267\u884C\u5931\u8D25\uFF1A${e5.message}` });
    } finally {
      s5.testBusy = false;
      setStudioBusy("rsTestState", false, "\u6D4B\u8BD5\u6A21\u5F0F");
      renderStudioMessages();
    }
  }
  function setStudioBusy(id, busy, text) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = text;
      el.classList.toggle("running", busy);
    }
    ["rsCreatorInput", "rsTestInput"].forEach((inputID) => {
      const input = document.getElementById(inputID);
      if (input && (inputID === "rsCreatorInput" && id === "rsCreatorState" || inputID === "rsTestInput" && id === "rsTestState")) input.disabled = busy;
    });
  }
  async function saveRoleStudio() {
    const s5 = studioState();
    if (!s5) return;
    const draft = currentDraftFromForm();
    if (!draft.name) return toast("\u89D2\u8272\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A", true);
    if (!draft.cli) return toast("\u8BF7\u9009\u62E9\u89D2\u8272 CLI", true);
    const body = {
      name: draft.name,
      description: draft.description,
      cli: draft.cli,
      max_concurrency: draft.max_concurrency,
      enabled: s5.agentEnabled,
      role_config: draft.role_config
    };
    const save = document.querySelector("#roleStudioModal .role-studio-head-actions .primary");
    if (save) {
      save.disabled = true;
      save.textContent = "\u4FDD\u5B58\u4E2D\u2026";
    }
    try {
      const result = s5.agentID ? await api(`/api/agents/${s5.agentID}`, { method: "PATCH", body: JSON.stringify(body) }) : await api("/api/agents", { method: "POST", body: JSON.stringify(body) });
      closeModal("roleStudioModal");
      state.roleStudio = null;
      await loadAll();
      const detailVisible = !document.getElementById("agentDetailShell")?.classList.contains("hidden");
      if (s5.mode === "copy" && detailVisible && result?.id) {
        showAgentDetail(result.id);
        openAgentDetail(result.id);
      } else if (s5.agentID && detailVisible) showAgentDetail(s5.agentID);
      else {
        if (detailVisible) hideAgentDetail();
        renderAgentList();
      }
      toast(s5.mode === "copy" ? `\u89D2\u8272\u526F\u672C\u5DF2\u521B\u5EFA\uFF1A${result?.name || draft.name}` : s5.agentID ? "\u89D2\u8272\u8349\u7A3F\u5DF2\u4FDD\u5B58" : `\u89D2\u8272\u5DF2\u521B\u5EFA\uFF1A${result?.name || draft.name}`);
    } catch (e5) {
      toast(`\u4FDD\u5B58\u89D2\u8272\u5931\u8D25\uFF1A${e5.message}`, true);
    } finally {
      if (save) {
        save.disabled = false;
        save.textContent = "\u4FDD\u5B58\u89D2\u8272";
      }
    }
  }
  var init_role_studio = __esm({
    "internal/web/static/src/role_studio.js"() {
      init_core();
      init_main();
      init_agents();
      init_skills();
    }
  });

  // internal/web/static/src/schedules.js
  function renderScheduleList() {
    const body = document.getElementById("scheduleList");
    if (!body) return;
    body.innerHTML = state.schedules.map((sc) => `
    <tr>
      <td class="t-name"><b>${esc(sc.name)}</b></td>
      <td><span class="cron-chip">${icon("clock")}${esc(scheduleLabel(sc.cron))}</span></td>
      <td>${esc(sc.agent_name || "-")}</td>
      <td>${sc.project_id ? `<span class="chip" title="\u9879\u76EE\u5B9A\u65F6\u4EFB\u52A1\uFF1A\u521B\u5EFA\u540E\u6309\u9879\u76EE\u987A\u5E8F\u6267\u884C">\u9879\u76EE \xB7 ${esc(sc.project_name || "#" + sc.project_id)}</span>${sc.block_on_failure ? `<span class="chip merge-blocked">\u5931\u8D25\u963B\u585E</span>` : ""}` : `<span class="chip">\u901A\u7528</span>`}</td>
      <td class="t-tpl">${esc(sc.title_template || "-")}</td>
      <td class="num">${esc((sc.last_run_at || "-").slice(0, 16).replace("T", " "))}</td>
      <td><label class="sw" title="${sc.enabled ? "\u505C\u7528" : "\u542F\u7528"}"><input type="checkbox" ${sc.enabled ? "checked" : ""} onchange="toggleSchedule(${sc.id})"><span class="sw-slider"></span></label></td>
      <td>
        <span class="ops">
          <button class="btn xs" onclick="openScheduleModal(${sc.id})">\u7F16\u8F91</button>
          <button class="btn xs danger" onclick="deleteSchedule(${sc.id})">\u5220\u9664</button>
        </span>
      </td>
    </tr>`).join("");
    const empty = document.getElementById("scheduleEmpty");
    if (empty) empty.classList.toggle("hidden", state.schedules.length > 0);
  }
  function parseScheduleCron(cron) {
    const raw = String(cron || "").trim().toLowerCase();
    if (raw === "@daily") return { frequency: "daily", time: "00:00" };
    if (raw === "@weekly") return { frequency: "weekly", weekday: "7", time: "00:00" };
    if (raw === "@monthly") return { frequency: "monthly", monthday: "1", time: "00:00" };
    const fields = raw.split(/\s+/);
    if (fields.length !== 5 && fields.length !== 6) return null;
    const [second, minute, hour, dom, month, dow] = fields.length === 6 ? fields : ["0", fields[0], fields[1], fields[2], fields[3], fields[4]];
    if (second !== "0" || month !== "*") return null;
    if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
    const minuteNum = Number(minute), hourNum = Number(hour);
    if (minuteNum < 0 || minuteNum > 59 || hourNum < 0 || hourNum > 23) return null;
    const time = `${String(hourNum).padStart(2, "0")}:${String(minuteNum).padStart(2, "0")}`;
    if (dom === "*" && dow === "*") return { frequency: "daily", time };
    if (dom === "*" && dow === "1-5") return { frequency: "weekdays", time };
    if (dom === "*" && /^\d$/.test(dow) && Number(dow) >= 0 && Number(dow) <= 7) {
      return { frequency: "weekly", weekday: String(Number(dow) === 0 ? 7 : Number(dow)), time };
    }
    if (dow === "*" && /^\d{1,2}$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) {
      return { frequency: "monthly", monthday: String(Number(dom)), time };
    }
    return null;
  }
  function scheduleCronFromFields() {
    const time = document.getElementById("sTime")?.value || "";
    const match = /^(\d{2}):(\d{2})$/.exec(time);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return "";
    const frequency = document.getElementById("sFrequency")?.value || "daily";
    const minute = Number(match[2]);
    const hour = Number(match[1]);
    let dom = "*", dow = "*";
    if (frequency === "weekdays") dow = "1-5";
    if (frequency === "weekly") {
      const weekday = Number(document.getElementById("sWeekday")?.value || 1);
      dow = weekday === 7 ? "0" : String(weekday);
    }
    if (frequency === "monthly") dom = String(Number(document.getElementById("sMonthday")?.value || 1));
    return `0 ${minute} ${hour} ${dom} * ${dow}`;
  }
  function scheduleLabel(cron) {
    const parsed = parseScheduleCron(cron);
    if (!parsed) return "\u81EA\u5B9A\u4E49\u5468\u671F";
    if (parsed.frequency === "daily") return `\u6BCF\u5929 ${parsed.time}`;
    if (parsed.frequency === "weekdays") return `\u5DE5\u4F5C\u65E5 ${parsed.time}`;
    if (parsed.frequency === "weekly") return `\u6BCF\u5468${WEEKDAYS[Number(parsed.weekday)] || ""} ${parsed.time}`;
    return `\u6BCF\u6708${parsed.monthday}\u65E5 ${parsed.time}`;
  }
  function fillScheduleDays() {
    const select = document.getElementById("sMonthday");
    if (!select || select.options.length) return;
    select.innerHTML = Array.from({ length: 31 }, (_2, i6) => `<option value="${i6 + 1}">${i6 + 1} \u65E5</option>`).join("");
  }
  function updateSchedulePreview() {
    const preview = document.getElementById("sSchedulePreview");
    if (!preview) return;
    if (scheduleUnsupported && !scheduleDirty) {
      preview.textContent = "\u5F53\u524D\u4EFB\u52A1\u4F7F\u7528\u4E86\u81EA\u5B9A\u4E49\u5468\u671F\uFF1B\u8C03\u6574\u4E0A\u9762\u7684\u9009\u9879\u540E\u4F1A\u8F6C\u6362\u4E3A\u5E38\u7528\u5468\u671F\u3002";
      preview.classList.add("warning");
      return;
    }
    preview.classList.remove("warning");
    preview.textContent = `\u5C06\u6309\u201C${scheduleLabel(scheduleCronFromFields())}\u201D\u6267\u884C`;
  }
  function syncScheduleFields(markDirty = true) {
    if (markDirty) scheduleDirty = true;
    const frequency = document.getElementById("sFrequency")?.value || "daily";
    document.getElementById("sWeekdayField")?.classList.toggle("hidden", frequency !== "weekly");
    document.getElementById("sMonthdayField")?.classList.toggle("hidden", frequency !== "monthly");
    updateSchedulePreview();
  }
  async function toggleSchedule(id) {
    const sc = state.schedules.find((x2) => x2.id === id);
    try {
      await api(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: !sc.enabled }) });
      await loadAll();
      renderScheduleList();
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  function openScheduleModal(id) {
    fillSelects();
    fillScheduleDays();
    const sc = id ? state.schedules.find((x2) => x2.id === id) : null;
    document.getElementById("scheduleModalTitle").textContent = sc ? "\u7F16\u8F91\u5B9A\u65F6\u4EFB\u52A1" : "\u65B0\u5EFA\u5B9A\u65F6\u4EFB\u52A1";
    document.getElementById("sId").value = sc ? sc.id : "";
    document.getElementById("sName").value = sc ? sc.name : "";
    const parsed = parseScheduleCron(sc?.cron);
    scheduleOriginalCron = sc?.cron || "";
    scheduleUnsupported = !!sc && !parsed;
    scheduleDirty = false;
    document.getElementById("sFrequency").value = parsed?.frequency || "daily";
    document.getElementById("sWeekday").value = parsed?.weekday || "1";
    document.getElementById("sMonthday").value = parsed?.monthday || "1";
    document.getElementById("sTime").value = parsed?.time || DEFAULT_TIME;
    syncScheduleFields(false);
    document.getElementById("sTitle").value = sc ? sc.title_template : "";
    document.getElementById("sBody").value = sc ? sc.body_template : "";
    document.getElementById("sPerm").value = sc ? sc.perm || "full" : "full";
    document.getElementById("sProject").value = sc && sc.project_id ? sc.project_id : "";
    document.getElementById("sBlockOnFailure").checked = !!sc?.block_on_failure;
    if (sc) document.getElementById("sAgent").value = sc.agent_id;
    openModal("scheduleModal");
  }
  async function submitSchedule() {
    const id = document.getElementById("sId").value;
    const cron = scheduleUnsupported && !scheduleDirty ? scheduleOriginalCron : scheduleCronFromFields();
    if (!cron) return toast("\u8BF7\u9009\u62E9\u6709\u6548\u7684\u6267\u884C\u65F6\u95F4", true);
    const body = {
      name: document.getElementById("sName").value.trim(),
      cron,
      title_template: document.getElementById("sTitle").value.trim(),
      body_template: document.getElementById("sBody").value,
      agent_id: Number(document.getElementById("sAgent").value),
      project_id: Number(document.getElementById("sProject").value) || null,
      perm: document.getElementById("sPerm").value,
      block_on_failure: document.getElementById("sBlockOnFailure").checked
    };
    try {
      if (id) await api(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api("/api/schedules", { method: "POST", body: JSON.stringify({ ...body, enabled: true }) });
      closeModal("scheduleModal");
      await loadAll();
      renderScheduleList();
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  async function deleteSchedule(id) {
    if (!confirm("\u5220\u9664\u8BE5\u5B9A\u65F6\u4EFB\u52A1\uFF1F")) return;
    try {
      await api(`/api/schedules/${id}`, { method: "DELETE" });
      await loadAll();
      renderScheduleList();
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  var WEEKDAYS, DEFAULT_TIME, scheduleOriginalCron, scheduleUnsupported, scheduleDirty;
  var init_schedules = __esm({
    "internal/web/static/src/schedules.js"() {
      init_core();
      init_main();
      WEEKDAYS = ["", "\u5468\u4E00", "\u5468\u4E8C", "\u5468\u4E09", "\u5468\u56DB", "\u5468\u4E94", "\u5468\u516D", "\u5468\u65E5"];
      DEFAULT_TIME = "09:00";
      scheduleOriginalCron = "";
      scheduleUnsupported = false;
      scheduleDirty = false;
    }
  });

  // internal/web/static/src/settings.js
  async function loadSettings() {
    try {
      const s5 = await api("/api/settings");
      const el = document.getElementById("retentionDays");
      if (el) el.value = s5.retention_days || "";
      const wt = document.getElementById("wtRetentionDays");
      if (wt) wt.value = s5.worktree_retention_days || "";
    } catch (_2) {
    }
  }
  async function saveWtRetention() {
    try {
      const days = document.getElementById("wtRetentionDays").value.trim();
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ worktree_retention_days: days }) });
      toast("\u5DF2\u4FDD\u5B58\uFF0C\u6BCF\u5C0F\u65F6\u81EA\u52A8\u6E05\u7406\u4E00\u6B21");
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  async function saveRetention() {
    try {
      const days = document.getElementById("retentionDays").value.trim();
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ retention_days: days }) });
      toast("\u5DF2\u4FDD\u5B58\uFF0C\u6BCF\u5C0F\u65F6\u6267\u884C\u4E00\u6B21\u81EA\u52A8\u6E05\u7406");
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  async function runCleanup() {
    const agentId = Number(document.getElementById("cleanupAgent").value) || null;
    const days = Number(document.getElementById("cleanupDays").value);
    const before = days > 0 ? new Date(Date.now() - days * 864e5).toISOString() : "";
    if (!confirm(`\u5220\u9664${agentId ? "\u8BE5\u89D2\u8272" : "\u5168\u90E8\u89D2\u8272"}${before ? "\u3001" + days + " \u5929\u524D" : ""}\u7684\u7EC8\u6001\u4EFB\u52A1\uFF1F\u4E0D\u53EF\u6062\u590D\uFF01`)) return;
    try {
      const r6 = await api("/api/tasks/cleanup", { method: "POST", body: JSON.stringify({ agent_id: agentId, before }) });
      toast(`\u5DF2\u5220\u9664 ${r6.deleted} \u6761\u5386\u53F2`);
      await loadAll();
    } catch (e5) {
      toast(e5.message, true);
    }
  }
  var init_settings = __esm({
    "internal/web/static/src/settings.js"() {
      init_core();
      init_main();
    }
  });

  // internal/web/static/src/main.js
  async function loadAll() {
    const [tasks, agents, schedules, projects] = await Promise.all([
      api("/api/tasks"),
      api("/api/agents"),
      api("/api/schedules"),
      api("/api/projects")
    ]);
    state.tasks = tasks;
    state.agents = agents;
    state.schedules = schedules;
    state.projects = projects;
    fillSelects();
  }
  async function loadSchema(forceRefresh = false) {
    try {
      const list = forceRefresh ? await api("/api/agents/schema/refresh", { method: "POST" }) : await api("/api/agents/schema");
      state.schema = {};
      list.forEach((s5) => state.schema[s5.id] = s5);
      const sel = document.getElementById("aCli");
      const previous = sel ? sel.value : "";
      if (sel) {
        sel.innerHTML = list.map((s5) => `<option value="${s5.id}">${esc(s5.name)}</option>`).join("");
        sel.value = state.schema[previous] ? previous : list.length ? list[0].id : "";
      }
      return true;
    } catch (e5) {
      if (forceRefresh) throw e5;
      return false;
    }
  }
  function fillSelects() {
    const opts = (a3) => a3.map((x2) => `<option value="${x2.id}">${esc(x2.name)}</option>`).join("");
    const enOpts = state.agents.filter((a3) => a3.enabled);
    for (const id of ["tAgent", "sAgent"]) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = (id === "tAgent" ? `<option value="">\u4E0D\u6307\u6D3E</option>` : "") + opts(enOpts);
    }
    for (const id of ["fAgent", "hAgent", "cleanupAgent"]) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<option value="">\u5168\u90E8\u89D2\u8272</option>` + opts(state.agents);
    }
    const pOpts = state.projects.map((p3) => `<option value="${p3.id}">${esc(p3.name)}</option>`).join("");
    for (const id of ["fProject", "tProject", "sProject"]) {
      const el = document.getElementById(id);
      if (!el) continue;
      const empty = id === "fProject" ? "\u5168\u90E8\u9879\u76EE" : id === "sProject" ? "\u65E0\u9879\u76EE\uFF08\u901A\u7528\u5B9A\u65F6\u4EFB\u52A1\uFF09" : "\u65E0\u9879\u76EE";
      el.innerHTML = `<option value="">${empty}</option>` + pOpts;
    }
    const cnt = document.getElementById("sbBoardCount");
    if (cnt) cnt.textContent = state.tasks.filter((t5) => ["queued", "claimed", "running", "awaiting_review"].includes(t5.status)).length;
    const pc = document.getElementById("sbProjectCount");
    if (pc) pc.textContent = state.projects.filter((p3) => p3.status === "active").length || "";
  }
  async function refreshOverview() {
    try {
      state.overview = await api("/api/stats/overview");
    } catch (_2) {
      return;
    }
    renderStatsStrip();
  }
  function renderStatsStrip() {
    const el = document.getElementById("dashStats");
    if (!el) return;
    const o7 = state.overview;
    if (!o7) {
      el.innerHTML = "";
      return;
    }
    const counts = o7.status_counts || [];
    const review = counts.find((s5) => s5.status === "awaiting_review");
    const today = o7.daily && o7.daily.length ? o7.daily[o7.daily.length - 1] : null;
    const boardChips = [
      ["\u8FDB\u884C\u4E2D", o7.in_flight || 0, "var(--st-running)"],
      ["\u5F85\u5BA1\u6279", review ? review.count : 0, "var(--st-review)"],
      ["\u4ECA\u65E5\u5B8C\u6210", today ? today.count : 0, "var(--st-done)"],
      ["\u5B8C\u6210\u7387", fmtPct(o7.success_rate), "var(--st-done)"],
      ["\u5E73\u5747\u8017\u65F6", fmtDur(o7.avg_duration), "var(--fg-muted)"],
      ["\u6D3B\u8DC3\u9879\u76EE", o7.projects || 0, "var(--fg-muted)"]
    ];
    const chips = el.classList.contains("dashboard-stats") ? [boardChips[1], boardChips[0], boardChips[2], boardChips[3]] : boardChips;
    el.innerHTML = chips.map((c5) => `<div class="stat-chip" style="--metric-color:${c5[2]}" aria-label="${c5[0]} ${c5[1]}">
    <span class="sc-dot"></span>
    <b>${c5[1]}</b>
    <span class="sc-label">${c5[0]}</span>
  </div>`).join("");
  }
  function isMobileNav() {
    return window.matchMedia?.("(max-width: 900px)").matches || false;
  }
  function syncSidebarControls() {
    const sb = document.getElementById("sidebar");
    if (!sb) return;
    const mobile = isMobileNav();
    const open = sb.classList.contains("mobile-open");
    const btn = document.getElementById("sbToggle");
    if (btn) {
      const title = mobile ? "\u5173\u95ED\u5BFC\u822A" : sb.classList.contains("collapsed") ? "\u5C55\u5F00\u4FA7\u8FB9\u680F (Ctrl+B)" : "\u6536\u8D77\u4FA7\u8FB9\u680F (Ctrl+B)";
      btn.title = title;
      btn.setAttribute("aria-expanded", mobile ? String(open) : String(!sb.classList.contains("collapsed")));
      btn.setAttribute("aria-label", btn.title);
    }
    const mobileBtn = document.getElementById("mobileNavToggle");
    if (mobileBtn) {
      mobileBtn.setAttribute("aria-expanded", mobile ? String(open) : "false");
      mobileBtn.setAttribute("aria-label", mobile && open ? "\u5173\u95ED\u5BFC\u822A" : "\u6253\u5F00\u5BFC\u822A");
      mobileBtn.title = mobile && open ? "\u5173\u95ED\u5BFC\u822A" : "\u6253\u5F00\u5BFC\u822A";
    }
    const backdrop = document.getElementById("sidebarBackdrop");
    if (backdrop) backdrop.setAttribute("aria-hidden", mobile && open ? "false" : "true");
    document.body.classList.toggle("nav-open", mobile && open);
  }
  function toggleSidebar() {
    const sb = document.getElementById("sidebar");
    if (!sb) return;
    if (isMobileNav()) {
      sb.classList.toggle("mobile-open");
      sb.classList.remove("collapsed");
      syncSidebarControls();
      return;
    }
    const collapsed = sb.classList.toggle("collapsed");
    sb.classList.remove("mobile-open");
    syncSidebarControls();
    try {
      localStorage.setItem("paihuo.sb", collapsed ? "1" : "0");
    } catch (_2) {
    }
  }
  function restoreSidebar() {
    let collapsed = false;
    try {
      collapsed = localStorage.getItem("paihuo.sb") === "1";
    } catch (_2) {
    }
    const sb = document.getElementById("sidebar");
    if (sb) {
      sb.classList.remove("mobile-open");
      if (isMobileNav()) sb.classList.remove("collapsed");
      else if (collapsed) sb.classList.add("collapsed");
      syncSidebarControls();
    }
    const media = window.matchMedia?.("(max-width: 900px)");
    if (media && !media.__paihuoBound) {
      media.__paihuoBound = true;
      media.addEventListener?.("change", () => {
        const current = document.getElementById("sidebar");
        if (!current) return;
        current.classList.remove("mobile-open");
        if (media.matches) current.classList.remove("collapsed");
        else {
          let saved = false;
          try {
            saved = localStorage.getItem("paihuo.sb") === "1";
          } catch (_2) {
          }
          current.classList.toggle("collapsed", saved);
        }
        syncSidebarControls();
      });
    }
  }
  function initShortcuts() {
    const closeActiveModal = (modal) => {
      if (modal?.id === "termModal") closeTerminal();
      else if (modal) closeModal(modal.id);
    };
    document.addEventListener("keydown", (e5) => {
      const t5 = e5.composedPath && e5.composedPath()[0] || e5.target;
      const inField = t5 && (t5.matches("input, textarea, select") || t5.isContentEditable);
      if (t5?.closest?.(".xterm")) return;
      const modal = activeModal();
      if (e5.key === "Tab" && modal) {
        const focusable = [...modal.querySelectorAll("button:not([disabled]), [href], input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((el) => !el.closest(".hidden") && el.getClientRects().length);
        if (focusable.length) {
          const first = focusable[0], last = focusable[focusable.length - 1];
          if (!modal.contains(document.activeElement)) {
            e5.preventDefault();
            (e5.shiftKey ? last : first).focus();
          } else if (e5.shiftKey && document.activeElement === first) {
            e5.preventDefault();
            last.focus();
          } else if (!e5.shiftKey && document.activeElement === last) {
            e5.preventDefault();
            first.focus();
          }
        }
      }
      if (!inField && (e5.ctrlKey || e5.metaKey) && e5.key.toLowerCase() === "b") {
        e5.preventDefault();
        toggleSidebar();
        return;
      }
      if (e5.key === "Escape") {
        const sb = document.getElementById("sidebar");
        if (isMobileNav() && sb?.classList.contains("mobile-open")) {
          sb.classList.remove("mobile-open");
          syncSidebarControls();
          return;
        }
        const modal2 = activeModal();
        closeActiveModal(modal2);
        return;
      }
      if (inField) return;
      if (e5.key === "n" || e5.key === "N") {
        if (location.pathname !== "/board") return;
        const inDetail = !document.getElementById("detailShell")?.classList.contains("hidden");
        if (inDetail) return;
        openNewTask();
      }
      if (e5.key === "/") {
        const s5 = document.querySelector("#pSearch, #aSearch");
        if (s5) {
          e5.preventDefault();
          s5.focus();
        }
      }
    });
    document.addEventListener("click", (e5) => {
      if (e5.target && e5.target.classList && e5.target.classList.contains("modal")) {
        closeActiveModal(e5.target);
      }
    });
    document.addEventListener("click", (e5) => {
      const row = e5.target.closest?.(".dir-row");
      if (row) {
        dirLoad(row.dataset.path);
        return;
      }
      const seg = e5.target.closest?.(".crumb-seg");
      if (seg && !seg.classList.contains("cur")) dirLoad(seg.dataset.p);
    });
    document.querySelector(".sidebar-nav")?.addEventListener("click", (e5) => {
      if (isMobileNav() && e5.target.closest("a")) {
        const sb = document.getElementById("sidebar");
        if (sb) {
          sb.classList.remove("mobile-open");
          syncSidebarControls();
        }
      }
    });
    document.querySelectorAll(".modal").forEach((modal) => modal.setAttribute("aria-hidden", modal.classList.contains("hidden") ? "true" : "false"));
  }
  function route() {
    const h4 = location.hash;
    const path = location.pathname;
    const task = /^#\/issue\/(\d+)/.exec(h4);
    if (task) {
      showDetail(Number(task[1]));
      return;
    }
    if (state.selected !== null || !document.getElementById("detailShell").classList.contains("hidden")) {
      hideDetail();
    }
    if (path === "/projects") {
      const m2 = /^#\/project\/(\d+)/.exec(h4);
      if (m2) showProjectDetail(Number(m2[1]));
      else if (state.projectView !== null) hideProjectDetail();
      return;
    }
    if (path === "/roles") {
      const m2 = /^#\/agent\/(\d+)/.exec(h4);
      if (m2) {
        const id = Number(m2[1]);
        if (state.agentEditing === null || state.agentEditing.id !== id) showAgentDetail(id);
      } else if (state.agentEditing !== null) {
        hideAgentDetail();
      }
      return;
    }
    if (path === "/skills") {
      const m2 = /^#\/skill\/(\d+)/.exec(h4);
      if (m2) showSkillDetail(Number(m2[1]));
      else if (state.skillDetail !== null) hideSkillDetail();
      return;
    }
  }
  function refreshOverviewSoon() {
    clearTimeout(ovTimer);
    ovTimer = setTimeout(refreshOverview, 600);
  }
  function sse() {
    if (state.es) return;
    const es = new EventSource("/api/events");
    state.es = es;
    es.addEventListener("task", (ev) => {
      try {
        const t5 = JSON.parse(ev.data).payload;
        const i6 = state.tasks.findIndex((x2) => x2.id === t5.id);
        if (i6 >= 0) state.tasks[i6] = t5;
        else state.tasks.unshift(t5);
        if (state.termTask === t5.id) syncTerminalInput(t5);
        const path = location.pathname;
        if (path === "/board") {
          state.view === "list" ? renderList() : renderBoard();
          refreshOverviewSoon();
        } else if (path === "/") {
          loadDashboard();
        } else if (path === "/history") {
          loadHistory();
        } else if (path === "/roles") {
          renderAgentList();
          if (state.agentTab === "overview") renderAgentOverview(state.agentEditing);
        } else if (path === "/projects") {
          renderProjectList();
          if (state.projectView) refreshProjectDetail();
        }
        fillSelects();
        if (state.selected === t5.id) refreshDetail();
      } catch (_2) {
      }
    });
    es.addEventListener("log", (ev) => {
      try {
        appendLog(JSON.parse(ev.data).payload);
      } catch (_2) {
      }
    });
    es.addEventListener("session.updated", (ev) => {
      try {
        const d3 = JSON.parse(ev.data).payload;
        window.dispatchEvent(new CustomEvent("ph-session-updated", { detail: d3 }));
      } catch (_2) {
      }
    });
    es.addEventListener("session.message", (ev) => {
      try {
        const d3 = JSON.parse(ev.data).payload;
        window.dispatchEvent(new CustomEvent("ph-session-message", { detail: d3 }));
      } catch (_2) {
      }
    });
    es.addEventListener("provision", (ev) => {
      try {
        const d3 = JSON.parse(ev.data).payload;
        if (provState.instCli && d3.cli === provState.instCli) appendInstLine(d3.line || "");
        if (d3.line && d3.line.includes("[install] \u5B8C\u6210")) {
          setTimeout(loadProvision, 1500);
        }
      } catch (_2) {
      }
    });
    es.addEventListener("error", () => {
      if (!state.es) return;
    });
  }
  var ovTimer;
  var init_main = __esm({
    "internal/web/static/src/main.js"() {
      init_agents();
      init_core();
      init_dashboard();
      init_history();
      init_projects();
      init_provision();
      init_role_studio();
      init_schedules();
      init_settings();
      init_skills();
      init_task();
      init_terminal();
      init_sessions();
      init_task_diff();
      ovTimer = null;
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
          if (state.es) {
            state.es.close();
            state.es = null;
          }
          return;
        }
        if (!state.es) {
          sse();
          loadAll().then(() => {
            const path = location.pathname;
            if (path === "/") loadDashboard();
            else if (path === "/board") {
              renderBoard();
              renderList();
              refreshOverview();
            } else if (path === "/history") loadHistory();
            else if (path === "/roles") renderAgentList();
            else if (path === "/agents") loadProvision();
            else if (path === "/projects") renderProjectList();
            else if (path === "/autopilots") renderScheduleList();
            else if (path === "/skills") loadSkillLib().then(() => {
              renderSkillLib();
              route();
            });
            else if (path === "/settings") loadSettings();
          }).catch(() => {
          });
        }
      });
      window.addEventListener("pagehide", () => {
        if (state.es) {
          state.es.close();
          state.es = null;
        }
      });
      document.addEventListener("DOMContentLoaded", async () => {
        restoreSidebar();
        initShortcuts();
        const schemaP = loadSchema();
        try {
          await loadAll();
        } catch (e5) {
          toast("\u52A0\u8F7D\u5931\u8D25: " + e5.message, true);
        }
        const path = location.pathname;
        if (path === "/") {
          loadDashboard();
          loadTemplates();
        } else if (path === "/board") {
          renderBoard();
          loadTemplates();
          refreshOverview();
        } else if (path === "/history") {
          loadHistory();
        } else if (path === "/roles") {
          let av = "grid";
          try {
            av = localStorage.getItem("paihuo.agentView") || "grid";
          } catch (_2) {
          }
          setAgentView(av === "table" ? "table" : "grid");
          let as = "name-asc";
          try {
            as = localStorage.getItem("paihuo.agentSort") || "name-asc";
          } catch (_2) {
          }
          setAgentSort(as);
        } else if (path === "/agents") {
          loadProvision();
        } else if (path === "/projects") {
          renderProjectList();
        } else if (path === "/autopilots") {
          renderScheduleList();
        } else if (path === "/skills") {
          let sv = "grid";
          try {
            sv = localStorage.getItem("paihuo.skillView") || "grid";
          } catch (_2) {
          }
          setSkillView(sv === "list" ? "list" : "grid");
          setSkillTab("skills");
          await loadSkillLib();
          renderSkillLib();
        } else if (path === "/settings") {
          loadSettings();
        }
        route();
        window.addEventListener("hashchange", route);
        sse();
        await schemaP;
      });
      window.addChip = addChip;
      window.agentTab = agentTab;
      window.allowProjectTaskDrop = allowProjectTaskDrop;
      window.applyFilters = applyFilters;
      window.applyTemplate = applyTemplate;
      window.changeRoleStudioCli = changeRoleStudioCli;
      window.cleanupHistory = cleanupHistory;
      window.clearSkillSelection = clearSkillSelection;
      window.closeAgentDetail = closeAgentDetail;
      window.closeDetail = closeDetail;
      window.closeInstTerminal = closeInstTerminal;
      window.closeModal = closeModal;
      window.closeProjectDetail = closeProjectDetail;
      window.closeSkillDetail = closeSkillDetail;
      window.closeTerminal = closeTerminal;
      window.copyCurrentRole = copyCurrentRole;
      window.copyLogs = copyLogs;
      window.copyRole = copyRole;
      window.copySkillContent = copySkillContent;
      window.copyText = copyText;
      window.createDefaultRole = createDefaultRole;
      window.deleteAgent = deleteAgent;
      window.deleteProject = deleteProject;
      window.deleteSchedule = deleteSchedule;
      window.deleteSelected = deleteSelected;
      window.deleteSelectedSkills = deleteSelectedSkills;
      window.deleteSkill = deleteSkill;
      window.deleteSkillFromDetail = deleteSkillFromDetail;
      window.deleteTask = deleteTask;
      window.deleteTemplate = deleteTemplate;
      window.dropProjectTask = dropProjectTask;
      window.endInteractiveTask = endInteractiveTask;
      window.endProjectTaskDrag = endProjectTaskDrag;
      window.filterSkillOptions = filterSkillOptions;
      window.focusFullscreenTerminal = focusFullscreenTerminal;
      window.focusTaskTerminal = focusTaskTerminal;
      window.gitInitProject = gitInitProject;
      window.installProvision = installProvision;
      window.loadHistory = loadHistory;
      window.logout = logout;
      window.mkdirCurrent = mkdirCurrent;
      window.moveProjectTask = moveProjectTask;
      window.openAgentDetail = openAgentDetail;
      window.openCurrentRoleEditor = openCurrentRoleEditor;
      window.openDirPicker = openDirPicker;
      window.openExtModal = openExtModal;
      window.openNewTask = openNewTask;
      window.openProject = openProject;
      window.openProjectModal = openProjectModal;
      window.openProjectTask = openProjectTask;
      window.openRoleStudio = openRoleStudio;
      window.openScheduleModal = openScheduleModal;
      window.openSkillDetail = openSkillDetail;
      window.openSkillModal = openSkillModal;
      window.openSubTask = openSubTask;
      window.openTask = openTask;
      window.openTerminal = openTerminal;
      window.patchProject = patchProject;
      window.patchTask = patchTask;
      window.pickDir = pickDir;
      window.refreshAgentCatalog = refreshAgentCatalog;
      window.refreshProvision = refreshProvision;
      window.rejectTask = rejectTask;
      window.removeChip = removeChip;
      window.removeExt = removeExt;
      window.renderAgentList = renderAgentList;
      window.renderProjectList = renderProjectList;
      window.renderSkillLib = renderSkillLib;
      window.resumeTask = resumeTask;
      window.roleStudioQuickAsk = roleStudioQuickAsk;
      window.runCleanup = runCleanup;
      window.saveAgentConcurrency = saveAgentConcurrency;
      window.saveAsTemplate = saveAsTemplate;
      window.saveRetention = saveRetention;
      window.saveRoleStudio = saveRoleStudio;
      window.saveSkillTags = saveSkillTags;
      window.saveSkillTagsInline = saveSkillTagsInline;
      window.saveWtRetention = saveWtRetention;
      window.scanSkills = scanSkills;
      window.selectAllNonMergeTasks = selectAllNonMergeTasks;
      window.selectVisibleSkills = selectVisibleSkills;
      window.sendRoleStudioChat = sendRoleStudioChat;
      window.sendRoleStudioTest = sendRoleStudioTest;
      window.setAgentSort = setAgentSort;
      window.setAgentView = setAgentView;
      window.setSkillTab = setSkillTab;
      window.setSkillView = setSkillView;
      window.setTaskStatus = setTaskStatus;
      window.setView = setView;
      window.startProjectTaskDrag = startProjectTaskDrag;
      window.submitExt = submitExt;
      window.submitProject = submitProject;
      window.submitSchedule = submitSchedule;
      window.submitSkill = submitSkill;
      window.submitTask = submitTask;
      window.syncModelThinking = syncModelThinking;
      window.syncScheduleFields = syncScheduleFields;
      window.syncTaskConcurrency = syncTaskConcurrency;
      window.syncTaskDependency = syncTaskDependency;
      window.syncTaskRunMode = syncTaskRunMode;
      window.toggleAgent = toggleAgent;
      window.toggleAll = toggleAll;
      window.toggleAllSkills = toggleAllSkills;
      window.toggleLogFilter = toggleLogFilter;
      window.toggleRow = toggleRow;
      window.toggleSchedule = toggleSchedule;
      window.toggleSidebar = toggleSidebar;
      window.toggleSkill = toggleSkill;
      window.toggleSkillGroup = toggleSkillGroup;
      window.toggleSkillSelection = toggleSkillSelection;
      window.toggleSkillTagsEditor = toggleSkillTagsEditor;
      window.wsDiscard = wsDiscard;
    }
  });
  init_main();
})();
/*! Bundled license information:

@lit/reactive-element/css-tag.js:
  (**
   * @license
   * Copyright 2019 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

@lit/reactive-element/reactive-element.js:
lit-html/lit-html.js:
lit-element/lit-element.js:
lit-html/directive.js:
lit-html/async-directive.js:
  (**
   * @license
   * Copyright 2017 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

lit-html/is-server.js:
  (**
   * @license
   * Copyright 2022 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

lit-html/directive-helpers.js:
lit-html/directives/ref.js:
  (**
   * @license
   * Copyright 2020 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)
*/
