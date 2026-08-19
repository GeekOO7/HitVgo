(() => {
  "use strict";

  const LOCALE_KEY = "vflow-locale";
  const LOCALE_KEY_LEGACY = "wf-locale";
  const SUPPORTED_LOCALES = ["zh", "en"];
  const DEFAULT_LOCALE = "zh";

  /** @type {Record<string, Record<string, string>>} */
  const packs = {};
  /** @type {string|null} */
  let currentLocale = null;
  /** @type {Record<string, string>|null} */
  let dict = null;
  /** @type {Record<string, string>|null} */
  let fallbackDict = null;
  /** @type {object|null} */
  let siteConfig = null;
  const listeners = new Set();

  function readStoredLocale() {
    try {
      let v = localStorage.getItem(LOCALE_KEY);
      if (v == null) {
        v = localStorage.getItem(LOCALE_KEY_LEGACY);
        if (v != null) {
          localStorage.setItem(LOCALE_KEY, v);
          localStorage.removeItem(LOCALE_KEY_LEGACY);
        }
      }
      if (v && SUPPORTED_LOCALES.includes(v)) return v;
    } catch (e) {
      /* ignore */
    }
    return DEFAULT_LOCALE;
  }

  function interpolate(template, vars) {
    if (!vars || typeof template !== "string") return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => {
      if (Object.prototype.hasOwnProperty.call(vars, name)) {
        const val = vars[name];
        return val == null ? "" : String(val);
      }
      return match;
    });
  }

  function t(key, vars) {
    const k = key == null ? "" : String(key);
    if (dict && Object.prototype.hasOwnProperty.call(dict, k)) {
      return interpolate(dict[k], vars);
    }
    if (fallbackDict && Object.prototype.hasOwnProperty.call(fallbackDict, k)) {
      return interpolate(fallbackDict[k], vars);
    }
    return k;
  }

  async function loadPack(lang) {
    if (packs[lang]) return packs[lang];
    const res = await fetch(`/static/locales/${lang}.json`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`Failed to load locale: ${lang}`);
    const data = await res.json();
    packs[lang] = data;
    return data;
  }

  function htmlLangTag(locale) {
    return locale === "en" ? "en" : "zh-CN";
  }

  function applyUiOverrides(locale, baseDict) {
    const out = Object.assign({}, baseDict || {});
    const block = siteConfig && siteConfig[locale];
    const ui = block && block.ui;
    if (!ui) return out;
    if (ui.brandName) out["brand.name"] = String(ui.brandName);
    if (ui.pageTitle) {
      out["page.title"] = String(ui.pageTitle);
      out["app.title"] = String(ui.pageTitle);
    }
    if (ui.authTitle) out["auth.title"] = String(ui.authTitle);
    if (ui.authSubtitleLogin) {
      out["auth.subtitleLogin"] = String(ui.authSubtitleLogin);
    }
    if (ui.authSubtitleRegister) {
      out["auth.subtitleRegister"] = String(ui.authSubtitleRegister);
    }
    return out;
  }

  function ensureMeta(selector, attr, attrValue) {
    let el = document.head.querySelector(selector);
    if (!el) {
      el = document.createElement("meta");
      el.setAttribute(attr, attrValue);
      document.head.appendChild(el);
    }
    return el;
  }

  function applySeoMeta(locale) {
    const block = siteConfig && siteConfig[locale];
    const seo = block && block.seo;
    if (!seo) return;
    if (seo.title) document.title = String(seo.title);
    const desc = ensureMeta('meta[name="description"]', "name", "description");
    if (seo.description != null) desc.setAttribute("content", String(seo.description));
    const keywords = ensureMeta('meta[name="keywords"]', "name", "keywords");
    if (seo.keywords != null) keywords.setAttribute("content", String(seo.keywords));
    const ogTitle = ensureMeta('meta[property="og:title"]', "property", "og:title");
    ogTitle.setAttribute("content", String(seo.ogTitle || seo.title || ""));
    const ogDesc = ensureMeta(
      'meta[property="og:description"]',
      "property",
      "og:description"
    );
    ogDesc.setAttribute(
      "content",
      String(seo.ogDescription || seo.description || "")
    );
    const ogType = ensureMeta('meta[property="og:type"]', "property", "og:type");
    ogType.setAttribute("content", "website");
    const twCard = ensureMeta('meta[name="twitter:card"]', "name", "twitter:card");
    twCard.setAttribute("content", "summary_large_image");
    const twTitle = ensureMeta('meta[name="twitter:title"]', "name", "twitter:title");
    twTitle.setAttribute("content", String(seo.ogTitle || seo.title || ""));
    const twDesc = ensureMeta(
      'meta[name="twitter:description"]',
      "name",
      "twitter:description"
    );
    twDesc.setAttribute(
      "content",
      String(seo.ogDescription || seo.description || "")
    );
    const ogImageUrl = (seo.ogImage || "").trim();
    let ogImage = document.head.querySelector('meta[property="og:image"]');
    let twImage = document.head.querySelector('meta[name="twitter:image"]');
    if (ogImageUrl) {
      if (!ogImage) {
        ogImage = document.createElement("meta");
        ogImage.setAttribute("property", "og:image");
        document.head.appendChild(ogImage);
      }
      ogImage.setAttribute("content", ogImageUrl);
      if (!twImage) {
        twImage = document.createElement("meta");
        twImage.setAttribute("name", "twitter:image");
        document.head.appendChild(twImage);
      }
      twImage.setAttribute("content", ogImageUrl);
    } else {
      if (ogImage) ogImage.remove();
      if (twImage) twImage.remove();
    }
  }

  function rebuildDict() {
    const locale = getLocale();
    const base = packs[locale] || {};
    dict = applyUiOverrides(locale, base);
    if (locale !== "zh") {
      fallbackDict = packs.zh
        ? applyUiOverrides("zh", packs.zh)
        : null;
    } else {
      fallbackDict = null;
    }
  }

  function applyDom(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (key) el.textContent = t(key);
    });
    scope.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const key = el.getAttribute("data-i18n-html");
      if (key) el.innerHTML = t(key);
    });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const key = el.getAttribute("data-i18n-placeholder");
      if (key) el.placeholder = t(key);
    });
    scope.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const key = el.getAttribute("data-i18n-title");
      if (key) el.title = t(key);
    });
    scope.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
      const key = el.getAttribute("data-i18n-aria-label");
      if (key) el.setAttribute("aria-label", t(key));
    });
    document.documentElement.lang = htmlLangTag(getLocale());
    scope.querySelectorAll("[data-brand]").forEach((el) => {
      el.textContent = t("brand.name");
    });
    applySeoMeta(getLocale());
  }

  function getLocale() {
    return currentLocale || DEFAULT_LOCALE;
  }

  function notifyChange() {
    listeners.forEach((fn) => {
      try {
        fn(getLocale());
      } catch (e) {
        console.warn("VflowI18n onChange error", e);
      }
    });
  }

  function setSiteConfig(cfg) {
    siteConfig = cfg && typeof cfg === "object" ? cfg : null;
    if (currentLocale && packs[currentLocale]) {
      rebuildDict();
      applyDom();
    }
  }

  function getSiteConfig() {
    return siteConfig;
  }

  async function setLocale(lang) {
    const next = SUPPORTED_LOCALES.includes(lang) ? lang : DEFAULT_LOCALE;
    if (next === currentLocale && dict) {
      rebuildDict();
      applyDom();
      return;
    }
    if (!packs[next]) await loadPack(next);
    currentLocale = next;
    if (next !== "zh" && !packs.zh) {
      try {
        await loadPack("zh");
      } catch (e) {
        console.warn("VflowI18n zh fallback load failed", e);
      }
    }
    try {
      localStorage.setItem(LOCALE_KEY, next);
    } catch (e) {
      /* ignore */
    }
    rebuildDict();
    applyDom();
    notifyChange();
  }

  function onChange(fn) {
    if (typeof fn !== "function") return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  const initLocale = readStoredLocale();
  const ready = (async () => {
    await setLocale(initLocale);
  })();

  window.VflowI18n = {
    t,
    setLocale,
    getLocale,
    applyDom,
    setSiteConfig,
    getSiteConfig,
    SUPPORTED_LOCALES,
    onChange,
    ready,
  };
})();
